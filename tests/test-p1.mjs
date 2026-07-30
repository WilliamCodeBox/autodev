// test-p1.mjs — P1 项回归测试（P1-1 ~ P1-12）。
// 纯逻辑层用真实 lib；op 层用 node --experimental-strip-types 加载真实 index.ts（mock pi）。
// 运行：node test-p1.mjs   （op 部分需上层用 strip-types 调，见底部 import）
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = fs.mkdtempSync(path.join(tmpdir(), 'autodev-p1-'));
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', name); } }

import {
  initAutodev, loadAutodev, saveAutodev, loadSlice, saveSlice, saveSliceAndSyncParent, establishMode, isHotlActive,
} from '../src/tools/autodev/lib/autodev-state.mjs';
import {
  hitlRequest, hitlRespond, hitlConfig, applyTimeoutPolicy, classifyMachineGate,
} from '../src/tools/autodev/lib/hitl-gates.mjs';
import {
  hotlInit, hotlSteer, hotlPause, absorbSteer, hotlDashboard, detectSteerConflicts,
} from '../src/tools/autodev/lib/hotl-steer.mjs';

const baseDoc = {
  project: 'p1-test', mode: 'auto', status: 'running', max_replans: 3,
  slices: [
    { id: 'S1', title: 's1', stage: 'planning', depends_on: [], replan_attempts: 0,
      tasks: [
        { id: 'T1', status: 'done' },
        { id: 'T2', status: 'todo' },
      ],
      acceptance_criteria: [
        { id: 'a1', status: 'pass' },
        { id: 'a2', status: 'pending' },
      ] },
    { id: 'S2', title: 's2', stage: 'planning', depends_on: ['S1'], replan_attempts: 0,
      tasks: [{ id: 'T3', status: 'todo' }], acceptance_criteria: [{ id: 'b1', status: 'pending' }] },
  ],
  gate: { mandatory: [], developer_seed: [], final_standard: [] },
  recon: { dimensions: [] },
};

function initBase() {
  initAutodev(ROOT, JSON.parse(JSON.stringify(baseDoc)), { force: true });
}
// 物化 slice 文件（真实主循环会建）
function sliceFile(id) {
  const d = loadAutodev(ROOT);
  const meta = d.slices.find((m) => m.id === id);
  return { slice_id: id, stage: meta.stage, replan_attempts: 0, tasks: meta.tasks, acceptance_criteria: meta.acceptance_criteria };
}
function materialize() {
  for (const m of loadAutodev(ROOT).slices) {
    const f = sliceFile(m.id); f.slice_id = m.id; saveSlice(ROOT, f);
  }
}

console.log('# P1-3 classifyMachineGate (lib)');
{
  const c1 = classifyMachineGate({ kind: 'machine', retry: 2, exitCode: 1 });
  ok('machine+retry>=2+exit!=0 -> critical', c1.critical === true);
  const c2 = classifyMachineGate({ kind: 'machine', retry: 1, exitCode: 1 });
  ok('retry<2 -> non-critical', c2.critical === false);
  const c3 = classifyMachineGate({ kind: 'llm_judge', retry: 5, exitCode: 1 });
  ok('non-machine -> non-critical', c3.critical === false);
}

console.log('# P1-1 strict 超时逃生 + P1-2 高敏禁自动放行');
{
  initBase(); materialize();
  const dop = establishMode(loadAutodev(ROOT), 'hitl'); saveAutodev(ROOT, dop);
  // P1-1：strict 模式下超时超 max_wait → 升级
  let d = loadAutodev(ROOT);
  d.hitl.max_wait_sec = 0.0001; saveAutodev(ROOT, d);
  const r = hitlRequest(ROOT, { sliceId: 'S1', gate: 'plan_approval' });
  d = loadAutodev(ROOT);
  const gate = d.hitl.pending_gates[0];
  gate.timeout_at = new Date(Date.now() - 10000).toISOString(); // 已超时
  saveAutodev(ROOT, d);
  const pol = applyTimeoutPolicy(ROOT, loadAutodev(ROOT));
  ok('P1-1 escalated on max_wait exceeded', pol.escalated.includes(gate.id));
  ok('P1-1 doc.status -> paused (escape)', loadAutodev(ROOT).status === 'paused');

  // P1-2：advisory 模式下高敏门超时也不自动放行
  initBase(); materialize();
  const dop2 = establishMode(loadAutodev(ROOT), 'hitl'); saveAutodev(ROOT, dop2);
  hitlConfig(ROOT, { mode: 'advisory' });
  const r2 = hitlRequest(ROOT, { sliceId: 'S1', gate: 'plan_approval', sensitivity: 'numerical_risk' });
  d = loadAutodev(ROOT);
  d.hitl.pending_gates[0].timeout_at = new Date(Date.now() - 10000).toISOString();
  saveAutodev(ROOT, d);
  const pol2 = applyTimeoutPolicy(ROOT, loadAutodev(ROOT));
  ok('P1-2 high-sensitivity NOT auto-approved under advisory', pol2.autoApproved.length === 0);
  ok('P1-2 gate still pending', loadAutodev(ROOT).hitl.pending_gates[0].resolved === false);
}

