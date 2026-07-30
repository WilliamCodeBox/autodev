// test-hitl.mjs — HITL 干预层集成测试（P0-3 硬阻塞 / P0-7 模式语义 / 裁决/超时）。
// 纯逻辑层，node 直跑：node test-hitl.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initAutodev, loadAutodev, loadSlice, saveSlice, saveAutodev,
  reconcileSliceStage, sliceHasPendingGate, establishMode,
} from '../src/tools/autodev/lib/autodev-state.mjs';
import { hitlRequest, hitlRespond, hitlStatus, hitlConfig } from '../src/tools/autodev/lib/hitl-gates.mjs';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ok  - ${msg}`); }
  else { fail++; console.error(`  FAIL- ${msg}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-hitl-'));
const baseDoc = {
  project: 't',
  mode: 'auto',
  slices: [{
    slice_id: 'S1', stage: 'planning', replan_attempts: 0,
    tasks: [{ id: 'T1', status: 'todo' }],
    acceptance_criteria: [{ id: 'C1', status: 'pending' }],
  }],
  hitl: { enabled: false, pending_gates: [], decisions: [] },
  hotl: { mode: 'autonomous', steers: [], loop_state: 'running' },
};

console.log('# HITL: P0-7 establishMode');
initAutodev(root, JSON.parse(JSON.stringify(baseDoc)), { force: true });
// 物化 slice 文件（真实主循环在 SLICE EXECUTE 阶段会创建；测试需手动建）
for (const sl of baseDoc.slices) saveSlice(root, sl);
let d = loadAutodev(root);
establishMode(d, 'hitl');
saveAutodev(root, d);
d = loadAutodev(root);
assert(d.mode === 'hitl', 'mode=hitl after establishMode(hitl)');
assert(d.hitl.enabled === true, 'hitl.enabled=true (P0-7)');
assert(d.hotl.mode === 'autonomous', 'hotl.mode=autonomous when in hitl mode (P0-7: layers mutually exclusive)');

console.log('# HITL: P0-3 硬阻塞 — pending gate 阻止 reconcile 推进到 done');
const r1 = hitlRequest(root, { sliceId: 'S1', gate: 'plan_approval' });
assert(r1.ok, 'hitlRequest opens plan_approval gate');
d = loadAutodev(root);
assert(sliceHasPendingGate(d, 'S1') === true, 'sliceHasPendingGate true while gate pending');
let s = loadSlice(root, 'S1');
assert(s.awaiting_gate === r1.gate.id, 'slice.awaiting_gate set by hitlRequest');
// 模拟 agent 把 task 做完并跑 check_slice_gate：reconcile 必须被 gate 卡住
s.tasks[0].status = 'done';
s.acceptance_criteria[0].status = 'pass';
const g = reconcileSliceStage(s);
assert(g.blockedByGate === true, 'reconcileSliceStage returns blockedByGate (P0-3)');
assert(s.stage === 'awaiting_human', 'reconcile does NOT promote to done while gate pending');
saveSlice(root, s);

console.log('# HITL: hitlStatus 反映等待态');
const st = hitlStatus(root);
assert(st.waiting === true, 'hitlStatus.waiting=true');
assert(st.pending.length === 1, 'one pending gate reported');

console.log('# HITL: approve 解除硬阻塞，循环可继续');
const r2 = hitlRespond(root, { gateId: r1.gate.id, decision: 'approve' });
assert(r2.ok, 'hitlRespond approve ok');
d = loadAutodev(root);
assert(sliceHasPendingGate(d, 'S1') === false, 'gate cleared after approve');
s = loadSlice(root, 'S1');
assert(s.awaiting_gate === undefined, 'slice.awaiting_gate cleared after approve');
const g2 = reconcileSliceStage(s);
assert(g2.pass === true && s.stage === 'done', 'reconcile promotes to done after gate cleared (P0-3)');

console.log('# HITL: reject 标记 needs_replan');
const r3 = hitlRequest(root, { sliceId: 'S1', gate: 'verify_failure' });
assert(r3.ok, 'hitlRequest opens verify_failure gate');
const r4 = hitlRespond(root, { gateId: r3.gate.id, decision: 'reject' });
d = loadAutodev(root);
assert(r4.needs_replan === true, 'reject sets needs_replan=true');
assert(d.needs_replan === true, 'doc.needs_replan persisted');

console.log('# HITL: final_acceptance 默认关闭，需显式开启（opt-in）');
const rFA0 = hitlRequest(root, { sliceId: 'S1', gate: 'final_acceptance' });
assert(!rFA0.ok, 'final_acceptance rejected while disabled by default');
const cfg = hitlConfig(root, { gates: { final_acceptance: true } });
assert(cfg.ok && cfg.hitl.gates.final_acceptance === true, 'hitlConfig enables final_acceptance');
const rFA = hitlRequest(root, { sliceId: 'S1', gate: 'final_acceptance' });
assert(rFA.ok, 'final_acceptance requestable after enabling');
hitlRespond(root, { gateId: rFA.gate.id, decision: 'approve' });

console.log('# HITL: override 染色人工免检，禁自动 DONE 误判 (P1-4)');
const r5 = hitlRequest(root, { sliceId: 'S1', gate: 'verify_failure' });
const r6 = hitlRespond(root, { gateId: r5.gate.id, decision: 'override' });
d = loadAutodev(root);
assert(d.has_override === true, 'doc.has_override=true after override (染色)');
assert(r6.ok, 'override adjudicated');

console.log('# HITL: advisory 超时自动放行 (P1-1)');
hitlConfig(root, { mode: 'advisory' });
const r7 = hitlRequest(root, { sliceId: 'S1', gate: 'plan_approval' });
// 把 gate 的 timeout 拨到过去
d = loadAutodev(root);
d.hitl.pending_gates[d.hitl.pending_gates.length - 1].timeout_at = new Date(Date.now() - 1000).toISOString();
saveAutodev(root, d);
const st2 = hitlStatus(root);
assert(st2.autoApproved && st2.autoApproved.includes(r7.gate.id), 'advisory auto-approves timed-out gate');

console.log('# HITL: P0-7 残留清除 — establishMode(auto) 清掉上次 hitl 残留');
d = loadAutodev(root);
establishMode(d, 'auto');
saveAutodev(root, d);
d = loadAutodev(root);
assert(d.mode === 'auto' && d.hitl.enabled === false && d.hotl.mode === 'autonomous', 'establishMode(auto) clears hitl residual');

console.log(`\nHITL tests: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
