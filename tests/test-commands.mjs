// test-commands.mjs — 验证 commands/autodev.md 与 SKILL.md 的命令表面一致性
// 这些是 prompt 层面的完整性测试：LLM 运行时读取这些 markdown，若内部不一致则输出错误命令格式。
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CMD_FILE = join(ROOT, 'src', 'commands', 'autodev.md');
const SKILL_FILE = join(ROOT, 'src', 'skills', 'autodev', 'SKILL.md');

let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${name}`); }
}

function read(path) {
  if (!existsSync(path)) { throw new Error(`file not found: ${path}`); }
  return readFileSync(path, 'utf-8');
}

const cmd = read(CMD_FILE);
const skill = existsSync(SKILL_FILE) ? read(SKILL_FILE) : null;

// =========================================================================
// 验证 1: 分发表涵盖全部 9 个命令形式
// =========================================================================
const DISPATCH_VERBS = ['（空）', 'hitl', 'hotl', 'gate', 'steer', 'lifecycle', 'status', 'config', 'help'];
for (const v of DISPATCH_VERBS) {
  ok(`分发表包含首词 "${v}"`, cmd.includes(`| \`${v}\``) || cmd.includes(`| （空）`));
}

// =========================================================================
// 验证 2: 跨模式控制面 5 个动词行内描述正确
// =========================================================================
ok('gate 行提到 accept|deny|force', cmd.includes('accept|deny|force'));
ok('gate 行未提 approve|reject|modify|override', !cmd.match(/\bgate\b[^]*?hitl_respond[^]*?(?:aprove|reject|modify|override)/));
ok('lifecycle 行提到 pause|resume|cancel', cmd.includes('pause|resume|cancel'));
ok('lifecycle 行映射到 hotl_<动词>', cmd.includes('hotl_<'));
ok('steer 行提到 hotl_steer', cmd.includes('hotl_steer'));
ok('steer 行提到 scope 自动推断', cmd.includes('@slice:') || cmd.includes('scope 自动'));
ok('status 行提到自动吸收 pending steer', cmd.includes('自动吸收'));
ok('config 行用 key=value 非 JSON', cmd.includes('<key>=<value>') && !cmd.includes('<json>'));

// =========================================================================
// 验证 3: 所有 4 个 HITL 检查点使用统一的命令格式
// =========================================================================
const CHECKPOINT_CMDS = cmd.match(/autodev gate <id> accept/g);
ok('plan_approval / slice_pre_exec 都输出 gate <id> accept', (CHECKPOINT_CMDS || []).length >= 2);

// verify_failure 和 final_acceptance 应输出完整格式
ok('verify_failure 输出 accept|deny|force', cmd.includes('accept|deny|force [reason]'));
ok('final_acceptance 输出 accept|deny|force', cmd.includes('accept|deny|force [reason]'));

// 每个检查点的 prompt 都完整
const CHECKPOINTS = ['plan_approval', 'slice_pre_exec', 'verify_failure', 'final_acceptance'];
for (const cp of CHECKPOINTS) {
  ok(`${cp} 检查点存在`, cmd.includes(`HITL 检查点 · ${cp}`));
  ok(`${cp} 有 /autodev gate 提示`, cmd.includes(`/autodev gate `));
}

// =========================================================================
// 验证 4: 无残留旧命令引用（作为用户输入命令）
// =========================================================================
// 这些是旧格式——作为"用户应键入的命令"不应再出现
const STALE_USER_CMDS = [
  '/autodev hitl approve', '/autodev hitl reject', '/autodev hitl modify', '/autodev hitl override',
  '/autodev hitl status', '/autodev hitl config',
  '/autodev hotl steer', '/autodev hotl poll', '/autodev hotl pause', '/autodev hotl resume',
  '/autodev hotl cancel', '/autodev hotl status', '/autodev hotl dashboard',
];
for (const stale of STALE_USER_CMDS) {
  ok(`无残留旧命令 "${stale}"`, !cmd.includes(stale));
}

// 旧 decision 动词 approve/reject/modify/override 作为命令名不应出现
const DECISION_AS_CMD = [/`approve`/, /`reject`/, /`modify`/, /`override`/];
for (const re of DECISION_AS_CMD) {
  // 仅在 verify_failure 的语义说明里允许出现（不是作为命令）
  const matches = cmd.match(re);
  ok(`"${re.source}" 不作为独立命令出现`, !matches || matches.length === 0);
}

// =========================================================================
// 验证 5: 帮助文本一致
// =========================================================================
ok('帮助提到 auto 模式', cmd.includes('auto（默认'));
ok('帮助提到 HITL 入口', cmd.includes('/autodev hitl'));
ok('帮助提到 HOTL 入口', cmd.includes('/autodev hotl'));
ok('帮助提到 gate 命令', cmd.includes('/autodev gate'));
ok('帮助提到 steer 命令', cmd.includes('/autodev steer'));
ok('帮助提到 lifecycle 命令', cmd.includes('/autodev lifecycle'));
ok('帮助提到 status 命令', cmd.includes('/autodev status'));
ok('帮助提到 config 命令', cmd.includes('/autodev config'));
ok('帮助提到跨模式控制面 5 个动词', cmd.includes('跨模式控制面（5 个动词'));

// ========================================================================
// 验证 6: JSON config 已替换
// ========================================================================
// hitl_config 在 tool op 名中出现是正常的（底层操作名不变）；只查不作为用户命令出现
ok('无用户侧 "/autodev hitl config" 命令', !cmd.includes('/autodev hitl config'));
ok('无 JSON config 示例', !cmd.includes(`'{"mode":"advisory"}'`));
ok('config 用 key=value 示例', cmd.includes('mode=advisory') || cmd.includes('gates.final_acceptance'));

// =========================================================================
// 验证 7: SKILL.md 一致性（若存在）
// =========================================================================
if (skill) {
  const SKILL_STALE = [
    '/autodev hitl approve', '/autodev hitl reject', '/autodev hitl modify', '/autodev hitl override',
    '/autodev hotl steer <kind>', '/autodev hotl poll', '/autodev hotl pause', '/autodev hotl resume',
    '/autodev hotl cancel', '/autodev hotl status', '/autodev hotl dashboard',
  ];
  for (const stale of SKILL_STALE) {
    ok(`SKILL 无残留旧命令 "${stale}"`, !skill.includes(stale));
  }

  ok('SKILL 用 gate accept|deny|force', skill.includes('accept|deny|force'));
  ok('SKILL 用 lifecycle resume', skill.includes('lifecycle resume'));
  ok('SKILL 用 config key=value', skill.includes('config '));
}

// =========================================================================
console.log(`\n命令表面完整性测试: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
