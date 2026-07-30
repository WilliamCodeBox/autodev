// recon-synth.ts
// RECON-PLAN：让 LLM 动态决定侦察维度（不硬编码）。
// 本模块只负责构造 prompt 与结构化输出 schema；真正的扇出由 /autodev 命令驱动
// 复用 oh-my-pi 的 `workflow` 原语（agent()/parallel()）。
// subagent 遵循 §9 双通道契约：重产物写 local://，只回轻量 JSON summary。
import { Type } from '@sinclair/typebox';

// base taxonomy：仅作"候选种子"提示，LLM 可增删改、可加权，非强制。
export const BASE_TAXONOMY = [
  { id: 'code_map', title: '代码库地图', hint: '模块/依赖图、入口、公开 API' },
  { id: 'build_deps', title: '构建与依赖', hint: 'CMake targets、ifort/gfortran flags、三方库、构建不变量' },
  { id: 'impact_surface', title: '改动影响面', hint: '谁依赖被改代码、调用链（blast radius）' },
  { id: 'numerical_risk', title: '数值正确性风险', hint: 'COMMON/equivalence、隐式类型、精度(real/sp)、数组越界、浮点结合性' },
  { id: 'ffi_abi', title: 'FFI / ABI 边界', hint: 'iso_c_binding、COMMON→struct 搬运、C 符号/调用约定稳定（Fortran↔C++ 等跨语言重构特有高风险维度）' },
  { id: 'mpi_boundary', title: 'MPI 通讯边界', hint: 'rank 间数据依赖、ghost cell、reduce 顺序/非确定性' },
  { id: 'precision_repro', title: '精度与可复现性', hint: '不同编译器下浮点结果一致性' },
  { id: 'test_observability', title: '测试与可观测性', hint: '现有覆盖、验证方式、Valgrind/GDB 可调试性、benchmark' },
  { id: 'prior_art', title: '既有实现/先验', hint: '相似实现、论文、内部规范' },
];

export const reconDimensionSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  rationale: Type.String({ description: '为什么这个维度对本任务相关' }),
  weight: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
  suggested_tools: Type.Array(Type.String(), { description: '建议使用的工具，如 grep/read/ctest' }),
  expected_artifact: Type.String({ description: '该维度侦察应产出的结构化产物' }),
  // —— 维度置信度打分（recon 扇出返回后由 recon-score.mjs 回填，见 autodev-design.md §11）——
  confidence: Type.Number({ description: '0~1，recon 后由评分聚合算出', default: 0 }),
  evidence_status: Type.Union([
    Type.Literal('covered'), Type.Literal('partial'),
    Type.Literal('missing'), Type.Literal('contradicted'),
  ], { default: 'missing' }),
  recon_pass: Type.Number({ description: '该维度是第几轮侦察（>=2 触发收敛/升级判据）', default: 1 }),
});

export const reconSynthesisSchema = Type.Object({
  dimensions: Type.Array(reconDimensionSchema),
});

// subagent 双通道返回值 schema（父只消费 summary+ref，细节在 local://）
export const subagentReturnSchema = Type.Object({
  status: Type.Union([Type.Literal('success'), Type.Literal('partial'), Type.Literal('blocked')]),
  ref: Type.String({ description: 'local://{role}-{slug}.md 或 .omp/autodev/artifacts/... 的 durable 路径' }),
  summary: Type.String({ description: '1~3 句结论，足以让父决定下一步' }),
  findings: Type.Array(Type.String(), { description: '关键发现点，带 file:line' }),
  next_action_or_blocker: Type.String(),
});

// R1：扇出 subagent 各自提议维度集
export function buildReconSynthPrompt(goal: string, developerSeed: string[] = []): string {
  const tax = BASE_TAXONOMY.map((t) => `- ${t.id}: ${t.title}（${t.hint}）`).join('\n');
  const seed = developerSeed.length ? developerSeed.map((s) => `- ${s}`).join('\n') : '（无）';
  return `你是一名侦察规划师。给定一个软件工程目标，请决定**本次应当侦察哪些维度**。
维度必须是针对该任务"动态生成"的，不要把下面候选清单原样照搬——可以增删、合并、调权重。

# 目标
${goal}

# 开发者最初关注的门控/风险点（作为种子，须被考虑）
${seed}

# 候选维度种子（仅作提示，非强制）
${tax}

# 要求
1. 输出 3~8 个维度，每个含 id/title/rationale/weight/suggested_tools/expected_artifact。
2. rationale 必须说明"为什么对本任务相关"，而非泛泛而谈。
3. 对 CAE/HPC 重构/改写类任务：numerical_risk / precision_repro 通常应 high；**检测到 MPI 时 mpi_boundary 默认 high**；
   **存在跨语言 FFI（如 Fortran↔C++）时 ffi_abi 默认 high**。prior_art 为可选种子，无相似已有实现时可不采用。

# 双通道契约（必须遵守）
把你的维度分析**细节**写到 \`local://recon-synth.md\`，只按 subagentReturnSchema 返回轻量 JSON；
最终维度集以 reconSynthesisSchema 的 dimensions 数组给出。
按 reconSynthesisSchema 返回结构化 JSON。`;
}

// R2（可选对抗）：剔除不相关/冗余维度
export function buildReconAdversarialPrompt(dimensions: unknown[]): string {
  return `下面是上一步综合出的侦察维度集。请作为对抗审查员，指出：
- 哪些维度与本任务**不相关**或**冗余**（可删除）；
- 哪些维度**缺失**（应补充）；
- 哪些权重明显不当（high 权重的维度不得擅自降级，除非给出强理由）。
只输出修改建议（保留/删除/新增/调权），不要重写整份。

把你的审查细节写到 \`local://recon-adversarial.md\`，按 subagentReturnSchema 只回轻量 JSON。
维度集：
${JSON.stringify(dimensions, null, 2)}`;
}

// 低置信维度对抗裁剪（recon 打分后的质量门）：对每个低于阈值的维度判定 keep/prune/escalate。
// 复用 R2 对抗范式，但目标是"侦察够不够"，而非"维度清单合不合理"。
export function buildReconConfidenceAdversarialPrompt(lowDims: unknown[], subResults: Record<string, unknown> = {}): string {
  return `下面是 RECON 维度置信度打分后**低于阈值**的维度及其 recon 返回。请作为对抗审查员，对每个维度判定：
- **keep**：保留并进入再侦察一轮（recon_pass+1），指出还缺哪些 file:line 证据；
- **prune**：与本任务实际无关，给出强理由删除（不得删除 mandatory / developer_seed 对应的种子维度）；
- **escalate**：是真正高风险盲区且 recon 探不动，应升级人工 / PAUSED（对应 autodev 的 blocked 升级上限）。
只输出逐维度的 keep/prune/escalate 决策 + 理由，不要重写整份。

把你的审查细节写到 \`local://recon-confidence-adversarial.md\`，按 subagentReturnSchema 只回轻量 JSON。

低置信维度（已带 confidence / evidence_status / recon_pass）：
${JSON.stringify(lowDims, null, 2)}

对应 recon 返回：
${JSON.stringify(subResults, null, 2)}`;
}