console.log('# P1-4 override 禁自动 DONE（slice + final）');
{
  initBase(); materialize();
  const dop = establishMode(loadAutodev(ROOT), 'hitl'); saveAutodev(ROOT, dop);
  // 把 S1 做成全 done + 全 pass，并开一个 slice gate 再 override
  let s = loadSlice(ROOT, 'S1');
  s.tasks.forEach((t) => { t.status = 'done'; });
  s.acceptance_criteria.forEach((a) => { a.status = 'pass'; });
  saveSlice(ROOT, s);
  const rg = hitlRequest(ROOT, { sliceId: 'S1', gate: 'slice_pre_exec' });
  const rr = hitlRespond(ROOT, { gateId: rg.gate.id, decision: 'override' });
  s = loadSlice(ROOT, 'S1');
  ok('P1-4 slice.override_no_auto_done set', s.override_no_auto_done === true);
  const rec = (await import('./autodev-state.mjs')).reconcileSliceStage(s);
  ok('P1-4 reconcile returns overridden (no auto done)', rec.overridden === true && rec.blockedByOverride === true);
  ok('P1-4 stage NOT promoted to done', s.stage !== 'done');
  // final override（final scope 用默认启用的 plan_approval，避免 final_acceptance 需 opt-in）
  let d = loadAutodev(ROOT);
  d.gate.final_standard = [{ id: 'f1', kind: 'machine', status: 'pass' }];
  const rgf = hitlRequest(ROOT, { gate: 'plan_approval' });
  hitlRespond(ROOT, { gateId: rgf.gate.id, decision: 'override' });
  d = loadAutodev(ROOT);
  ok('P1-4 doc.override_no_auto_done set', d.override_no_auto_done === true);
  const { checkFinalGate } = await import('./autodev-state.mjs');
  const fg = checkFinalGate(d);
  ok('P1-4 final_check does NOT silently pass', fg.pass === false && fg.overridePending === true);
}

console.log('# P1-5 gate 唯一定位 + modify patch 校验');
{
  initBase(); materialize();
  const dop = establishMode(loadAutodev(ROOT), 'hitl'); saveAutodev(ROOT, dop);
  const r1 = hitlRequest(ROOT, { sliceId: 'S1', gate: 'plan_approval' });
  const r2 = hitlRequest(ROOT, { sliceId: 'S2', gate: 'plan_approval' });
  // 用错误 sliceId 定位应失败
  const wrong = hitlRespond(ROOT, { gateId: r1.gate.id, decision: 'approve', sliceId: 'S2' });
  ok('P1-5 locate by (gateId,sliceId) wrong slice -> not found', wrong.ok === false);
  const right = hitlRespond(ROOT, { gateId: r1.gate.id, decision: 'approve', sliceId: 'S1' });
  ok('P1-5 locate by correct (gateId,sliceId) -> ok', right.ok === true);
  // modify patch 改已 done task T1 -> 拒绝
  const r3 = hitlRequest(ROOT, { sliceId: 'S1', gate: 'slice_pre_exec' });
  const mod = hitlRespond(ROOT, { gateId: r3.gate.id, decision: 'modify', patch: { task_id: 'T1' }, sliceId: 'S1' });
  ok('P1-5 modify patch targets done task -> forbidden', mod.ok === false && /forbidden/.test(mod.error || ''));
}

console.log('# P1-7 / P1-9 冲突检测（global 须声明 touches_done）');
{
  initBase(); materialize();
  hotlInit(ROOT, {});
  // global 指令不声明 touches_done -> 冲突
  const st = hotlSteer(ROOT, { kind: 'steer', text: 'change direction', scope: 'run' });
  const d = loadAutodev(ROOT);
  const cf = detectSteerConflicts(st.steer, d.hotl.steers.filter((x) => !x.applied), d);
  ok('P1-9 global without touches_done -> conflict', cf.some((c) => c.level === 'conflict'));
  // absorb 时不应用冲突 steer
  let s1 = loadSlice(ROOT, 'S1');
  const ab = absorbSteer(ROOT, d, s1);
  ok('P1-7 conflict steer NOT applied', ab.conflicts.length === 1 && ab.applied.length === 0);
  ok('P1-7 steer.conflict flagged', loadAutodev(ROOT).hotl.steers.find((x) => x.id === st.steer.id).conflict === true);
  // global 且声明 touches_done=true，且有 done slice -> warn（非冲突）
  const st2 = hotlSteer(ROOT, { kind: 'steer', text: 'x', scope: 'run', touches_done: true });
  const d2 = loadAutodev(ROOT);
  const cf2 = detectSteerConflicts(st2.steer, d2.hotl.steers.filter((x) => !x.applied), d2);
  ok('P1-9 global declares touches_done -> no hard conflict', !cf2.some((c) => c.level === 'conflict'));
}

