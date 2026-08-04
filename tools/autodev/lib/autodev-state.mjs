// autodev-state.mjs
// 状态机核心（纯 JS，无 omp 依赖，可 node 直接跑测试）。
// omp 的 tools/autodev/index.ts 通过 import 复用同一份逻辑，保证"可运行内核"单一来源。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load as yamlParse, dump as yamlStringify } from './js-yaml.mjs';

export const TASK_STATUS = ['todo', 'doing', 'blocked', 'done'];
export const SLICE_STAGES = ['queued', 'planning', 'executing', 'verifying', 'done', 'blocked', 'paused', 'awaiting_human', 'cancelled'];

// 合法 task 迁移边。done 为终态——禁止回退到 todo/doing，但允许重开为 blocked
// （已完成任务后续发现阻塞）。设计 §5：todo→doing→done/blocked；blocked 经父重规划回到 todo。
export const TASK_EDGES = {
  todo: ['doing', 'blocked', 'done'],
  doing: ['done', 'blocked'],
  blocked: ['todo'],
  done: ['blocked'],
};
export function canTransitionTask(from, to) {
  return (TASK_EDGES[from] || []).includes(to);
}

// ============================================================================
// HITL / HOTL 统一模式语义与派生（P0-7）
//
// 设计约束：
//   - `mode` 仅作"命令来源标记"（auto|hitl|hotl），由哪条 /autodev 入口启动决定。
//   - HOTL 激活**唯一**由 `hotl.mode` 决定（supervised|autonomous），不依赖 mode 残留。
//   - 禁止 mode=hotl & hotl.mode=autonomous 这类矛盾态；两套干预层不得同时触发。
//   - /autodev 入口显式置位，消除 yaml 残留污染（上次运行的干预层泄漏到本次）。
// ============================================================================

export const HITL_GATES = ['plan_approval', 'slice_pre_exec', 'verify_failure', 'final_acceptance'];

// 建立/重置运行模式。每次 /autodev 入口显式调用，清掉上次的干预层残留。
export function establishMode(doc, mode = 'auto') {
  doc.mode = mode;
  doc.hitl = doc.hitl || {};
  doc.hotl = doc.hotl || {};
  if (mode === 'hitl') {
    doc.hitl.enabled = true;
    doc.hotl.mode = 'autonomous';
  } else if (mode === 'hotl') {
    doc.hotl.mode = 'supervised';
    doc.hitl.enabled = false; // 两套干预层不得同时触发（P0-7）
  } else {
    // auto：回归默认，清残留
    doc.hotl.mode = 'autonomous';
    doc.hitl.enabled = false;
  }
  // 清残留 pending gate（顶层），per-slice awaiting_gate 由 hitl 模块入口清。
  doc.hitl.pending_gates = doc.hitl.pending_gates || [];
  doc.status = 'running';
  return doc;
}

// HOTL 是否激活：唯一由 hotl.mode 决定（P0-7）。
export function isHotlActive(doc) {
  return !!(doc && doc.hotl && doc.hotl.mode === 'supervised');
}

// 统一"是否暂停"派生——禁止散点比较 status/hotl.loop_state/slice.stage。
export function isPaused(doc) {
  if (!doc) return false;
  if (doc.status === 'paused') return true;
  if (doc.hotl && doc.hotl.loop_state === 'paused') return true;
  if (Array.isArray(doc.slices) && doc.slices.some((s) => s.stage === 'paused')) return true;
  return false;
}

// 统一"是否等待人类"派生。
export function isWaiting(doc) {
  if (!doc) return false;
  if (doc.status === 'waiting_human') return true;
  if (doc.hitl && Array.isArray(doc.hitl.pending_gates) && doc.hitl.pending_gates.some((g) => !g.resolved)) return true;
  if (Array.isArray(doc.slices) && doc.slices.some((s) => s.awaiting_gate)) return true;
  return false;
}

// 某 slice 是否有未裁决的 HITL pending gate（tool 层硬阻塞用，P0-3）。
export function sliceHasPendingGate(doc, sliceId) {
  if (!doc || !doc.hitl || !Array.isArray(doc.hitl.pending_gates)) return false;
  return doc.hitl.pending_gates.some((g) => !g.resolved && g.scope !== 'final' && g.slice_id === sliceId);
}

