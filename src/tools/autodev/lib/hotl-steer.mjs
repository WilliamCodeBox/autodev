// hotl-steer.mjs
// HOTL 监控/控制面逻辑（状态级 + tool 层吸收，P0-4/P0-5/P0-6）。
// 纯逻辑层（依赖 autodev-state.mjs 持久化原语），不依赖 omp 运行时，可 node 直测。
//
// 职责边界：
//   - 本模块只负责"HITL 之外"的人类干预层——Agent 自主跑，人类监控 + 随时 steer/pause/resume/cancel。
//   - HOTL 激活唯一由 doc.hotl.mode === 'supervised' 决定（P0-7）。
//   - 吸收（absorb）发生在 tool 层 op 内（transition_task / check_slice_gate / replan），不靠 LLM 自觉（P0-4）。
//   - 循环因 replan 超限收敛到 paused 时，由 index.ts 编排层调用 convergeToPaused 置 loop_state（P0-5）。
//   - 人类 steer 把 paused 解回 planning 时，重置 replan_attempts（P0-6），避免"以为解了其实没解"。
import {
  loadAutodev, saveAutodev, loadSlice, saveSliceAndSyncParent, appendJournal,
  isHotlActive,
} from './autodev-state.mjs';

const STEER_KINDS = ['steer', 'pause', 'resume', 'cancel'];
let _steerSeq = 0;

// P1-11：进度权重（等权缺省，未声明 weight 时一律等权）。stage -> 完成度权重。
const STAGE_WEIGHT = {
  queued: 0, planning: 0.15, executing: 0.4, verifying: 0.7, done: 1,
  blocked: 0.3, paused: 0.3, awaiting_human: 0.3, cancelled: 0,
};
// 进度百分比：各 slice 按 stage 权重取均值；空 slices → null（无进度可言）。
function progressPct(root, doc) {
  const slices = doc.slices || [];
  if (!slices.length) return null;
  let sum = 0;
  for (const m of slices) {
    const sl = loadSlice(root, m.id) || m;
    sum += STAGE_WEIGHT[sl.stage] ?? 0;
  }
  return Math.round((sum / slices.length) * 100);
}

function ensureHotl(doc) {
  doc.hotl = doc.hotl || {};
  doc.hotl.mode = doc.hotl.mode || 'autonomous';
  doc.hotl.loop_state = doc.hotl.loop_state || 'running';
  doc.hotl.steers = doc.hotl.steers || [];
  doc.hotl.notifications = doc.hotl.notifications || [];
  doc.hotl.dashboard = doc.hotl.dashboard || { last_poll: null, since: new Date().toISOString() };
  return doc.hotl;
}

// 激活 HOTL（/autodev hotl 入口调用）：置 mode=supervised + 清 HITL 残留（P0-7）。
//   patch.notify_capability：由 index.ts 探测 pi.sendMessage 后传入（P1-10），
//     'push' = 支持外推；'unsupported' = 当前运行时无 push，仅落 journal/dashboard。
export function hotlInit(root, patch = {}) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  const h = ensureHotl(doc);
  h.mode = 'supervised';
  h.loop_state = 'running';
  if (patch.notify_target) h.notify_target = patch.notify_target;
  // P1-10：push 能力探测结果落档，dashboard 明示，避免静默死推。
  if (patch.notify_capability) h.notify_capability = patch.notify_capability;
  // HOTL 与 HITL 互斥（P0-7）：清 HITL 启用标记与残留 gate。
  if (doc.hitl) { doc.hitl.enabled = false; doc.hitl.pending_gates = []; }
  doc.mode = 'hotl';
  doc.status = 'running';
  saveAutodev(root, doc);
  appendJournal(root, { op: 'hotl_init', mode: 'supervised' });
  return { ok: true, hotl: h };
}

