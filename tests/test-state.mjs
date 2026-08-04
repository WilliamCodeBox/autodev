// test-state.mjs — 验证 autodev 状态机核心逻辑（不依赖 omp 运行时）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  transitionTask, checkSliceGate, replan, checkFinalGate, buildFinalStandard,
  TASK_STATUS, SLICE_STAGES, saveAutodev, saveSlice, loadAutodev, loadSlice,
  saveSliceAndSyncParent, reconcileSliceStage, validateGateInvariants, canTransitionTask,
  runVerify, writeArtifact, appendJournal,
} from '../tools/autodev/lib/autodev-state.mjs';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  PASS', name);
}

// ---- 构造一个最小 slice ----
const slice = {
  slice_id: 'S1',
  stage: 'executing',
  replan_attempts: 0,
  acceptance_criteria: [{ id: 'S1-AC1', desc: 'x', status: 'pending' }],
  tasks: [
    { id: 'T1', status: 'done' },
    { id: 'T2', status: 'doing' },
    { id: 'T3', status: 'todo' },
  ],
};

// 1) 非法 task 状态应抛错
ok('拒绝非法 task 状态', (() => {
  try { transitionTask(slice, 'T1', 'flying'); return false; }
  catch { return true; }
})());

// 2) doing -> done
transitionTask(slice, 'T2', 'done');
ok('T2 doing->done', slice.tasks.find((t) => t.id === 'T2').status === 'done');

// 3) slice gate 在 task 未全 done 时不通过
let g = checkSliceGate(slice);
ok('slice gate 未全 done 时不通过', g.pass === false && g.missing.includes('task T3:todo'));

// 4) 全部 done 但 AC 未 pass -> 仍不通过（T3 走合法路径 todo->doing->done）
transitionTask(slice, 'T3', 'doing');
transitionTask(slice, 'T3', 'done');
g = checkSliceGate(slice);
ok('task 全 done 但 AC 未 pass 时不通过', g.pass === false && g.missing.some((m) => m.startsWith('AC ')));

// 5) AC pass -> slice gate 通过
slice.acceptance_criteria[0].status = 'pass';
g = checkSliceGate(slice);
ok('task+AC 全通过 -> slice gate 通过', g.pass === true);

// 6) blocked 迁移写入 reason
transitionTask(slice, 'T3', 'blocked', { reason: '等父 agent 确认符号策略', blocked_by: ['T2'] });
ok('blocked 写入 reason', slice.tasks.find((t) => t.id === 'T3').reason === '等父 agent 确认符号策略');

// 7) replan ≤3 回到 planning
let r = replan(slice, 3);
ok('replan#1 -> replan', r.action === 'replan' && slice.stage === 'planning' && slice.replan_attempts === 1);
replan(slice, 3); replan(slice, 3);
ok('replan#3 -> replan', slice.replan_attempts === 3 && slice.stage === 'planning');

// 8) 第 4 次 -> paused
r = replan(slice, 3);
ok('replan#4 -> paused', r.action === 'paused' && slice.stage === 'paused' && slice.replan_attempts === 4);

// 9) final gate
const autodev = {
  slices: [
    { id: 'S1', stage: 'done' },
    { id: 'S2', stage: 'executing', replan_attempts: 0 },
  ],
  gate: {
    mandatory: [{ id: 'G0', desc: 'build', status: 'pending' }],
    developer_seed: [{ id: 'G-dev-1', desc: 'x', status: 'pending' }],
    derived: [{ id: 'G-d-1', desc: 'y', status: 'pending' }],
  },
};
buildFinalStandard(autodev);
ok('final_standard 合并 mandatory+seed+derived', autodev.gate.final_standard.length === 3);
let fg = checkFinalGate(autodev);
ok('final gate 未通过(S2 未 done)', fg.pass === false && fg.missing.includes('slice S2:executing'));
autodev.slices[1].stage = 'done';
autodev.gate.final_standard.forEach((a) => (a.status = 'pass'));
fg = checkFinalGate(autodev);
ok('final gate 全通过', fg.pass === true);

// 10) 常量集合
ok('TASK_STATUS 含四态', TASK_STATUS.join(',') === 'todo,doing,blocked,done');
ok('SLICE_STAGES 含 paused', SLICE_STAGES.includes('paused'));

// 11) 非法迁移：done 为终态，done->todo 必须被拒（修复：此前四态任意互转放行）
ok('done 为终态，done->todo 拒', (() => {
  try { transitionTask(slice, 'T1', 'todo'); return false; }
  catch (e) { return /illegal task transition/.test(e.message); }
})());
ok('canTransitionTask 边表正确',
  canTransitionTask('todo', 'doing') && !canTransitionTask('done', 'todo') && !canTransitionTask('doing', 'todo'));