// 清除 HITL 残留：清顶层 pending_gates + 遍历各 slice 文件清 awaiting_gate（P0-7）。
export function clearHitlResidual(root, doc) {
  doc.hitl = doc.hitl || {};
  doc.hitl.pending_gates = [];
  doc.status = 'running';
  for (const meta of doc.slices || []) {
    const sl = loadSlice(root, meta.id);
    if (sl && sl.awaiting_gate) {
      delete sl.awaiting_gate;
      if (sl.stage === 'awaiting_human') sl.stage = 'planning';
      saveSliceAndSyncParent(root, sl);
    }
  }
  saveAutodev(root, doc);
  return doc;
}

const STATE_DIR = '.omp/autodev';
const SLICE_DIR = path.join(STATE_DIR, 'slices');

export function autodevPath(root = '.') {
  return path.join(root, STATE_DIR, 'autodev.yaml');
}
export function slicePath(root, id) {
  return path.join(root, SLICE_DIR, `${id}.yaml`);
}

export function loadAutodev(root = '.') {
  const p = autodevPath(root);
  if (!fs.existsSync(p)) return null;
  return yamlParse(fs.readFileSync(p, 'utf8')) || null;
}
// P0-8：原子写（write-temp + rename），消除并发 RMW 的 last-write-wins 丢更新。
function atomicWriteFile(p, data) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(p) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p); // rename 在同文件系统上是原子操作
}
export function saveAutodev(root = '.', doc) {
  const p = autodevPath(root);
  atomicWriteFile(p, yamlStringify(doc));
  return p;
}

// init 护栏：已存在 autodev.yaml 且无 force 时拒绝盲覆盖（防静默清零累积进度）。
// 其余写路径（build_standard / final_check / verify）都调用 saveAutodev 直接覆盖已加载的文档，
// 所以护栏只放在 init 这一处。
export function initAutodev(root = '.', doc, opts = {}) {
  const p = autodevPath(root);
  if (fs.existsSync(p) && !opts.force) {
    return {
      ok: false,
      error: 'autodev.yaml already exists; use incremental operations (read/transition_task/set_gate/replan), or pass force:true to reset',
      path: p,
    };
  }
  const written = saveAutodev(root, doc);
  return { ok: true, path: written };
}
export function loadSlice(root = '.', id) {
  const p = slicePath(root, id);
  if (!fs.existsSync(p)) return null;
  return yamlParse(fs.readFileSync(p, 'utf8')) || null;
}
export function saveSlice(root = '.', slice) {
  const p = slicePath(root, slice.slice_id);
  atomicWriteFile(p, yamlStringify(slice));
  return p;
}

// 任一 slice 阶段/状态变更后，同步父 autodev.yaml 中该 slice 的 stage 字段——
// 否则 checkFinalGate 读父 stage 永远是旧值（审计发现的阻断性 bug：⑤ 永远 false）。
export function syncSliceStageToParent(root = '.', sliceId, stage) {
  const doc = loadAutodev(root);
  if (!doc) return;
  const sl = (doc.slices || []).find((x) => x.id === sliceId);
  if (sl && sl.stage !== stage) {
    sl.stage = stage;
    saveAutodev(root, doc);
  }
}

// 落盘 slice 文件 + 同步父索引 stage。凡涉及 slice 状态变更的操作统一走这里。
export function saveSliceAndSyncParent(root = '.', slice) {
  saveSlice(root, slice);
  if (slice && slice.slice_id) syncSliceStageToParent(root, slice.slice_id, slice.stage);
  return slice;
}

