// recon-score.mjs
// RECON 维度置信度打分（纯逻辑，无外部依赖，可 node 直跑测试）。
//
// 设计意图（见 autodev-design.md §11 待办 "维度置信度打分"）：
//   RECON 扇出返回后，给每个维度算一个 confidence(0~1)，并据此路由——
//     · confidence >= threshold            → solid（当作 PLAN 坚实地基）
//     · confidence < threshold 且 pass<max → revisit（进 2-round 对抗裁剪 / 可能再侦察）
//     · confidence < threshold 且 pass>=max → escalate（停 recon，升级人工/PAUSED，防死循环）
//
// 评分只消费 subagent 已有返回值（status / findings / summary / next_action_or_blocker），
// 不额外消耗侦察 token。recon_pass 记录该维度是第几轮侦察，用于收敛判据。

const STATUS_BASE = { success: 0.7, partial: 0.4, blocked: 0.15 };

// 检测一条 finding 是否带 file:line 证据（如 `src/a.f90:42` 或 `a.f90: 42`）
export function hasFileLine(s) {
  if (typeof s !== 'string') return false;
  return /\S+\.\w+:\d+/.test(s) || /:\s*\d+/.test(s);
}

// 风险/未知信号：summary 或 next_action_or_blocker 含这些词 → 压顶置信并标记矛盾
const RISK_RE = /block|unknown|unclear|uncertain|contradict|矛盾|阻塞|未知|不确定|探不动|缺失关键/i;
export function hasRiskSignal(...texts) {
  return RISK_RE.test(texts.filter(Boolean).join(' '));
}

// 对单个维度打分。dim = RECON-PLAN 产出的维度定义；sub = 该维度 recon subagent 的返回值。
// 返回 {...dim, confidence, evidence_status, recon_pass}
export function scoreReconDimension(dim, sub = {}) {
  const status = sub?.status || 'blocked';
  const base = STATUS_BASE[status] ?? 0.3;

  const findings = Array.isArray(sub?.findings) ? sub.findings : [];
  const evCount = findings.filter((f) => hasFileLine(String(f))).length;
  const evidenceBonus = Math.min(evCount * 0.1, 0.25); // 每条 file:line 证据 +0.1，封顶 +0.25

  let conf = Math.min(1, base + evidenceBonus);

  // raw 状态（应用风险压顶前）
  let evidence_status = conf >= 0.7 ? 'covered' : conf >= 0.4 ? 'partial' : 'missing';

  const risk = hasRiskSignal(sub?.summary, sub?.next_action_or_blocker);
  if (risk) {
    conf = Math.min(conf, 0.5); // 风险信号压顶，不轻信"看起来有证据"
    if (evidence_status === 'covered') evidence_status = 'contradicted'; // 有证据但有矛盾 → 矛盾态
    else evidence_status = 'partial';
  }

  conf = Math.round(conf * 100) / 100;
  const recon_pass = Number.isFinite(dim?.recon_pass) ? dim.recon_pass : 1;
  return { ...dim, confidence: conf, evidence_status, recon_pass };
}

// 批量打分。subResults: { [dimId]: subagentReturn }
export function scoreReconDimensions(planDims = [], subResults = {}) {
  return planDims.map((d) => scoreReconDimension(d, subResults?.[d?.id] || {}));
}

// 路由分类：把打分结果分成 solid / revisit / escalate 三组（返回 id 数组）
export function classifyReconConfidence(scored = [], opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.55;
  const maxPass = typeof opts.maxPass === 'number' ? opts.maxPass : 2;
  const groups = { solid: [], revisit: [], escalate: [] };
  for (const d of scored) {
    if (d.confidence >= threshold) groups.solid.push(d.id);
    else if (d.recon_pass >= maxPass) groups.escalate.push(d.id);
    else groups.revisit.push(d.id);
  }
  return groups;
}

// 收敛判据辅助：两轮 confidence 涨幅 < epsilon 视为不再有收益（配合 recon_pass 上限使用）
export function confidenceDelta(prev, cur) {
  return Math.round((cur - prev) * 1000) / 1000;
}