console.log('# P1-8 intent 结构化回写 + 二次确认 journal');
{
  initBase(); materialize();
  hotlInit(ROOT, {});
  const st = hotlSteer(ROOT, { kind: 'steer', text: 'big change', scope: 'slice:S1', intent: 'high' });
  let s1 = loadSlice(ROOT, 'S1');
  const ab = absorbSteer(ROOT, loadAutodev(ROOT), s1);
  ok('P1-8 high-intent applied', ab.applied.length === 1);
  const rec = loadAutodev(ROOT).hotl.steers.find((x) => x.id === st.steer.id);
  ok('P1-8 requires_confirm set', rec.requires_confirm === true);
  const j = (await import('./autodev-state.mjs')).readJournal(ROOT);
  ok('P1-8 re-confirm journal present', j.events.some((e) => e.op === 'hotl_steer_confirm' && e.requires_confirm));
}

console.log('# P1-10 push 能力落档');
{
  initBase(); materialize();
  hotlInit(ROOT, { notify_capability: 'unsupported' });
  const db = hotlDashboard(ROOT);
  ok('P1-10 notify_capability surfaced', db.notify_capability === 'unsupported');
}

console.log('# P1-11 加权 progress_pct');
{
  initBase(); materialize();
  hotlInit(ROOT, {});
  // 设 S1 done, S2 planning（saveSliceAndSyncParent 同步父索引 stage）
  let s1 = loadSlice(ROOT, 'S1'); s1.stage = 'done'; saveSliceAndSyncParent(ROOT, s1);
  let s2 = loadSlice(ROOT, 'S2'); s2.stage = 'planning'; saveSliceAndSyncParent(ROOT, s2);
  const db = hotlDashboard(ROOT);
  // (1 + 0.15)/2 = 0.575 -> 57（浮点 57.4999 舍入为 57）
  ok('P1-11 progress_pct computed (weighted)', db.progress_pct === 57);
  // 空 slices 场景
  const empty = JSON.parse(JSON.stringify(baseDoc)); empty.slices = [];
  initAutodev(ROOT, empty, { force: true });
  hotlInit(ROOT, {});
  ok('P1-11 empty slices -> progress_pct null', hotlDashboard(ROOT).progress_pct === null);
}

console.log('# P1-6 机器强停（hotl_pause 置 loop_state=paused）');
{
  initBase(); materialize();
  hotlInit(ROOT, {});
  hotlPause(ROOT);
  const d = loadAutodev(ROOT);
  ok('P1-6 loop_state=paused after hotl_pause', d.hotl.loop_state === 'paused' && d.status === 'paused');
}

// ---- op 层（真实 index.ts factory + mock pi）----
const zodBuilder = () => ({ describe: () => zb, optional: () => zb, enum: () => zb, array: () => zb, any: () => zb, boolean: () => zb, number: () => zb, string: () => zb });
const zb = zodBuilder();
const pi = { zod: { object: () => ({ shape: {} }), enum: () => zb, string: () => zb, number: () => zb, boolean: () => zb, any: () => zb, array: () => zb, optional: () => zb } };

console.log('# P1-12 HOTL 下禁 done task 回退（op 层）');
{
  const factory = (await import('../index.ts')).default;
  const tool = factory(pi);
  initBase(); materialize();
  hotlInit(ROOT, {}); // supervised
  const r = await tool.execute('t-p1-12', { operation: 'transition_task', slice_id: 'S1', task_id: 'T1', to_status: 'blocked', root: ROOT });
  ok('P1-12 op blocks done->blocked under HOTL', r.isError === true && /HOTL_FORBID_DONE_TRANSITION/.test(r.content[0].text));
  // auto 模式应允许（done->blocked 合法）
  const da = establishMode(loadAutodev(ROOT), 'auto'); saveAutodev(ROOT, da);
  const r2 = await tool.execute('t-p1-12b', { operation: 'transition_task', slice_id: 'S1', task_id: 'T1', to_status: 'blocked', root: ROOT });
  ok('P1-12 auto mode allows done->blocked', r2.isError === false);
}

console.log('# P1-6 强指令文本 + P1-3 verify 分类（op 层）');
{
  const factory = (await import('../index.ts')).default;
  const tool = factory(pi);
  initBase(); materialize();
  hotlInit(ROOT, {});
  const rp = await tool.execute('t-pause', { operation: 'hotl_pause', root: ROOT });
  ok('P1-6 hotl_pause op returns STRONG INSTRUCTION', /STRONG INSTRUCTION/.test(rp.content[0].text));
  const rc = await tool.execute('t-cancel', { operation: 'hotl_cancel', root: ROOT });
  ok('P1-6 hotl_cancel op returns STRONG INSTRUCTION', /STRONG INSTRUCTION/.test(rc.content[0].text));
  // P1-3 verify 分类：machine + retry>=2 + exit!=0 -> CRITICAL
  const d = loadAutodev(ROOT);
  d.gate.final_standard = [{ id: 'g1', kind: 'machine', status: 'pending', verify: 'exit 1' }];
  saveAutodev(ROOT, d);
  const rv = await tool.execute('t-verify', { operation: 'verify', gate_id: 'g1', retry: 2, root: ROOT });
  ok('P1-3 verify op classifies critical machine gate', /CRITICAL/.test(rv.content[0].text) && /verify_failure/.test(rv.content[0].text));
}

console.log(`\n=== test-p1: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