// ---- task 状态迁移 ----
export function transitionTask(slice, taskId, toStatus, opts = {}) {
  if (!TASK_STATUS.includes(toStatus)) throw new Error(`bad task status: ${toStatus}`);
  const t = (slice.tasks || []).find((x) => x.id === taskId);
  if (!t) throw new Error(`no such task: ${taskId}`);
  if (!canTransitionTask(t.status, toStatus)) {
    const allowed = (TASK_EDGES[t.status] || []).join(',') || 'none';
    throw new Error(`illegal task transition: ${t.status} -> ${toStatus} (allowed: ${allowed})`);
  }
  t.status = toStatus;
  if (toStatus === 'blocked') {
    t.reason = opts.reason || '';
    if (opts.blocked_by) t.blocked_by = opts.blocked_by;
  } else {
    delete t.reason;
  }
  return slice;
}

// ---- slice 门控 ----
export function checkSliceGate(slice) {
  const tasks = slice.tasks || [];
  const acs = slice.acceptance_criteria || [];
  const missingTasks = tasks.filter((t) => t.status !== 'done').map((t) => `task ${t.id}:${t.status}`);
  const missingAcs = acs.filter((a) => a.status !== 'pass').map((a) => `AC ${a.id}:${a.status}`);
  return {
    pass: missingTasks.length === 0 && missingAcs.length === 0,
    missing: [...missingTasks, ...missingAcs],
  };
}

// 依据 slice 当前内容推导应处的 stage，供 check_slice_gate 落盘推进（打通状态机）：
//   全 task done + 全 AC pass → done（最关键，此前全仓无 op 写 done，导致循环到不了 DONE）
//   有 blocked task            → blocked
//   其余（已离开 planning/queued）→ verifying（门未过，进 fix loop）
export function reconcileSliceStage(slice) {
  // 人类取消是 slice 终态：机器不得将其静默翻回 done（BUG1d：撤销取消）。
  if (slice.stage === 'cancelled') {
    return { pass: false, missing: ['CANCELLED_TERMINAL'] };
  }
  // P0-3 双向守卫：存在 waiting 的 HITL pending gate（slice.awaiting_gate）时，
  // 既不下调、也不上调到 done——保留 awaiting_human 等人类裁决。
  if (slice.awaiting_gate) {
    slice.stage = 'awaiting_human';
    return { pass: false, missing: [`awaiting_gate:${slice.awaiting_gate}`], blockedByGate: true };
  }
  const g = checkSliceGate(slice);
  // P1-4：override 后禁止自动 DONE——人工免检埋下的门不能由机器静默判过。
  // 此时仍当作"未过"，并标记 overridden 让 check_slice_gate op 回显 BLOCKED_BY_OVERRIDE，
  // 强制显式人工接受，而非直接标 done。
  if (g.pass && slice.override_no_auto_done) {
    return { pass: true, missing: [], overridden: true, blockedByOverride: true };
  }
  if (g.pass) { slice.stage = 'done'; return g; }
  const hasBlocked = (slice.tasks || []).some((t) => t.status === 'blocked');
  if (hasBlocked) { slice.stage = 'blocked'; return g; }
  if (slice.stage !== 'queued' && slice.stage !== 'planning') slice.stage = 'verifying';
  return g;
}

// ---- blocked 升级重规划 ----
// 返回 { action: 'replan'|'paused', attempts }
export function replan(slice, maxReplans = 3) {
  slice.replan_attempts = (slice.replan_attempts || 0) + 1;
  if (slice.replan_attempts > maxReplans) {
    slice.stage = 'paused';
    return { action: 'paused', attempts: slice.replan_attempts };
  }
  slice.stage = 'planning'; // 回弹父 agent 重规划
  return { action: 'replan', attempts: slice.replan_attempts };
}

// ---- 最终门控 ----
export function checkFinalGate(autodev) {
  const slices = autodev.slices || [];
  const standard = autodev.gate?.final_standard || [];
  // P1-4：最终验收若存在 override（人工免检），不得静默 DONE——要求显式人工接受。
  if (autodev.override_no_auto_done) {
    return {
      pass: false,
      missing: ['OVERRIDE_REQUIRES_HUMAN_ACCEPTANCE'],
      overridePending: true,
    };
  }
  const missingSlices = slices
    .filter((s) => s.stage !== 'done' && s.stage !== 'cancelled')
    .map((s) => `slice ${s.id}:${s.stage}`);
  const missingAcs = standard.filter((a) => a.status !== 'pass').map((a) => `gate ${a.id}:${a.status}`);
  return {
    pass: missingSlices.length === 0 && missingAcs.length === 0,
    missing: [...missingSlices, ...missingAcs],
  };
}