// 记录一条人类 steer 指令（不直接执行，等下次 tool 层吸收点消费，P0-4）。
//   kind: steer(微调/改方向) | pause | resume | cancel
//   scope: 'run' | 'slice:<id>' | 'task:<sliceId>:<taskId>'
//   intent: 'low' | 'medium' | 'high' —— 结构化影响面（P1-8），由 LLM 判定后回写；
//           medium/high 强制二次确认 journal，不静默应用。
//   touches_done: 仅 global(run) 指令需显式声明是否触及已 done 维度（P1-9），缺省视为冲突。
export function hotlSteer(root, { kind = 'steer', text = '', scope = 'run', intent, touches_done } = {}) {
  if (!STEER_KINDS.includes(kind)) return { ok: false, error: `invalid steer kind: ${kind}` };
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  if (!isHotlActive(doc)) return { ok: false, error: 'HOTL not active (hotl.mode != supervised)' };
  const h = ensureHotl(doc);
  const rec = {
    id: `hotl:steer:${Date.now()}:${++_steerSeq}`,
    kind,
    text,
    scope,
    intent: intent || 'low',
    // P1-9：global 指令必须显式枚举是否触及 done 维度；缺省 null 会在吸收点判为冲突（YAML 不保 undefined，用 null 表示未声明）。
    touches_done: scope === 'run' ? (touches_done === undefined ? null : !!touches_done) : false,
    created_at: new Date().toISOString(),
    applied: false,
  };
  h.steers.push(rec);
  saveAutodev(root, doc);
  appendJournal(root, { op: 'hotl_steer', kind, scope, intent: rec.intent, steer_id: rec.id });
  return { ok: true, steer: rec };
}

// 通知人类（HOTL dashboard / 外发）。直接 push 到 hotl.notifications 并落盘。
export function notifyHotl(root, doc, message, level = 'info') {
  const h = ensureHotl(doc);
  h.notifications.push({ at: new Date().toISOString(), level, message });
  saveAutodev(root, doc);
  return h.notifications;
}

// P0-5：编排层在核心状态机返回 paused（replan 超限）时调用，把 HOTL loop 收敛到 paused + 通知。
//   注意：核心状态机（replan）只设 slice.stage='paused'；这里收敛"循环级"状态，二者互不矛盾。
export function convergeToPaused(root, reason = 'replan limit reached') {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  const h = ensureHotl(doc);
  h.loop_state = 'paused';
  doc.status = 'paused';
  notifyHotl(root, doc, `[HOTL] loop converged to PAUSED: ${reason}`, 'warn');
  saveAutodev(root, doc);
  appendJournal(root, { op: 'hotl_converge_paused', reason });
  return { ok: true, loop_state: 'paused' };
}

// P1-7 / P1-9：steer 冲突与影响面检测。
//   返回 [{ level:'warn'|'conflict', reason }]；含 'conflict' 级则不静默应用，须人工裁决。
//   规则：
//     - P1-9：global(run) 指令必须显式声明 touches_done；缺省 undefined 视为冲突（防止漏报改已完成工作）。
//     - P1-9：global 且声明 touches_done=true 时，若当前已有 done slice，给 warn（将触及已完成维度）。
//     - P1-7：未应用的 pending 集中存在针对同 scope 的 'cancel'，而新指令非 cancel → 矛盾。
//     - P1-7：未应用的 pending 集中存在 'pause'，而新指令是继续类(steer) → warn（暂停态下继续）。
//     - 两条未应用的 steer 互相 supersede → warn（后者覆盖前者，记一笔）。
export function detectSteerConflicts(steer, pending, doc) {
  const out = [];
  const sameScope = (s) => s.scope === steer.scope || (steer.scope === `slice:${s.slice_id}` && s.scope === 'run');
  // 用 == null 同时匹配 undefined（内存中）与 null（YAML 往返后），表示"未声明"。
  // 仅对 directional `steer` 要求声明 touches_done；pause/resume/cancel 是控制指令，不改工作内容，无需声明。
  if (steer.scope === 'run' && steer.kind === 'steer' && steer.touches_done == null) {
    out.push({ level: 'conflict', reason: 'global steer must declare touches_done explicitly (P1-9: impact diff required)' });
  }
  if (steer.scope === 'run' && steer.kind === 'steer' && steer.touches_done === true) {
    const doneSlices = (doc.slices || []).filter((m) => m.stage === 'done');
    if (doneSlices.length) out.push({ level: 'warn', reason: `global steer declares touching done dimensions; will affect ${doneSlices.length} completed slice(s)` });
  }
  for (const p of pending) {
    if (p.id === steer.id) continue;
    if (!sameScope(p)) continue;
    if (p.kind === 'cancel' && steer.kind !== 'cancel') {
      out.push({ level: 'conflict', reason: `pending 'cancel' (${p.id}) contradicts new '${steer.kind}' directive` });
    }
    if (p.kind === 'pause' && steer.kind === 'steer') {
      out.push({ level: 'warn', reason: `continuing (steer) while a pause (${p.id}) is still pending` });
    }
    if (p.kind === 'steer' && steer.kind === 'steer') {
      out.push({ level: 'warn', reason: `new steer supersedes prior unapplied steer (${p.id})` });
    }
  }
  return out;
}

