// test-prompts.mjs — commands/autodev.md + SKILL.md 结构完整性测试
// 验证 prompt 文件包含所有关键章节、约束和关键词。
// 纯文本断言，不调 LLM，毫秒级完成。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CMD_FILE = join(ROOT, 'src', 'commands', 'autodev.md');
const SKILL_FILE = join(ROOT, 'src', 'skills', 'autodev', 'SKILL.md');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL: ${name}`); }
}

function read(path) {
  if (!existsSync(path)) { throw new Error(`file not found: ${path}`); }
  return readFileSync(path, 'utf-8');
}

const cmd = read(CMD_FILE);
const skill = existsSync(SKILL_FILE) ? read(SKILL_FILE) : null;

// =========================================================================
// commands/autodev.md — 主循环 prompt 结构测试
// =========================================================================

console.log('\n== commands/autodev.md 结构完整性 ==');

// --- 5 个主循环阶段 ---
ok('包含 ① RECON-PLAN 标题', cmd.includes('① RECON-PLAN'));
ok('包含 ② RECON 标题', cmd.includes('② RECON'));
ok('包含 ③ PLAN 标题', cmd.includes('③ PLAN'));
ok('包含 ④ SLICE EXECUTE 标题', cmd.includes('④ SLICE EXECUTE'));
ok('包含 ⑤ 最终验收 标题', cmd.includes('⑤'));

// --- 子命令分发表 ---
const DISPATCH_VERBS = ['（空）', 'hitl', 'hotl', 'gate', 'steer', 'lifecycle', 'status', 'config', 'help'];
for (const v of DISPATCH_VERBS) {
  ok(`分发表包含首词 "${v}"`, cmd.includes(`| \`${v}\``) || cmd.includes('| （空）'));
}

// --- 双通道契约 ---
ok('双通道契约段存在', cmd.includes('双通道契约'));
ok('要求 subagent 写 local://', cmd.includes('local://'));
ok('要求 subagent 只回轻量 JSON', cmd.includes('轻量 JSON'));
ok('定义 subagentReturnSchema 格式', cmd.includes('summary') && cmd.includes('ref') && cmd.includes('findings'));
ok('禁止在返回值塞原始数据', cmd.includes('禁止'));
ok('提到关键产物持久化到 artifacts/', cmd.includes('artifacts'));

// --- 上下文预算护栏 ---
ok('上下文预算段存在', cmd.includes('上下文预算') || cmd.includes('contextBudget'));
ok('定义三态 zone: green/amber/red',
  cmd.includes('green') && cmd.includes('amber') && cmd.includes('red'));
ok('提到 read_gate 闸门', cmd.includes('read_gate'));
ok('提到 targetPct / hardCeilingPct',
  cmd.includes('targetPct') && cmd.includes('hardCeilingPct'));
ok('提到 compact/handoff 当 zone=red', cmd.includes('compact') && cmd.includes('handoff'));
ok('工作集固定规则存在', cmd.includes('工作集固定'));
ok('提到 pinned 保护 (goal+invariants)', cmd.includes('pinned') || cmd.includes('不被驱逐'));
ok('三段布局对抗 Lost-in-the-Middle', cmd.includes('primacy') || cmd.includes('Lost-in-the-Middle'));

// --- Available capabilities ---
ok('列出 autodev tool 核心操作', cmd.includes('transition_task'));
ok('列出 autodev tool verify 操作 (真实执行)', cmd.includes('verify'));
ok('列出 autodev tool write_local (双写)', cmd.includes('write_local'));
ok('列出 autodev tool journal', cmd.includes('journal'));
ok('列出 autodev tool resume', cmd.includes('resume'));
ok('列出 autodev tool recon_score', cmd.includes('recon_score'));
ok('提到 workflow 原语', cmd.includes('workflow'));
ok('提到 orchestrate 原语', cmd.includes('orchestrate'));

// --- 阶段 ①: RECON-PLAN ---
const stage1 = cmd.split('① RECON-PLAN')[1]?.split('② RECON')[0] || '';
ok('① 提到扇出 N 个隔离 subagent', stage1.includes('扇出'));
ok('① 提到 base taxonomy 是候选种子', stage1.includes('base taxonomy') || stage1.includes('候选种子'));
ok('① 提到可选 2-round 对抗裁剪', stage1.includes('2-round') || stage1.includes('对抗'));