// ---- 门控不变式（§3 / §9）：final_standard 必须含全部 mandatory + developer_seed 项 ----
// R2 对抗审查不得删除这些项。若被删，则**自动补回**并从源恢复，返回被补回的 id 供调用方报错提示。
export function validateGateInvariants(autodev) {
  const g = autodev.gate || (autodev.gate = {});
  const mandatory = g.mandatory || [];
  const seed = g.developer_seed || [];
  const required = [...mandatory, ...seed];
  const fsItems = g.final_standard || (g.final_standard = []);
  const byId = new Map(fsItems.map((x) => [x.id, x]));
  const restored = [];
  for (const req of required) {
    if (!byId.has(req.id)) {
      fsItems.push({ ...req, status: req.status || 'pending' });
      restored.push(req.id);
    }
  }
  return { ok: restored.length === 0, restored };
}

// ---- 把 mandatory + developer_seed + derived 合并成 final_standard ----
export function buildFinalStandard(autodev) {
  const g = autodev.gate || (autodev.gate = {});
  const mandatory = g.mandatory || [];
  const seed = g.developer_seed || [];
  const derived = g.derived || [];
  // mandatory 永远在线；derived 已含 R2 定稿结果
  autodev.gate.final_standard = [...mandatory, ...seed, ...derived].map((x) => ({
    ...x,
    status: x.status || 'pending',
  }));
  return autodev.gate.final_standard;
}

export function statusSummary(autodev) {
  const s = checkFinalGate(autodev);
  return {
    final_pass: s.pass,
    slices: (autodev.slices || []).map((sl) => ({
      id: sl.id,
      stage: sl.stage,
      replan_attempts: sl.replan_attempts || 0,
    })),
    missing: s.missing,
  };
}

// ============================================================================
// 上下文预算护栏（Context Budget Guardrail）
//
// 目标：让父 agent 始终在"上下文最优区域"工作 —— 相对模型窗口的百分比三态：
//   green  (used < target)    正常推进，允许 load
//   amber  (target<=used<hard) 只出不进 —— 新 load 前必须先驱逐一项驻留物
//   red    (used >= hard)      硬停，拒绝任何新 load，必须 compact / handoff
//
// 关键：硬上限 = hardCeilingPct × modelMaxContext（**相对模型窗口，不写死绝对值**）。
// 200K / 256K / 1M 窗口模型一律按比例。modelMaxContext 由 omp 读取
// （Goal Mode 的 contextWindow / models.yml 的 contextWindow 字段）；读不到则退回默认。
//
// 这里提供两层：
//   1) evaluateReadGate() —— 纯函数，门的核心。输入"当前已用 + 本次要加载的量"，返回
//      { allowed, zone, reason, action }。omp 暴露 live usage 时直接用；暴露不了则由父
//      用 ContextLedger 乐观估算后传入（兜底）。
//   2) ContextLedger —— 父会话的"工作集账本"，跟踪驻留项 token 并支持 LRU 驱逐，用于
//      在 amber 时决定驱逐谁。
// ============================================================================

// 保守 token 估算（中文 1~2 token/字，必须留 20% 余量，避免误判为 green 实则已超）
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil((other / 3 + cjk * 1.2) * 1.2);
}

// 解析模型窗口：override > omp 读取的 modelMaxContext > 默认 200000
export function resolveModelMax(modelMaxContext, override) {
  return override || modelMaxContext || 200000;
}

// 三态判定（纯 zone 计算，供诊断/测试）
export function checkBudget(used, modelMax, budget) {
  const targetPct = budget?.targetPct ?? 0.4;
  const hardPct = budget?.hardCeilingPct ?? 0.5;
  const target = Math.floor(modelMax * targetPct);
  const hard = Math.floor(modelMax * hardPct);
  if (used >= hard) return 'red';
  if (used >= target) return 'amber';
  return 'green';
}