// P0-4 + P0-6：tool 层吸收点消费——在 transition_task / check_slice_gate / replan 之后调用。
//   对当前 slice 可见的未应用 steer 逐条应用，并落盘。
//   返回 { applied: [...], conflicts: [...] } 供 index.ts 回显给 LLM 作为事实集。
//
// 吸收规则：
//   - scope 'run' / 'slice:<id>' 命中当前 slice 时：
//       * resume 且 slice.stage === 'paused' -> planning（P0-6 重置 replan_attempts=0）
//       * pause  -> paused
//       * cancel -> cancelled
//       * steer  -> 记录 text 到 slice.steer_notes（供主循环 checkpoint 吸收，不强制改状态）
//   - scope 'task:<sliceId>:<taskId>' 命中时：记入 task.steer_notes，不改 task.status（避免破坏 TASK_EDGES）
//   - P1-7/9：应用前先跑 detectSteerConflicts；含 conflict 级则**不应用**、标记待人工裁决。
//   - P1-8：medium/high intent 应用后强制二次确认 journal（requires_confirm）。
export function absorbSteer(root, doc, slice) {
  if (!isHotlActive(doc)) return { applied: [], conflicts: [] };
  const h = ensureHotl(doc);
  const pending = h.steers.filter((s) => !s.applied);
  const applied = [];
  const conflicts = [];
  for (const st of pending) {
    const targetsRun = st.scope === 'run';
    const targetsSlice = st.scope === `slice:${slice.slice_id}`;
    if (!targetsRun && !targetsSlice) continue; // 不属于本 slice 的吸收点，留给对应 slice

    // P1-7/9：冲突检测——硬冲突不静默应用，等人工裁决。
    const cf = detectSteerConflicts(st, pending, doc);
    const hard = cf.filter((c) => c.level === 'conflict');
    if (hard.length) {
      st.conflict = true;
      st.conflict_reasons = hard.map((c) => c.reason);
      st.applied = false;
      appendJournal(root, { op: 'hotl_steer_conflict', steer_id: st.id, reasons: st.conflict_reasons });
      conflicts.push({ steer_id: st.id, reasons: st.conflict_reasons });
      continue;
    }

    if (st.kind === 'resume' && slice.stage === 'paused') {
      slice.stage = 'planning';
      slice.replan_attempts = 0; // P0-6：解阻重置，避免重复触发 paused
      applied.push({ steer_id: st.id, effect: 'slice:resumed', reset_replan_attempts: true });
    } else if (st.kind === 'pause') {
      if (slice.stage !== 'paused') slice.stage = 'paused';
      applied.push({ steer_id: st.id, effect: 'slice:paused' });
    } else if (st.kind === 'cancel') {
      slice.stage = 'cancelled';
      applied.push({ steer_id: st.id, effect: 'slice:cancelled' });
    } else if (st.kind === 'steer') {
      slice.steer_notes = slice.steer_notes || [];
      slice.steer_notes.push({ at: st.created_at, text: st.text });
      applied.push({ steer_id: st.id, effect: 'slice:noted', text: st.text });
    }
    st.applied = true;
    st.applied_at = new Date().toISOString();
    st.applied_to = slice.slice_id;

    // P1-8：medium/high intent 结构化回写 + 强制二次确认 journal。
    if (st.intent === 'medium' || st.intent === 'high') {
      st.requires_confirm = true;
      appendJournal(root, { op: 'hotl_steer_confirm', steer_id: st.id, intent: st.intent, requires_confirm: true });
    }
  }

  if (applied.length || conflicts.length) {
    saveSliceAndSyncParent(root, slice);
    saveAutodev(root, doc);
    appendJournal(root, { op: 'hotl_absorb', slice_id: slice.slice_id, applied: applied.map((a) => a.steer_id), conflicts: conflicts.map((c) => c.steer_id) });
  }
  return { applied, conflicts };
}

