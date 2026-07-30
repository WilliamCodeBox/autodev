// hitl-gates.mjs
// HITL 审批点判定 + 裁决应用（状态级硬阻塞，P0-3）。
// 纯逻辑层（依赖 autodev-state.mjs 的持久化原语），不依赖 omp 运行时，可 node 直测。
import {
  loadAutodev, saveAutodev, loadSlice, saveSliceAndSyncParent, appendJournal,
  HITL_GATES, sliceHasPendingGate,
} from './autodev-state.mjs';

const DEFAULT_TIMEOUT_SEC = 7200;
// P1-1：strict/passive 模式"到期保持暂停"的逃生窗口——超时后最多再等 max_wait，
// 仍无人类响应则升级（全局暂停 + 第三方兜底告警），避免永久死锁。
const DEFAULT_MAX_WAIT_SEC = DEFAULT_TIMEOUT_SEC * 4;
const DECISIONS = ['approve', 'reject', 'modify', 'override'];
// P1-2：advisory 自动放行踩到的 CAE 高敏门——这些门绝不静默放行，必须人类裁决。
const HIGH_SENSITIVITY = ['numerical_risk', 'mpi_boundary'];

// gate 是否启用：未在 hitl.gates 显式关的，按默认（final_acceptance 默认关）。
export function gateEnabled(doc, gate) {
  const g = (doc.hitl && doc.hitl.gates) || {};
  if (gate in g) return g[gate] !== false;
  return gate !== 'final_acceptance';
}

function newGateId(scope, sliceId, gate) {
  return `hitl:${gate}:${scope === 'final' ? 'final' : sliceId}:${Date.now()}`;
}

// 发起一个等待人类裁决的 gate（写入 pending_gates + 置 slice.awaiting_human + 硬阻塞）。
//   sliceId 存在 -> scope='slice'；否则 scope='final'（最终验收前）。
export function hitlRequest(root, { sliceId, gate, kind = 'plan', timeoutSec, sensitivity } = {}) {
  if (!gate || !HITL_GATES.includes(gate)) return { ok: false, error: `invalid hitl gate: ${gate}` };
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  if (!doc.hitl || doc.hitl.enabled === false) return { ok: false, error: 'HITL not enabled (mode != hitl)' };
  if (!gateEnabled(doc, gate)) return { ok: false, error: `gate ${gate} disabled by hitl.gates` };

  const scope = sliceId ? 'slice' : 'final';
  let slice = null;
  if (scope === 'slice') {
    if (!sliceId) return { ok: false, error: 'slice gate requires slice_id' };
    slice = loadSlice(root, sliceId);
    if (!slice) return { ok: false, error: `no slice ${sliceId}` };
    if (slice.awaiting_gate) return { ok: false, error: `slice ${sliceId} already awaiting ${slice.awaiting_gate}` };
  }

  const id = newGateId(scope, sliceId, gate);
  const ts = Date.now();
  const tSec = timeoutSec || doc.hitl.default_timeout_sec || DEFAULT_TIMEOUT_SEC;
  const rec = {
    id, scope, slice_id: sliceId || null, gate, kind,
    // P1-2：高敏标记（numerical_risk / mpi_boundary）。plan_approval 涉及数值重构/
    // MPI 边界时由主循环传入，advisory 超时也不得自动放行。
    sensitivity: sensitivity || null,
    created_at: new Date(ts).toISOString(),
    timeout_at: new Date(ts + tSec * 1000).toISOString(),
    resolved: false,
  };
  doc.hitl.pending_gates = doc.hitl.pending_gates || [];
  doc.hitl.pending_gates.push(rec);
  doc.status = 'waiting_human';
  if (slice) {
    slice.awaiting_gate = id;
    if (slice.stage !== 'paused') slice.stage = 'awaiting_human';
  }
  saveAutodev(root, doc);
  if (slice) saveSliceAndSyncParent(root, slice);
  appendJournal(root, { op: 'hitl_request', gate, slice_id: sliceId, gate_id: id });
  return { ok: true, gate: rec };
}