// 读闸门（门的核心，纯函数，可直接测试）
//   usedTokens     —— 父当前已用 token（omp 的 getCurrentUsage 或 ledger.used）
//   incomingTokens —— 本次要加载的 token（estimateTokens(content)）
//   modelMax       —— resolveModelMax() 的结果
//   budget         —— { targetPct, hardCeilingPct }
// 返回 allowed:false 即"工具拒绝返回内容"，父必须 compact/handoff 或先驱逐再重试。
export function evaluateReadGate(usedTokens, incomingTokens, modelMax, budget) {
  const targetPct = budget?.targetPct ?? 0.4;
  const hardPct = budget?.hardCeilingPct ?? 0.5;
  const target = Math.floor(modelMax * targetPct);
  const hard = Math.floor(modelMax * hardPct);
  const projected = usedTokens + incomingTokens;
  if (projected >= hard) {
    return {
      allowed: false,
      zone: 'red',
      reason: 'CONTEXT_BUDGET_EXCEEDED',
      action: 'compact_or_handoff',
      target, hard, projected, usedTokens, incomingTokens,
    };
  }
  if (projected >= target) {
    return {
      allowed: false,
      zone: 'amber',
      reason: 'NEED_EVICT',
      action: 'evict_then_reload',
      target, hard, projected, usedTokens, incomingTokens,
    };
  }
  return {
    allowed: true,
    zone: 'green',
    target, hard, projected, usedTokens, incomingTokens,
  };
}

// 父会话工作集账本（乐观记账 + LRU 驱逐）
//   pinned 项（goal+invariants）永不被驱逐；其余按插入顺序驱逐最旧者。
export class ContextLedger {
  constructor() {
    this.entries = new Map(); // ref -> tokens
    this.pinned = new Set();
  }
  pin(ref, tokens) {
    this.pinned.add(ref);
    this.entries.set(ref, tokens);
  }
  add(ref, tokens) {
    this.entries.set(ref, tokens);
  }
  remove(ref) {
    this.entries.delete(ref);
  }
  get used() {
    let s = 0;
    for (const v of this.entries.values()) s += v;
    return s;
  }
  // 驱逐一个非 pinned 的最旧驻留项；无可驱逐返回 null
  evictLowest() {
    for (const [ref, tokens] of this.entries) {
      if (!this.pinned.has(ref)) {
        this.entries.delete(ref);
        return { ref, tokens };
      }
    }
    return null;
  }
}

// 从 autodev.yaml 取出 contextBudget（缺省给默认三态百分比，无 abs cap）
export function getContextBudget(autodev) {
  const cb = autodev?.contextBudget || {};
  return {
    targetPct: cb.targetPct ?? 0.4,
    hardCeilingPct: cb.hardCeilingPct ?? 0.5,
  };
}

// ============================================================================
// Handoff（slice 边界交接，durable 落盘）
//
// 每个 slice 门通过后 → 写 .omp/autodev/handoffs/S{n}.md（落盘，非会话级，因 local://
// 是会话级、compact/handoff 后会失效）→ 调原生 /handoff 以该文件为 prompt 开 S{n+1} 新
// 会话 → 新会话只载 handoff + 自己的 slice YAML，永远从 green 起。
//
// 结构（Factory.ai anchored iterative summarization 实测最优 + 4 字段契约 State/Context/
// Intent/Return path），共 5 段，**不含 Risks 段**（autodev 通用，领域无关）。pointer
// 规则：只嵌 local:// 路径与 YAML 引用，不塞全文/凭据（OWASP LLM06）。
// ============================================================================

export function handoffPath(root, sliceId) {
  return path.join(root, STATE_DIR, 'handoffs', `${sliceId}.md`);
}

