// 03-hitl-mode.mjs — HITL 模式验证
// 验证 establishMode / hitlRequest / hitlRespond / sliceHasPendingGate
import fs from 'node:fs';
import path from 'node:path';
import {
  initAutodev, loadAutodev, loadSlice, saveSlice, saveSliceAndSyncParent,
  saveAutodev, establishMode, isHotlActive, isPaused, sliceHasPendingGate, clearHitlResidual,
} from '../lib/state.mjs';
import {
  hitlRequest, hitlRespond,
} from '../lib/state.mjs';

export const name = 'hitl-mode';
export const description = 'HITL 模式: establishMode → hitlRequest → sliceHasPendingGate → hitlRespond → gate resolved';

export async function run(root, check) {
  initAutodev(root, {
    project: 'hitl-test', goal: '敏感变更', mode: 'auto', status: 'running', max_replans: 3,
    gate: { mandatory: [], developer_seed: [], derived: [], final_standard: [] },
    recon: { dimensions: [] },
    slices: [{ id: 'S1', title: '关键修改', stage: 'planning', depends_on: [], replan_attempts: 0, slice_file: '.omp/autodev/slices/S1.yaml' }],
  });
  saveSlice(root, {
    slice_id: 'S1', title: '关键修改', stage: 'planning', replan_attempts: 0,
    acceptance_criteria: [{ id: 'AC1', desc: '审核通过', verify: 'manual', kind: 'llm_judge', status: 'pending' }],
    tasks: [{ id: 'T1', title: '修改变更', status: 'todo', owner_role: 'executor', accept: 'AC 通过' }],
  });

  let doc = loadAutodev(root);

  // ── 默认 mode ──
  check('默认 mode=auto', doc.mode === 'auto');
  check('HOTL 未激活', isHotlActive(doc) === false);
  check('未暂停', isPaused(doc) === false);

  // ── establishMode hotl ──
  establishMode(doc, 'hotl');
  saveAutodev(root, doc);
  doc = loadAutodev(root);
  check('establishMode(hotl) → mode=hotl', doc.mode === 'hotl');
  check('HOTL supervised 激活', isHotlActive(doc) === true);

  // ── 切回 auto ──
  establishMode(doc, 'auto');
  saveAutodev(root, doc);
  doc = loadAutodev(root);
  check('切回 auto → mode=auto', doc.mode === 'auto');
  check('HOTL 不再激活', isHotlActive(doc) === false);

  // ── 切 hitl ──
  establishMode(doc, 'hitl');
  saveAutodev(root, doc);
  doc = loadAutodev(root);
  check('establishMode(hitl) → mode=hitl', doc.mode === 'hitl');
  check('hitl 下 HOTL 不激活', isHotlActive(doc) === false);

  // ── hitlRequest plan_approval ──
  // API: hitlRequest(root, { sliceId, gate, kind?, timeoutSec?, sensitivity? })
  // Returns: { ok, gate } where gate has { id, resolved, ... }
  const g1 = hitlRequest(root, { sliceId: 'S1', gate: 'plan_approval' });
  check('hitlRequest 返回 ok', g1?.ok === true);
  check('hitlRequest 返回 gate.id', !!g1?.gate?.id);
  check('hitlRequest gate 未 resolved', g1?.gate?.resolved === false);

  // ── sliceHasPendingGate 应阻塞 ──
  doc = loadAutodev(root);
  check('hitl.pending_gates 非空', Array.isArray(doc.hitl?.pending_gates) && doc.hitl.pending_gates.length >= 1);
  check('sliceHasPendingGate 阻塞', sliceHasPendingGate(doc, 'S1') === true);

  // ── hitlRespond approve ──
  // API: hitlRespond(root, { gateId, decision, note?, patch?, sliceId? })
  // Returns: { ok, gate, needs_replan }
  const resp = hitlRespond(root, { gateId: g1.gate.id, decision: 'approve', note: '同意', sliceId: 'S1' });
  check('hitlRespond ok', resp?.ok === true);
  check('hitlRespond gate resolved=true', resp?.gate?.resolved === true);
  check('hitlRespond decision=approve', resp?.gate?.decision === 'approve');

  doc = loadAutodev(root);
  // resolved gate 还留在 pending_gates 里但 marked resolved
  const pending = (doc.hitl?.pending_gates || []).filter(g => !g.resolved);
  check('已 resolve gate 不再算 pending', pending.length === 0);
  check('sliceHasPendingGate 解除', sliceHasPendingGate(doc, 'S1') === false);

  // ── clearHitlResidual 彻底清除所有 pending gates ──
  clearHitlResidual(root, doc);
  doc = loadAutodev(root);
  check('clearHitlResidual 后 hitl.pending_gates 为空数组',
    Array.isArray(doc.hitl?.pending_gates) && doc.hitl.pending_gates.length === 0);
}