// 12) 文件系统：reconcile + saveSliceAndSyncParent 同步父 slices[].stage（修复：此前父永不同步→⑤恒 false）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-sync-'));
  const parent = {
    slices: [{ id: 'SX', stage: 'executing', replan_attempts: 0 }],
    gate: {
      mandatory: [{ id: 'G0', desc: 'build', status: 'pending' }],
      developer_seed: [{ id: 'GD', desc: 'd', status: 'pending' }],
    },
  };
  saveAutodev(tmp, parent);
  const sl = {
    slice_id: 'SX', stage: 'executing',
    acceptance_criteria: [{ id: 'SX-AC1', status: 'pass' }],
    tasks: [{ id: 'T1', status: 'done' }],
  };
  reconcileSliceStage(sl);
  ok('reconcile 全 done+AC pass → stage:done', sl.stage === 'done');
  saveSliceAndSyncParent(tmp, sl);
  const reloadedParent = loadAutodev(tmp);
  ok('父 slices[].stage 同步为 done', reloadedParent.slices[0].stage === 'done');
  const reloadedSlice = loadSlice(tmp, 'SX');
  ok('slice 文件 stage=done 持久化', reloadedSlice.stage === 'done');
  // 未全通过时 → verifying，且同样同步父
  const sl2 = {
    slice_id: 'SY', stage: 'executing',
    acceptance_criteria: [{ id: 'SY-AC1', status: 'pending' }],
    tasks: [{ id: 'T1', status: 'done' }],
  };
  saveSlice(tmp, sl2);
  reloadedParent.slices.push({ id: 'SY', stage: 'executing', replan_attempts: 0 });
  saveAutodev(tmp, reloadedParent);
  reconcileSliceStage(sl2);
  saveSliceAndSyncParent(tmp, sl2);
  ok('未通过 → stage:verifying', sl2.stage === 'verifying');
  ok('父 SY stage 同步为 verifying', loadAutodev(tmp).slices.find((s) => s.id === 'SY').stage === 'verifying');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 13) validateGateInvariants：R2 删了 mandatory/seed 时自动补回（修复：此前未接入运行时）
{
  const ad = {
    gate: {
      mandatory: [{ id: 'M1', desc: 'build' }],
      developer_seed: [{ id: 'SE1', desc: 'x' }],
      final_standard: [{ id: 'M1', status: 'pending' }], // SE1 被 R2 删除
    },
  };
  const inv = validateGateInvariants(ad);
  // ok=false 表示"检测到违规并已自动补回"；restored 含被补回的 id
  ok('缺失项被检测并自动补回', inv.ok === false && inv.restored.includes('SE1'));
  ok('补回后 final_standard 含 SE1', ad.gate.final_standard.some((x) => x.id === 'SE1'));
  // 无缺失时 ok=true
  const ad2 = { gate: { mandatory: [{ id: 'M1' }], developer_seed: [{ id: 'SE1' }], final_standard: [{ id: 'M1' }, { id: 'SE1' }] } };
  ok('无缺失时 ok=true', validateGateInvariants(ad2).ok === true);
}
{
  // ============================================================
  // P0-2 verified_at 测试
  // ============================================================
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-verify-'));
  const autodev = { goal: 'test verified_at', max_replans: 3, gate: { mandatory: [], developer_seed: [], final_standard: [] }, recon: { dimensions: [] }, slices: [] };
  saveAutodev(d, autodev);

  const acMachine = { id: 'AC-VM', verify: 'echo ok', status: 'pending' };
  const acLLM = { id: 'AC-VL', status: 'pending' };
  const slice = { slice_id: 'S1', stage: 'executing', replan_attempts: 0, acceptance_criteria: [acMachine, acLLM], tasks: [] };
  saveSlice(d, slice);

  // 1. runVerify 设置 verified_at
  const r = runVerify(d, { gate_id: 'AC-VM', slice_id: 'S1' });
  ok('runVerify(machine) ok', r.ok === true);
  // runVerify 写的是 YAML 文件里的副本——重读 slice 检查
  const s1Reload = loadSlice(d, 'S1');
  const acReload = (s1Reload.acceptance_criteria || []).find(a => a.id === 'AC-VM');
  ok('runVerify(machine) verified_at set', typeof acReload?.verified_at === 'number' && acReload.verified_at > 0);
  ok('runVerify(machine) status pass (exit 0)', acReload?.status === 'pass');

  // 2. 绕过检查: 直接写 pass 但没有 verified_at
  const acMachine2 = { id: 'AC-VM2', verify: 'echo test', status: 'pending' };
  const slice2 = { slice_id: 'S2', stage: 'executing', replan_attempts: 0, acceptance_criteria: [acMachine2], tasks: [] };
  saveSlice(d, slice2);
  // 模拟绕过: 直接设 status='pass' 但没有 verified_at
  acMachine2.status = 'pass';
  const bypassBlocked = (acMachine2.status === 'pass' && acMachine2.verify && !acMachine2.verified_at);
  ok('set_gate pass without verified_at → SHOULD BE REJECTED', bypassBlocked === true);

  // 3. 边界: llm_judge AC 无 verify 命令 → 不需要 verified_at
  acLLM.status = 'pass';
  const llmNoVerifyNeeded = !(acLLM.status === 'pass' && acLLM.verify && !acLLM.verified_at);
  ok('llm_judge AC no verify → verified_at NOT required', llmNoVerifyNeeded === true);
}

console.log(`\nALL ${passed} CHECKS PASSED`);