export function renderHandoff(sliceId, data = {}) {
  const s = data.state || {};
  const files = (s.changed_files || []).map((f) => `${f.path}:${f.status}`).join(', ') || '[]';
  const tasks = (s.open_tasks || []).map((t) => `${t.id}:${t.status}`).join(', ') || '[]';
  const stateLines = [
    `- slice_id: ${sliceId}`,
    `- stage: ${s.stage ?? ''}`,
    `- gate_status: ${s.gate_status ?? ''}`,
    `- replan_attempts: ${s.replan_attempts ?? 0}`,
    `- changed_files: ${files}`,
    `- open_tasks: ${tasks}`,
  ].join('\n');
  const ctx = (data.context || []).map((x) => `- ${x}`).join('\n') || '- (none)';
  const intent = data.intent || '';
  const ret = data.returnPath || '';
  const ver = (data.verification || []).map((x) => `- ${x}`).join('\n') || '- (none)';
  return [
    `## State`,
    stateLines,
    ``,
    `## Context`,
    ctx,
    ``,
    `## Intent`,
    intent,
    ``,
    `## Return path`,
    ret,
    ``,
    `## Verification`,
    ver,
    ``,
  ].join('\n');
}

export function writeHandoff(root, sliceId, data = {}) {
  const p = handoffPath(root, sliceId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const md = renderHandoff(sliceId, data);
  fs.writeFileSync(p, md);
  return p;
}

// ============================================================================
// Run journal + durable artifacts（resume 支撑，§8.4 / §9 / §11）
//
// 痛点：local:// 是会话级、compact/handoff/崩溃后会失效；autodev.yaml + slices/*.yaml
// 虽是 durable YAML，但"上一次会话在做什么、卡在哪、上次门控结论"这类**过程事实**需要
// 一个 append-only 日志来锚定 resume。于是引入 run.json（事件日志）与 artifacts/（durable
// 双写目录）。
// ============================================================================

const ARTIFACT_DIR = path.join(STATE_DIR, 'artifacts');
const JOURNAL_PATH = path.join(STATE_DIR, 'run.json');

export function artifactPath(root = '.', name) {
  return path.join(root, ARTIFACT_DIR, name);
}
// 双写：把重产物落到 durable artifacts/（local:// 由 omp 会话级管理，这里只记录其引用）。
export function writeArtifact(root = '.', name, content) {
  const p = artifactPath(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return { durable: p, durableRef: `.omp/autodev/artifacts/${name}`, local: `local://${name}` };
}
export function readArtifact(root = '.', name) {
  const p = artifactPath(root, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

export function readJournal(root = '.') {
  const p = path.join(root, JOURNAL_PATH);
  if (!fs.existsSync(p)) return { events: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.events) ? j : { events: [] };
  } catch {
    return { events: [] };
  }
}
// 追加一条事件（append-only）；自带 ISO 时间戳。
export function appendJournal(root = '.', event) {
  const p = path.join(root, JOURNAL_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const j = readJournal(root);
  const ev = { t: new Date().toISOString(), ...event };
  j.events.push(ev);
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
  return ev;
}

// resume 锚点：给 compact/handoff 后的新会话一个"从哪继续"的最小事实集。
export function resumeState(root = '.') {
  const j = readJournal(root);
  const events = j.events || [];
  const last = events[events.length - 1] || null;
  const doc = loadAutodev(root);
  const summary = doc ? statusSummary(doc) : null;
  let handoffs = [];
  const hd = path.join(root, STATE_DIR, 'handoffs');
  if (fs.existsSync(hd)) handoffs = fs.readdirSync(hd).filter((f) => f.endsWith('.md'));
  return {
    hasJournal: events.length > 0,
    eventCount: events.length,
    lastEvent: last,
    statusSummary: summary,
    handoffs,
    stateDir: path.join(root, STATE_DIR),
  };
}

// ============================================================================
// ADR (Architecture Decision Record) — 项目级架构决策沉淀
//
// 只写 markdown 文件到 docs/adr/，autodev.yaml 只维护 next_id 计数器。
// 不维护 YAML 索引（目录扫描 + frontmatter 即时派生）。
// 不原子双写（单文件写入，幂等）。
// ============================================================================

const ADR_DIR = 'docs/adr';

function adrDir(root) {
  return path.join(root, ADR_DIR);
}

function adrPath(root, id, slug) {
  return path.join(adrDir(root), `${id}-${slug}.md`);
}

// 从标题生成文件系统安全的 slug：alphanumeric + CJK 保留，空格→连字符，小写，截 40 字符
function titleToSlug(title) {
  if (!title) return 'untitled';
  let slug = title
    .replace(/[^\w\u4e00-\u9fff\- ]/g, '')   // 只保留字母/数字/中文/空格/连字符
    .trim()
    .replace(/\s+/g, '-')                        // 空格 → 连字符
    .replace(/-+/g, '-')                         // 合并连续连字符
    .toLowerCase()
    .slice(0, 40)
    .replace(/^-|-$/g, '');                      // 去掉首尾连字符
  return slug || 'untitled';
}

// 扫描 docs/adr/ 目录下已有文件，取 max id。无文件时返回 0。
function scanMaxAdrId(root) {
  const dir = adrDir(root);
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-.+\.md$/.test(f));
  if (files.length === 0) return 0;
  const ids = files.map(f => parseInt(f.slice(0, 4), 10));
  return Math.max(...ids);
}

// 全局写锁：序列化 appendADR 关键区，杜绝并发下 next_id 的 RMW 丢更新与 id 撞车。
// 用 O_EXCL 创建锁文件（原子），自旋等待；持锁期间完成 ADR 写入与 yaml 计数器落盘，
// 释放锁前轮询确认 yaml 已就绪（应对部分环境下 rename 异步/被测试 shim 延迟的窗口）。
function withAdrWriteLock(root, fn) {
  const lockPath = path.join(adrDir(root), '.adr-write.lock');
  while (true) {
    try {
      fs.openSync(lockPath, 'wx');
      break;
    } catch {
      const end = Date.now() + 5;
      while (Date.now() < end) {}
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

// 某 padded 槽是否被占用：目录里存在 `${padded}-*.md`（任意 slug 都算占槽）。
// 用于撞 id 规避：磁盘已存在同 id 的 ADR（竞态残留/手动文件）时，appendADR 应递增到空闲槽。
function paddedSlotTaken(root, padded) {
  const dir = adrDir(root);
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.startsWith(padded + '-') || f === padded + '.md');
}

// 追加一条架构决策记录。
// 有 autodev.yaml 时（消费项目场景）用 yaml 中的 adr.next_id 计数器，
// 无 autodev.yaml 时（自 ADR 场景）扫描 docs/adr/ 目录取 max_id + 1。
// 不维护 YAML 索引（目录扫描 + frontmatter 即时派生）。
// 全局写锁保证并发安全：id 唯一 + next_id 不丢更新（BUG2：RECON 并行 fan-out 撞 id）。
// 返回 { path, id, slug }。
export function appendADR(root = '.', { title, context, decision, consequences, origin, slice_id, decider, supersedes } = {}) {
  if (!title || !decision) throw new Error('appendADR requires title and decision');

  fs.mkdirSync(adrDir(root), { recursive: true });

  return withAdrWriteLock(root, () => {
    const doc = loadAutodev(root);
    const hasYaml = !!doc;
    if (doc) {
      // 消费项目场景：autodev.yaml 提供计数器 + journal
      doc.adr = doc.adr || { next_id: 1 };
    }

    // id 起点：有 yaml 用计数器（语义约束：不跟随目录里的手动 ADR，见 test-adr mixed）；
    // 无 yaml 用目录扫描 max+1（自 ADR 场景）。
    let id = hasYaml ? (doc.adr.next_id || 1) : scanMaxAdrId(root) + 1;
    // 撞 id 规避：若起点 id 对应槽已被占用（竞态残留/手动文件），递增到首个空闲槽。
    // BUG2a：磁盘已有 0001-* 残留文件时，不应复用 0001。
    let padded = String(id).padStart(4, '0');
    while (paddedSlotTaken(root, padded)) {
      id += 1;
      padded = String(id).padStart(4, '0');
    }

    const slug = titleToSlug(title);
    const fp = adrPath(root, padded, slug);

    const consequencesBody = Array.isArray(consequences) ? consequences.map(c => `- ${c}`).join('\n') : (consequences || '- (待补充)');

    const frontLines = [
      '---',
      `date: ${new Date().toISOString().slice(0, 10)}`,
      'status: accepted',
      `decider: ${decider || 'autodev'}`,
      `origin: ${origin || 'manual'}`,
      slice_id ? `slice: ${slice_id}` : null,
      '---',
    ].filter(Boolean);

    const bodyLines = [
      '',
      `# ADR-${padded}: ${title}`,
      '',
      '## Context',
      '',
      context || '(待补充)',
      '',
      '## Decision',
      '',
      decision,
      '',
      '## Consequences',
      '',
      consequencesBody,
      '',
      supersedes ? `## Links\n\n- Supersedes: ADR-${supersedes}` : null,
      '',
    ].filter(l => l !== null);

    const parts = frontLines.concat(bodyLines).join('\n');

    fs.writeFileSync(fp, parts, 'utf8');

    if (hasYaml) {
      doc.adr.next_id = id + 1;
      saveAutodev(root, doc);
      appendJournal(root, { op: 'adr_append', adr_id: padded, slug, title: title.slice(0, 60) });
      // 确保 yaml 真正落盘后再释放锁（应对 rename 异步/被测试 shim 延迟的窗口）：
      // 轮询至读到期望的 next_id，避免下一个持锁进程读到旧计数器而重复分配。
      const want = doc.adr.next_id;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const reloaded = loadAutodev(root);
        if (reloaded?.adr?.next_id === want) break;
        const spin = Date.now() + 2;
        while (Date.now() < spin) {}
      }
    }

    return { path: fp, id: padded, slug };
  });
}

// 真正执行 verify 命令（machine 类）并据退出码判定 —— 不采信 subagent 自报。
// 任何失败（spawn 异常/非 0 退出）都记为 fail，并落 durable 产物 + 写 journal。
export function runVerify(root = '.', opts = {}) {
  const { gate_id, slice_id, verify_cmd, timeout_ms = 60000, doc: docIn, slice: sliceIn } = opts;
  if (!gate_id) return { ok: false, error: 'gate_id required' };
  const doc = docIn || loadAutodev(root);
  if (!doc) return { ok: false, error: 'no autodev.yaml' };
  let entry = null, source = null;
  const fsItem = (doc.gate?.final_standard || []).find((a) => a.id === gate_id);
  if (fsItem) { entry = fsItem; source = 'final_standard'; }
  let slice = sliceIn || null;
  if (slice_id) {
    slice = slice || loadSlice(root, slice_id);
    const ac = (slice?.acceptance_criteria || []).find((a) => a.id === gate_id);
    if (ac && !entry) { entry = ac; source = 'slice_ac'; }
  }
  const cmd = verify_cmd || entry?.verify;
  if (!cmd) return { ok: false, error: `no verify command for ${gate_id}` };
  let stdout = '', stderr = '', status = null, ran = false;
  try {
    const r = spawnSync(cmd, { shell: true, cwd: root, encoding: 'utf8', timeout: timeout_ms });
    stdout = r.stdout || '';
    stderr = r.stderr || '';
    status = r.status;
    ran = true;
  } catch (e) {
    stderr = String(e?.message || e);
  }
  const kind = entry?.kind || 'machine';
  const vstatus = kind === 'machine' ? (ran && status === 0 ? 'pass' : 'fail') : 'pending';
  const artName = `verify-${gate_id}-${Date.now()}.txt`;
  const body =
    `gate ${gate_id} (${source || 'unknown'}) kind=${kind}\n` +
    `cmd: ${cmd}\n` +
    `exit: ${status}\n` +
    `--- stdout ---\n${stdout}\n` +
    `--- stderr ---\n${stderr}\n`;
  const art = writeArtifact(root, artName, body);
  if (entry && kind === 'machine') {
    entry.status = vstatus;
    entry.verified_at = Date.now();
    if (source === 'final_standard') saveAutodev(root, doc);
    else if (slice) saveSliceAndSyncParent(root, slice);
  }
  appendJournal(root, { op: 'verify', gate_id, source, kind, exit: status, status: vstatus, artifact: art.durableRef });
  return { ok: true, ran, exit: status, status: vstatus, kind, source, stdout, stderr, artifact: art.durableRef };
}