// 人类裁决：approve / reject / modify / override。
//   approve  -> 清 pending + 解除硬阻塞，循环继续
//   reject   -> 清 pending + 置 needs_replan（主循环安全检查点回到 replan）
//   modify   -> 同上 + 记录 patch（由上层应用）
//   override -> 人工免检：把对应门强制 pass 但染色 human_override，禁自动 DONE 误判（P1-4）
export function hitlRespond(root, { gateId, decision, note, patch, sliceId } = {}) {
  if (!gateId) return { ok: false, error: 'gateId required' };
  if (!decision || !DECISIONS.includes(decision)) return { ok: false, error: `invalid decision: ${decision}` };
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  const pg = doc.hitl.pending_gates || [];
  // P1-5：按 (gateId, sliceId) 唯一精确定位，避免多 waiting gate 时误判。
  const g = pg.find((x) => x.id === gateId && !x.resolved && (sliceId ? x.slice_id === sliceId : true));
  if (!g) return { ok: false, error: `no pending gate ${gateId}${sliceId ? ' for slice ' + sliceId : ''}` };

  let slice = null;
  if (g.scope === 'slice' && g.slice_id) {
    slice = loadSlice(root, g.slice_id);
    if (!slice) return { ok: false, error: `no slice ${g.slice_id}` };
  }

  // P1-5：modify patch 不得改已 done task（防埋错）。patch 形如 { task_id } 或 { task_ids:[...] }。
  if (decision === 'modify' && patch) {
    const patchTaskIds = Array.isArray(patch.task_ids) ? patch.task_ids
      : (patch.task_id ? [patch.task_id] : []);
    if (slice) {
      for (const tid of patchTaskIds) {
        const t = (slice.tasks || []).find((x) => x.id === tid);
        if (t && t.status === 'done') {
          return { ok: false, error: `modify patch targets done task ${tid} (forbidden under any mode)` };
        }
      }
    }
  }

  g.resolved = true;
  g.decision = decision;
  g.note = note || '';
  g.resolved_at = new Date().toISOString();
  if (patch) g.patch = patch;

  doc.hitl.decisions = doc.hitl.decisions || [];
  doc.hitl.decisions.push({ gate_id: gateId, decision, note: g.note, at: g.resolved_at, auto: false });

  // 清 per-slice 硬阻塞标记
  if (slice && slice.awaiting_gate === gateId) {
    delete slice.awaiting_gate;
    if (slice.stage === 'awaiting_human') slice.stage = 'planning';
  }

  if (decision === 'reject' || decision === 'modify') doc.needs_replan = true;

  if (decision === 'override') {
    // 人工免检：把该门强制 pass（仅当 scope 对应实体存在），并染色；
    // 同时置 override_no_auto_done，禁止后续 reconcile/checkFinalGate 静默把整个 slice/run 标 DONE（P1-4）。
    g.human_override = true;
    doc.has_override = true; // 最终验收报告染色（不可删）
    if (slice) {
      const ac = (slice.acceptance_criteria || []).find((a) => a.id === g.gate);
      if (ac) { ac.status = 'pass'; ac.human_override = true; }
      slice.override_no_auto_done = true; // P1-4：本 slice 不再自动 DONE
    } else if (doc.gate && doc.gate.final_standard) {
      const it = doc.gate.final_standard.find((a) => a.id === g.gate);
      if (it) { it.status = 'pass'; it.human_override = true; }
      doc.override_no_auto_done = true; // P1-4：最终验收不再静默 DONE，需显式人工接受
    }
  }

  doc.status = (doc.hitl.pending_gates || []).some((x) => !x.resolved) ? 'waiting_human' : 'running';
  saveAutodev(root, doc);
  if (slice) saveSliceAndSyncParent(root, slice);
  appendJournal(root, { op: 'hitl_respond', gate_id: gateId, decision, needs_replan: !!doc.needs_replan });
  return { ok: true, gate: g, needs_replan: !!doc.needs_replan };
}

// 查询 pending gate（单/全），并评估超时（advisory 策略下自动 approve）。
export function hitlStatus(root, gateId) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  const auto = applyTimeoutPolicy(root, doc); // advisory 自动裁决（P1-1 escape 部分）
  const pg = doc.hitl.pending_gates || [];
  const now = Date.now();
  const list = pg.map((g) => ({
    ...g,
    timed_out: !g.resolved && new Date(g.timeout_at).getTime() <= now,
  }));
  const items = gateId ? list.filter((x) => x.id === gateId) : list;
  return {
    ok: true,
    mode: doc.hitl?.mode || 'strict',
    pending: items.filter((x) => !x.resolved),
    all: items,
    autoApproved: auto.autoApproved,
    waiting: (doc.hitl.pending_gates || []).some((x) => !x.resolved),
  };
}

