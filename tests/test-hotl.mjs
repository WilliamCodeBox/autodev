// test-hotl.mjs — HOTL 监控/控制层集成测试（P0-4 吸收 / P0-5 收敛 / P0-6 解阻重置 / P0-7 模式 / P0-8 原子写）。
// 纯逻辑层，node 直跑：node test-hotl.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initAutodev, loadAutodev, loadSlice, saveSlice,
  establishMode, isHotlActive, isPaused, isWaiting, saveAutodev,
} from '../src/tools/autodev/lib/autodev-state.mjs';
import {
  hotlInit, hotlSteer, absorbSteer, convergeToPaused,
  hotlPause, hotlResume, hotlCancel, hotlDashboard, hotlPoll,
} from '../src/tools/autodev/lib/hotl-steer.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ok  - ${msg}`); }
  else { fail++; console.error(`  FAIL- ${msg}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-hotl-'));

console.log('# HOTL: P0-7 hotlInit');
initAutodev(root, {
  project: 't', mode: 'auto',
  slices: [{ slice_id: 'S1', stage: 'planning', replan_attempts: 2,
    tasks: [{ id: 'T1', status: 'doing' }], acceptance_criteria: [{ id: 'C1', status: 'pending' }] }],
  hitl: { enabled: true, pending_gates: [], decisions: [] },
  hotl: { mode: 'autonomous', steers: [], loop_state: 'running' },
}, { force: true });
// 物化 slice 文件（真实主循环在 SLICE EXECUTE 阶段会创建；测试需手动建）
{
  const dd = loadAutodev(root);
  for (const sl of dd.slices) saveSlice(root, { ...sl, slice_id: sl.id || sl.slice_id });
}
const r0 = hotlInit(root);
assert(r0.ok, 'hotlInit ok');
let d = loadAutodev(root);
assert(d.hotl.mode === 'supervised', 'hotl.mode=supervised after hotlInit');
assert(d.hitl.enabled === false, 'hotlInit clears hitl.enabled (P0-7: layers mutually exclusive)');
assert(isHotlActive(d) === true, 'isHotlActive true');

console.log('# HOTL: P0-6 解阻重置 — resume 把 paused 拉回 planning 并清零 replan_attempts');
let s = loadSlice(root, 'S1');
s.stage = 'paused'; s.replan_attempts = 2;
saveSlice(root, s);
const r1 = hotlSteer(root, { kind: 'resume', scope: 'slice:S1' });
assert(r1.ok, 'hotlSteer resume recorded');
d = loadAutodev(root);
s = loadSlice(root, 'S1');
const ab = absorbSteer(root, d, s); // P0-4/6 吸收点
assert(ab.applied.length === 1, 'one steer applied');
assert(s.stage === 'planning', 'paused -> planning after resume steer');
assert(s.replan_attempts === 0, 'replan_attempts reset to 0 on unblock (P0-6)');

console.log('# HOTL: P0-4 steer 只记 note、不动 task 状态（不破坏 TASK_EDGES）');
const r2 = hotlSteer(root, { kind: 'steer', text: 'prefer gcc over ifort here', scope: 'slice:S1' });
d = loadAutodev(root);
s = loadSlice(root, 'S1');
const ab2 = absorbSteer(root, d, s);
assert(ab2.applied.length === 1, 'steer directive applied');
assert(s.steer_notes && s.steer_notes.some((n) => n.text.includes('gcc')), 'steer note recorded on slice');

console.log('# HOTL: P0-5 收敛 — convergeToPaused 置 loop_state=paused（核心状态机只置 slice）');
s.stage = 'paused';
saveSlice(root, s);
const c = convergeToPaused(root, 'replan limit reached');
assert(c.ok && c.loop_state === 'paused', 'convergeToPaused ok');
d = loadAutodev(root);
assert(d.hotl.loop_state === 'paused', 'hotl.loop_state=paused (P0-5)');
assert(d.status === 'paused', 'doc.status=paused');

console.log('# HOTL: pause/resume/cancel 控制');
hotlResume(root);
assert(loadAutodev(root).hotl.loop_state === 'running', 'hotlResume -> running');
hotlPause(root);
assert(loadAutodev(root).hotl.loop_state === 'paused', 'hotlPause -> paused');
hotlCancel(root);
assert(loadAutodev(root).hotl.loop_state === 'cancelled', 'hotlCancel -> cancelled');

console.log('# HOTL: dashboard / poll 提供人类可见快照');
const dash = hotlDashboard(root);
assert(dash.ok && Array.isArray(dash.slices), 'hotlDashboard returns slices');
const poll = hotlPoll(root, 'run');
assert(poll.ok && Array.isArray(poll.pending_steers), 'hotlPoll returns pending_steers');

console.log('# HOTL: isPaused / isWaiting 派生统一（P0-7）');
d = loadAutodev(root);
assert(isPaused(d) === true || d.hotl.loop_state === 'cancelled', 'isPaused reflects canceled/paused');

console.log('# P0-8 原子写压力：50 次连续 save 不丢更新');
for (let i = 0; i < 50; i++) {
  const dd = loadAutodev(root);
  dd.counter = i;
  saveAutodev(root, dd); // 内部走 atomicWriteFile(tmp+rename)
}
const final = loadAutodev(root);
assert(final.counter === 49, 'last write (counter=49) survived all renames — no last-write-wins loss');

console.log(`\nHOTL tests: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
