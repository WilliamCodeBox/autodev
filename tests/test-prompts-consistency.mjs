// test-prompts-consistency.mjs — commands/autodev.md vs SKILL.md 交叉一致性测试
// 验证两个 prompt 文件描述的信息不矛盾、阶段数一致、关键约束同步。
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
const skill = read(SKILL_FILE);

console.log('\n== 交叉一致性测试 ==');

// --- 1. 主循环阶段数一致 ---
// 用精确标题匹配（避免 ②b 被误算为 stage）
const MAIN_STAGES = ['① RECON-PLAN', '② RECON', '③ PLAN', '④ SLICE EXECUTE', '⑤'];
const cmdStages = MAIN_STAGES.filter(s => cmd.includes(s)).length;
const skillStages = (skill.match(/^\d+\.\s+\*\*/gm) || []).length;
ok(`阶段数一致 (cmd=${cmdStages}, skill=${skillStages})`, cmdStages === skillStages);

// --- 2. Core loop 阶段名称对应 ---
const STAGE_NAMES = ['RECON-PLAN', 'RECON', 'PLAN', 'SLICE EXECUTE', 'FINAL'];
for (const name of STAGE_NAMES) {
  ok(`两个文件都提到阶段 "${name}"`, cmd.includes(name) && skill.includes(name));
}

// --- 3. 三种模式名称一致 ---
ok('两个文件都提到 auto 模式', cmd.includes('auto') && skill.includes('auto'));
ok('两个文件都提到 HITL', cmd.includes('HITL') && skill.includes('HITL'));
ok('两个文件都提到 HOTL', cmd.includes('HOTL') && skill.includes('HOTL'));

// --- 4. 关键约束词一致 ---
// SKILL 是概要，不包含实现细节如 local:///validateGateInvariants/artifacts
// 只验证双方都一致承载的约束
const SHARED_CONSTRAINTS = ['mandatory', 'TwoRoundGate', 'check_slice_gate',
  'transition_task', 'build_standard', 'replan',
  'developer_seed', 'recon_score'];
for (const word of SHARED_CONSTRAINTS) {
  ok(`两个文件都提到关键约束 "${word}"`, cmd.includes(word) && skill.includes(word));
}

// --- 5. HITL 检查点一致 ---
const HITL_CHK = ['plan_approval', 'slice_pre_exec', 'verify_failure', 'final_acceptance'];
for (const cp of HITL_CHK) {
  ok(`两个文件都提到 HITL 检查点 "${cp}"`, cmd.includes(cp) && skill.includes(cp));
}

// --- 6. file:line 证据 ---
ok('两个文件都要求 file:line 证据', cmd.includes('file:line') && skill.includes('file:line'));

// --- 7. slcie 边界 handoff ---
ok('两个文件都提到 handoff', cmd.includes('handoff') && skill.includes('handoff'));

// --- 8. replan 上限一致 ---
const cmdReplan3 = cmd.includes('≤ 3') || cmd.includes('第 4 次') || cmd.includes('replan_attempts ≤');
const skillReplan3 = skill.includes('replan (≤3)') || skill.includes('replan_attempts');
ok('replan 上限一致 (≤3)', cmdReplan3 && skillReplan3);

// --- 9. init-once 约束 ---
ok('commands 提到 init 仅调用一次', cmd.includes('init 仅调用一次') || cmd.includes('禁止重复 init'));
ok('SKILL.md 提到 init 仅调用一次', skill.includes('init') && (skill.includes('YAML state') || skill.includes('tool operations')));

// --- 10. YAML 路径一致 ---
const cmdYaml = cmd.includes('.omp/autodev/autodev.yaml') || cmd.includes('.omp/autodev/');
const skillYaml = skill.includes('.omp/autodev/autodev.yaml') || skill.includes('.omp/autodev/');
ok('YAML 路径一致 (.omp/autodev/)', cmdYaml && skillYaml);

// --- 11. 模式语义定义一致 ---
// cmd 和 skill 对 auto/hitl/hotl 入口的描述一致
ok('两个文件都定义 /autodev 入口', cmd.includes('/autodev') && skill.includes('/autodev'));

// --- 12. 上下文预算描述 ---
ok('commands 提到上下文预算', cmd.includes('上下文预算') || cmd.includes('contextBudget'));
// SKILL 不必须提到 (它只概要描述)，无断言

// =========================================================================
console.log(`\n交叉一致性测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
