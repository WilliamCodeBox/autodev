// tworound-gate.ts
// TwoRoundGate 原语：方案设计 & 验收形成共用。
// R1 起草（扇出多隔离 subagent 各自起草门控 -> 父 agent 整合提案）
// R2 对抗审查（扇出多隔离 subagent 找漏洞 -> 父 agent 定稿）
// 强制项（编译/构建/测试）由 buildFinalStandard 在定稿后并入，R2 不可移除。
// 所有 subagent 遵循 §9 双通道契约：重产物写 local://，只回轻量 JSON summary。
import { Type } from '@sinclair/typebox';

export const gateItemSchema = Type.Object({
  id: Type.String(),
  desc: Type.String(),
  verify: Type.String({
    description:
      '可机器执行的验证命令，或 LLM-as-judge 的判定说明；命令由 autodev tool 实际执行，不采信 subagent 自报',
  }),
  kind: Type.Union([Type.Literal('machine'), Type.Literal('llm_judge')], {
    description: 'machine=可自动跑命令判定；llm_judge=由模型按说明判定',
  }),
  status: Type.String({ description: 'pending|pass|fail，初始 pending' }),
});

export const gateProposalSchema = Type.Object({
  items: Type.Array(gateItemSchema),
});

// subagent 双通道返回值 schema（父只消费 summary+ref，细节在 local://）
export const subagentReturnSchema = Type.Object({
  status: Type.Union([Type.Literal('success'), Type.Literal('partial'), Type.Literal('blocked')]),
  ref: Type.String({
    description: 'local://{role}-{slug}.md 或 .omp/autodev/artifacts/... 的 durable 路径',
  }),
  summary: Type.String({ description: '1~3 句结论，足以让父决定下一步' }),
  findings: Type.Array(Type.String(), { description: '关键发现点，带 file:line' }),
  next_action_or_blocker: Type.String(),
});

// R1：起草门控（machine + llm_judge 混合）。seed 来自开发者最初输入 + recon dossier 要点。
export function buildDraftPrompt(opts: {
  goal: string;
  seed: string[];
  context: string;
  mandatoryNote: string;
}): string {
  const seed = opts.seed.length ? opts.seed.map((s) => `- ${s}`).join('\n') : '（无）';
  return `你是质量门控起草员。基于目标与上下文，起草一套**质量门控标准**。
门控分两类：
- machine：可用命令自动判定的（如 cmake --build、ctest、valgrind --leak-check、benchmark 数值比对）
- llm_judge：设计/语义类，由模型按 verify 说明判定

# 目标
${opts.goal}

# 开发者最初提出的门控指标（种子，须纳入）
${seed}

# 上下文（recon dossier / 方案要点）
${opts.context}

# 强制要求
${opts.mandatoryNote}

# 双通道契约（必须遵守）
把你的起草**细节**写到 \`local://gate-R1-draft.md\`，只按 subagentReturnSchema 返回轻量 JSON：
{ "status": "success", "ref": "local://gate-R1-draft.md", "summary": "...", "findings": [...], "next_action_or_blocker": "..." }。
**禁止**在返回值里塞除结构化门控项以外的冗长内容；最终门控项以 gateProposalSchema 的 items 数组给出。

按 gateProposalSchema 返回结构化 JSON（items 为门控项数组）。不必列出强制项（父 agent 会强制并入）。`;
}

// R2：对抗审查，找 loopholes。mandatory/seed 不可移除。
export function buildAdversarialPrompt(proposal: unknown[]): string {
  return `下面是一份门控提案。请作为对抗审查员，找出可被钻空子或遗漏质量风险的地方：
- 哪些重要质量属性**没有门控**？
- 哪些 machine 门控的命令**不足以证明**其声称的属性？
- 哪些 llm_judge 门控的判定说明**太模糊**会被轻易判过？
只输出需要补充/加强的门控项（desc+verify+kind），不要重写整份。
**注意**：提案中的 mandatory（编译/构建/测试）与 developer_seed 项**必须保留，不得建议删除**；
如发现它们缺失，改为"标记缺失"而非删除。

把你的审查细节写到 \`local://gate-R2-review.md\`，按 subagentReturnSchema 只回轻量 JSON。
提案：
${JSON.stringify(proposal, null, 2)}`;
}

// 不变式校验：定稿后的 final_standard 必须包含全部 mandatory 与 seed 项（按 id 比对）。
export function validateGateInvariants(opts: {
  final: { id: string }[];
  mandatory: { id: string }[];
  seed: { id: string }[];
}): { ok: boolean; missingMandatory: string[]; missingSeed: string[] } {
  const ids = new Set(opts.final.map((g) => g.id));
  const missingMandatory = opts.mandatory.filter((m) => !ids.has(m.id)).map((m) => m.id);
  const missingSeed = opts.seed.filter((s) => !ids.has(s.id)).map((s) => s.id);
  return {
    ok: missingMandatory.length === 0 && missingSeed.length === 0,
    missingMandatory,
    missingSeed,
  };
}