// advisory 超时自动放行；strict/passive 保持暂停但受 max_wait 逃生约束（P1-1）。
// 返回 { autoApproved:[], escalated:[] } —— escalated 表示已触发死锁逃生（转 PAUSED + 告警）。
export function applyTimeoutPolicy(root, doc) {
  const policy = (doc.hitl && doc.hitl.mode) || 'strict';
  const maxWait = (doc.hitl && doc.hitl.max_wait_sec) || DEFAULT_MAX_WAIT_SEC;
  const now = Date.now();
  const autoApproved = [];
  const escalated = [];
  for (const g of doc.hitl.pending_gates || []) {
    if (g.resolved) continue;
    const toTs = new Date(g.timeout_at).getTime();
    if (toTs > now) continue; // 未超时
    if (policy === 'advisory') {
      // P1-2：高敏门（numerical_risk / mpi_boundary）即便 advisory 也绝不静默放行。
      if (g.sensitivity && HIGH_SENSITIVITY.includes(g.sensitivity)) {
        g.auto_approve_skipped = true; // 保持 pending，等人类裁决
        continue;
      }
      g.resolved = true; g.decision = 'approve'; g.auto = true; g.resolved_at = new Date().toISOString();
      if (g.scope === 'slice' && g.slice_id) {
        const sl = loadSlice(root, g.slice_id);
        if (sl && sl.awaiting_gate === g.id) { delete sl.awaiting_gate; if (sl.stage === 'awaiting_human') sl.stage = 'planning'; saveSliceAndSyncParent(root, sl); }
      }
      doc.hitl.decisions.push({ gate_id: g.id, decision: 'approve', auto: true, at: g.resolved_at });
      autoApproved.push(g.id);
    } else {
      // strict / passive：保持暂停，但超过 max_wait 后升级（P1-1 逃生），避免永久死锁。
      const overBySec = (now - toTs) / 1000;
      if (overBySec > maxWait) {
        g.escalated = true;
        g.escalated_at = new Date().toISOString();
        escalated.push(g.id);
        doc.status = 'paused'; // 全局停下 + 第三方兜底
        if (g.scope === 'slice' && g.slice_id) {
          const sl = loadSlice(root, g.slice_id);
          if (sl && sl.stage !== 'paused') { sl.stage = 'paused'; saveSliceAndSyncParent(root, sl); }
        }
        appendJournal(root, { op: 'hitl_escalate', gate_id: g.id, reason: 'max_wait exceeded; escalate to human/third-party' });
      }
    }
  }
  if (autoApproved.length || escalated.length) {
    doc.status = (doc.hitl.pending_gates || []).some((x) => !x.resolved) ? 'waiting_human' : 'running';
    if (escalated.length) doc.status = 'paused';
    saveAutodev(root, doc);
  }
  return { autoApproved, escalated };
}

// 读写 hitl.* 配置（enabled / mode / gates / default_timeout_sec）。
export function hitlConfig(root, patch = {}) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  doc.hitl = doc.hitl || {};
  if (patch.enabled !== undefined) doc.hitl.enabled = !!patch.enabled;
  if (patch.mode) doc.hitl.mode = patch.mode; // strict | advisory | passive
  if (patch.default_timeout_sec) doc.hitl.default_timeout_sec = patch.default_timeout_sec;
  if (patch.max_wait_sec) doc.hitl.max_wait_sec = patch.max_wait_sec; // P1-1：strict/passive 逃生窗口
  if (patch.gates) doc.hitl.gates = { ...(doc.hitl.gates || {}), ...patch.gates };
  saveAutodev(root, doc);
  appendJournal(root, { op: 'hitl_config', patch });
  return { ok: true, hitl: doc.hitl };
}

// P1-3：verify_failure "关键 machine 门"确定性判定。
//   规则：machine 类门 + 已重试 >= maxRetry + 退出码非 0 → 判定为 critical，
//   主循环据此必须停下发 `verify_failure` HITL 裁决，而不是 flaky 疲劳式反复重试。
//   返回 { critical, reason }；非 machine 门或还可重试 → 非 critical。
export function classifyMachineGate({ kind, retry = 0, exitCode = 0, maxRetry = 2 } = {}) {
  const critical = kind === 'machine' && retry >= maxRetry && exitCode !== 0;
  return {
    critical,
    reason: critical
      ? `critical machine gate: ${kind} failed ${retry} times (exit ${exitCode}) — require HITL verify_failure adjudication`
      : 'non-critical / retryable (kind!=machine, or retry<maxRetry, or exit==0)',
  };
}

export { sliceHasPendingGate };