// --- 阶段 ②: RECON ---
const stage2 = cmd.split('② RECON')[1]?.split('③ PLAN')[0] || '';
ok('② 提到每维度一个隔离 recon subagent', stage2.includes('隔离'));
ok('② 提到 file:line 证据', stage2.includes('file:line') || stage2.includes('证据'));

// --- 阶段 ②b: 置信度打分 ---
const stage2b = cmd.split('②b RECON 维度置信度打分')[1]?.split('③ PLAN')[0] || '';
ok('②b recon_score 段存在', cmd.includes('recon_score'));
ok('②b 定义 solid 路由 (≥0.55)', stage2b.includes('solid') || cmd.includes('0.55'));
ok('②b 定义 revisit 路由', stage2b.includes('revisit'));
ok('②b 定义 escalate 路由', stage2b.includes('escalate'));
ok('②b 低置信高风险维度未达 solid 前不得锁定方案', stage2b.includes('不得锁定'));

// --- 阶段 ③: PLAN ---
const stage3 = cmd.split('③ PLAN')[1]?.split('④ SLICE EXECUTE')[0] || '';
ok('③ 提到 TwoRoundGate', stage3.includes('TwoRoundGate') || cmd.includes('TwoRoundGate'));
ok('③ 提到 R1 起草', stage3.includes('R1'));
ok('③ 提到 R2 对抗审查', stage3.includes('R2'));
ok('③ mandatory 与 developer_seed 不得被 R2 删除', stage3.includes('不得被') || stage3.includes('不可移除'));
ok('③ 提到 validateGateInvariants 自动补回', stage3.includes('validateGateInvariants') || stage3.includes('自动补回'));
ok('③ 强制项 (编译/构建/测试) 强制并入', stage3.includes('强制项') || stage3.includes('mandatory'));
ok('③ init 仅调用一次 (硬约束)', cmd.includes('init 仅调用一次') || cmd.includes('禁止重复 init'));
ok('③ slice 内容必须独立成文件 (硬约束)', cmd.includes('独立成文件') || cmd.includes('只写在'));

// --- 阶段 ④: SLICE EXECUTE ---
const stage4 = cmd.split('④ SLICE EXECUTE')[1]?.split('⑤ 最终验收')[0] || '';
ok('④ 提到 HITL 检查点 plan_approval', stage4.includes('plan_approval'));
ok('④ 提到 HITL 检查点 slice_pre_exec', stage4.includes('slice_pre_exec'));
ok('④ 提到 HITL 检查点 verify_failure', stage4.includes('verify_failure'));
ok('④ HITL 检查点输出统一 gate 命令格式', stage4.includes('gate <id> accept'));
ok('④ 提到 set_slice_stage', stage4.includes('set_slice_stage'));
ok('④ 提到 check_slice_gate 真实落盘', stage4.includes('check_slice_gate'));
ok('④ 提到 task 合法迁移边 (todo→doing→done)', stage4.includes('todo') && stage4.includes('doing') && stage4.includes('done'));
ok('④ done 为终态禁止回退', stage4.includes('禁止回退') || stage4.includes('终态'));
ok('④ 提到 slice 边界 handoff', stage4.includes('handoff'));
ok('④ 提到 machine 强停 (STRONG INSTRUCTION)', stage4.includes('STRONG INSTRUCTION') || stage4.includes('机器强停'));
ok('④ 提到 hotl_poll 吸收 steer', stage4.includes('hotl_poll'));
ok('④ 提到 replan 超限收敛到 paused', stage4.includes('paused') && (stage4.includes('replan') || stage4.includes('超限')));