// 监控快照（HITL 之外的人类可见状态）。scope='run' 全量；'slice:<id>' 单项。
export function hotlPoll(root, scope = 'run') {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  if (!isHotlActive(doc)) return { ok: false, error: 'HOTL not active' };
  const h = ensureHotl(doc);
  h.dashboard.last_poll = new Date().toISOString();
  const slices = (doc.slices || []).map((m) => {
    const sl = m; // 父索引只有 stage；如需细节 loadSlice
    return { id: sl.id, stage: sl.stage };
  });
  // 拉取明细（slice 文件里的 tasks / steers 可见性）
  const details = (doc.slices || []).map((m) => {
    const sl = loadSlice(root, m.id);
    if (!sl) return { id: m.id, stage: m.stage, missing: true };
    const match = scope === 'run' || scope === `slice:${sl.slice_id}`;
    if (!match) return null;
    return {
      id: sl.slice_id,
      stage: sl.stage,
      replan_attempts: sl.replan_attempts || 0,
      tasks: (sl.tasks || []).map((t) => ({ id: t.id, status: t.status })),
      pending_steers: (h.steers || []).filter((s) => !s.applied && (s.scope === 'run' || s.scope === `slice:${sl.slice_id}`)),
    };
  }).filter(Boolean);
  saveAutodev(root, doc); // 更新 last_poll
  const pendingSteers = (h.steers || []).filter((s) => !s.applied);
  return {
    ok: true,
    loop_state: h.loop_state,
    slice_stages: slices,
    pending_steers: pendingSteers,
    details,
    notifications: h.notifications.slice(-20),
  };
}

export function hotlPause(root) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  if (!isHotlActive(doc)) return { ok: false, error: 'HOTL not active' };
  const h = ensureHotl(doc);
  h.loop_state = 'paused';
  doc.status = 'paused';
  notifyHotl(root, doc, '[HOTL] loop paused by human', 'info');
  saveAutodev(root, doc);
  appendJournal(root, { op: 'hotl_pause' });
  return { ok: true, loop_state: 'paused' };
}

export function hotlResume(root) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  if (!isHotlActive(doc)) return { ok: false, error: 'HOTL not active' };
  const h = ensureHotl(doc);
  h.loop_state = 'running';
  doc.status = 'running';
  saveAutodev(root, doc);
  appendJournal(root, { op: 'hotl_resume' });
  return { ok: true, loop_state: 'running' };
}

export function hotlCancel(root) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  if (!isHotlActive(doc)) return { ok: false, error: 'HOTL not active' };
  const h = ensureHotl(doc);
  h.loop_state = 'cancelled';
  doc.status = 'cancelled';
  notifyHotl(root, doc, '[HOTL] run cancelled by human', 'warn');
  saveAutodev(root, doc);
  appendJournal(root, { op: 'hotl_cancel' });
  return { ok: true, loop_state: 'cancelled' };
}

export function hotlStatus(root) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  const h = ensureHotl(doc);
  return {
    ok: true,
    active: isHotlActive(doc),
    mode: h.mode,
    loop_state: h.loop_state,
    pending_steers: (h.steers || []).filter((s) => !s.applied),
    unanswered_notifications: (h.notifications || []).length,
  };
}

// 给 human dashboard 用的精简卡片（HTML 之外的纯数据）。
export function hotlDashboard(root) {
  const doc = loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  const h = ensureHotl(doc);
  const steers = h.steers || [];
  return {
    ok: true,
    loop_state: h.loop_state,
    mode: h.mode,
    // P1-10：push 能力明示（unsupported 时人类知道只能看 dashboard，不能收外推）。
    notify_capability: h.notify_capability || 'unknown',
    // P1-11：加权进度百分比（等权缺省；空 slices → null）。
    progress_pct: progressPct(root, doc),
    slices: (doc.slices || []).map((m) => ({ id: m.id, stage: m.stage })),
    pending_steers: steers.filter((s) => !s.applied).map((s) => ({
      id: s.id, kind: s.kind, scope: s.scope, text: s.text,
      intent: s.intent, requires_confirm: !!s.requires_confirm, conflict: !!s.conflict,
    })),
    // P1-7/9：待人工裁决的冲突 steer 数。
    pending_conflicts: steers.filter((s) => s.conflict && !s.applied).length,
    // P1-8：待二次确认的 medium/high steer 数。
    needs_confirm: steers.filter((s) => s.requires_confirm && !s.applied).length,
    notifications: (h.notifications || []).slice(-10),
    since: h.dashboard?.since || null,
    last_poll: h.dashboard?.last_poll || null,
  };
}

export { isHotlActive };