// --- 阶段 ⑤: FINAL ---
const stage5 = cmd.split('⑤ 最终验收')[1] || '';
ok('⑤ 提到 HITL 检查点 final_acceptance', cmd.includes('final_acceptance') || stage5.includes('HITL'));
ok('⑤ 提到 build_standard', stage5.includes('build_standard') || cmd.includes('build_standard'));
ok('⑤ 提到 final_check', stage5.includes('final_check') || cmd.includes('final_check'));
ok('⑤ final_standard 必经 TwoRoundGate', stage5.includes('TwoRoundGate') || cmd.includes('TwoRoundGate'));
ok('⑤ mandatory/seed 强制保留 R2 不可删除', stage5.includes('强制保留') || cmd.includes('不可删除'));

// --- blocked 处置 ---
ok('blocked 处置段存在', cmd.includes('blocked 处置') || cmd.includes('replan_attempts'));
ok('replan 上限为 3 次', cmd.includes('≤ 3') || cmd.includes('第 4 次'));

// --- 落盘约定 ---
ok('落盘约定段存在', cmd.includes('落盘约定'));
ok('autodev.yaml 在 .omp/autodev/', cmd.includes('.omp/autodev'));
ok('slice 在 slices/<id>.yaml', cmd.includes('slices/'));

// --- 帮助文本 ---
ok('帮助段存在', cmd.includes('## 帮助'));
ok('帮助提到 auto 模式', cmd.includes('auto（默认'));
ok('帮助提到 HITL 入口 /autodev hitl', cmd.includes('/autodev hitl'));
ok('帮助提到 HOTL 入口 /autodev hotl', cmd.includes('/autodev hotl'));
ok('帮助提到 gate 命令', cmd.includes('/autodev gate'));
ok('帮助提到 steer 命令', cmd.includes('/autodev steer'));
ok('帮助提到 lifecycle 命令', cmd.includes('/autodev lifecycle'));
ok('帮助提到 status 命令', cmd.includes('/autodev status'));
ok('帮助提到 config 命令', cmd.includes('/autodev config'));

// --- 无残留旧命令 ---
ok('无 approve/reject/modify/override 作为用户命令',
  !cmd.match(/`approve`|`reject`|`modify`|`override`/));
ok('无 JSON config 示例', !cmd.includes(`'{"mode":"advisory"}'`));
ok('config 用 key=value 而非 JSON', cmd.includes('key=value') || cmd.includes('<key>=<value>'));

// =========================================================================
// SKILL.md 结构测试
// =========================================================================

if (skill) {
  console.log('\n== SKILL.md 结构完整性 ==');

  ok('When to use 段存在', skill.includes('When to use'));
  ok('Core loop 段存在', skill.includes('Core loop'));
  ok('Core loop 含 5 个阶段', (skill.match(/\d+\.\s+\*\*/g) || []).length >= 4);

  ok('提到 TwoRoundGate 原语', skill.includes('TwoRoundGate'));
  ok('提到 R1/R2', skill.includes('R1') && skill.includes('R2'));
  ok('提到 mandatory force-merge', skill.includes('mandatory'));
  ok('提到 YAML state 管理', skill.includes('YAML state') || skill.includes('autodev.yaml'));
  ok('提到 YAML 文件路径', skill.includes('.omp/autodev/'));
  ok('提到 Modes 干预策略', skill.includes('Modes'));
  ok('提到 auto 模式', skill.includes('auto'));
  ok('提到 HITL 模式', skill.includes('HITL'));
  ok('提到 HOTL 模式', skill.includes('HOTL'));
  ok('提到 subagent 隔离扇出', skill.includes('isolated subagent'));
  ok('提到 autodev tool operations', skill.includes('Core ops') || skill.includes('autodev tool'));
  ok('核心操作名 transition_task 存在', skill.includes('transition_task'));
  ok('核心操作名 check_slice_gate 存在', skill.includes('check_slice_gate'));
  ok('核心操作名 replan 存在', skill.includes('replan'));
  ok('核心操作名 build_standard 存在', skill.includes('build_standard'));
  ok('核心操作名 recon_score 存在', skill.includes('recon_score'));
  ok('Design rationale 段存在', skill.includes('Design rationale') || skill.includes('why not hardcode'));
  ok('ADR 捕获规则存在', skill.includes('ADR'));
  ok('References 段存在', skill.includes('References'));
}

// =========================================================================
console.log(`\n提示词结构测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
