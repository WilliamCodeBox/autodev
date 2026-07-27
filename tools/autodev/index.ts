// tools/autodev/index.ts
// oh-my-pi 自定义 tool：autodev 状态/YAML/门控管理。
// 这是 autodev 的"薄编排层"里唯一新增的运行时能力；编排本身交给 workflow/orchestrate 原语。
//
// 格式要点（与 omp 真实加载对齐）：
//   - 通过 omp 注入的 `pi.zod` 收参，无外部依赖（裸 tools/ 目录 omp 不保证解析得到 npm 包）。
//   - 返回值必须是 { content:[{type:'text',text}], details, isError }，不能返回裸字符串。
//   - YAML 解析/序列化用 ./lib/yaml-lite.mjs（内联、无 js-yaml 依赖）。
import fs from 'node:fs';
import path from 'node:path';
import {
  loadAutodev, saveAutodev, loadSlice, saveSlice, initAutodev,
  transitionTask, replan, checkFinalGate, buildFinalStandard,
  autodevPath, slicePath,
  estimateTokens, resolveModelMax, evaluateReadGate, getContextBudget, writeHandoff,
  writeArtifact, readArtifact, readJournal, appendJournal, resumeState, runVerify,
  saveSliceAndSyncParent, reconcileSliceStage, validateGateInvariants, SLICE_STAGES,
} from './lib/autodev-state.mjs';
import { scoreReconDimensions, classifyReconConfidence } from './lib/recon-score.mjs';

type ToolResult = { content: { type: 'text'; text: string }[]; details?: unknown; isError: boolean };
const ok = (text: string, details?: unknown): ToolResult => ({ content: [{ type: 'text', text }], details, isError: false });
const err = (text: string, details?: unknown): ToolResult => ({ content: [{ type: 'text', text }], details, isError: true });

// omp 注入 pi（含 pi.zod）。类型用 any 以避免对 omp 类型包的硬依赖。
const factory = (pi: any) => ({
  name: 'autodev',
  label: 'AutoDev State',
  description:
    'Manage autodev YAML state: init/read/write autodev.yaml and slice YAML, ' +
    'transition task/slice status, check slice & final gates, run replan on blocked, ' +
    'build final acceptance standard. Pair with the /autodev command and workflow/orchestrate primitives.',
  parameters: pi.zod.object({
    operation: pi.zod.enum([
      'init', 'read', 'read_slice', 'read_gate', 'handoff',
      'transition_task', 'set_gate', 'replan', 'build_standard', 'final_check',
      'write_local', 'journal', 'resume', 'verify', 'recon_score',
      'check_slice_gate', 'set_slice_stage',
    ]),
    root: pi.zod.string().optional().describe('Project root, default "."'),
    autodev: pi.zod.any().optional().describe('Full autodev.yaml object for init'),
    force: pi.zod.boolean().optional().describe('init: if true, overwrite existing autodev.yaml (default refuse to avoid silent state wipe)'),
    slice_id: pi.zod.string().optional(),
    slice_stage: pi.zod.enum(['queued', 'planning', 'executing', 'verifying', 'done', 'blocked', 'paused']).optional().describe('set_slice_stage: new stage for the slice'),
    ref: pi.zod.string().optional().describe('Artifact ref/path being loaded (e.g. local://x.md or .omp/autodev/artifacts/x.md)'),
    content: pi.zod.string().optional().describe('Content about to be loaded; if omitted, read from `ref` path under root'),
    used_tokens: pi.zod.number().optional().describe('Parent current used tokens (omp getCurrentUsage or ledger.used); 0 if unknown'),
    model_max: pi.zod.number().optional().describe('Override modelMaxContext (tokens). Else read from autodev.yaml or default 200000'),
    handoff_json: pi.zod.string().optional().describe('JSON: { state, context, intent, returnPath, verification }'),
    task_id: pi.zod.string().optional(),
    to_status: pi.zod.enum(['todo', 'doing', 'blocked', 'done']).optional(),
    reason: pi.zod.string().optional(),
    blocked_by: pi.zod.array(pi.zod.string()).optional(),
    gate_scope: pi.zod.enum(['slice_ac', 'final_standard']).optional(),
    gate_id: pi.zod.string().optional(),
    gate_status: pi.zod.enum(['pending', 'pass', 'fail']).optional(),
    verify_cmd: pi.zod.string().optional().describe('Override verify command for `verify` op'),
    timeout_ms: pi.zod.number().optional().describe('Timeout (ms) for `verify` op subprocess'),
    recon_dims: pi.zod.any().optional().describe('Array of RECON-PLAN dimension objects (or JSON string). If omitted, read from autodev.yaml recon.dimensions'),
    sub_results: pi.zod.any().optional().describe('Map { dimId: subagentReturn } from recon fan-out (or JSON string)'),
    conf_threshold: pi.zod.number().optional().describe('Confidence threshold for solid vs revisit (default 0.55)'),
    max_pass: pi.zod.number().optional().describe('Max recon_pass before escalate (default 2)'),
  }),
  async execute(_toolCallId: string, params: any) {
    const p = params as any;
    const root: string = p.root || '.';
    try {
      switch (p.operation) {
        case 'init': {
          if (!p.autodev) return err('init requires `autodev` object');
          // 护栏集中在 initAutodev：已存在 autodev.yaml 且无 force 时拒绝盲覆盖，防静默清零。
          const r = initAutodev(root, p.autodev, { force: !!p.force });
          if (!r.ok) return err(r.error);
          appendJournal(root, { op: 'init', project: p.autodev?.project, slices: (p.autodev?.slices || []).length, force: !!p.force });
          return ok(`Initialized autodev state at ${r.path}`);
        }
        case 'read': {
          const doc = loadAutodev(root);
          return doc ? ok(JSON.stringify(doc, null, 2)) : ok(`No autodev.yaml at ${autodevPath(root)}`, { missing: true });
        }
        case 'read_gate': {
          // 上下文预算闸门：越界即拒绝返回内容（allowed:false），父必须 compact/handoff 或先驱逐再重试。
          const doc = loadAutodev(root);
          if (!doc) return err('ERR: no autodev.yaml (need contextBudget + modelMaxContext)');
          const budget = getContextBudget(doc);
          const modelMax = resolveModelMax(doc.modelMaxContext, p.model_max);
          let content = p.content;
          if (content === undefined && p.ref) {
            const fpa = path.join(root, p.ref);
            if (fs.existsSync(fpa)) content = fs.readFileSync(fpa, 'utf8');
          }
          if (content === undefined) return err('ERR: read_gate requires `content` or readable `ref` under root');
          const used = typeof p.used_tokens === 'number' ? p.used_tokens : 0;
          const decision = evaluateReadGate(used, estimateTokens(content), modelMax, budget);
          if (!decision.allowed) return ok(JSON.stringify(decision, null, 2), decision);
          return ok(JSON.stringify({ allowed: true, zone: decision.zone, projected: decision.projected }, null, 2) +
            '\n--- content ---\n' + content, decision);
        }
        case 'handoff': {
          // slice 边界交接：写 durable 落盘 .omp/autodev/handoffs/S{n}.md
          if (!p.slice_id) return err('ERR: handoff requires slice_id');
          let data: any;
          try {
            data = p.handoff_json ? JSON.parse(p.handoff_json) : {};
          } catch (e) {
            return err(`ERR: handoff_json invalid: ${(e as Error).message}`);
          }
          const fp = writeHandoff(root, p.slice_id, data);
          appendJournal(root, { op: 'handoff', slice_id: p.slice_id });
          return ok(`Wrote handoff at ${fp}`);
        }
        case 'read_slice': {
          if (!p.slice_id) return err('ERR: read_slice requires slice_id');
          const s = loadSlice(root, p.slice_id);
          return s ? ok(JSON.stringify(s, null, 2)) : ok(`No slice ${p.slice_id} at ${slicePath(root, p.slice_id)}`, { missing: true });
        }
        case 'transition_task': {
          if (!p.slice_id || !p.task_id || !p.to_status) return err('ERR: transition_task requires slice_id, task_id, to_status');
          const s = loadSlice(root, p.slice_id);
          if (!s) return err(`ERR: no slice ${p.slice_id}`);
          transitionTask(s, p.task_id, p.to_status, { reason: p.reason, blocked_by: p.blocked_by });
          saveSliceAndSyncParent(root, s);
          appendJournal(root, { op: 'transition_task', slice_id: p.slice_id, task_id: p.task_id, to_status: p.to_status });
          return ok(`slice ${p.slice_id} task ${p.task_id} -> ${p.to_status}`);
        }
        case 'set_gate': {
          if (!p.gate_scope || !p.gate_id || !p.gate_status) return err('ERR: set_gate requires gate_scope, gate_id, gate_status');
          if (p.gate_scope === 'slice_ac') {
            if (!p.slice_id) return err('ERR: slice_ac requires slice_id');
            const s = loadSlice(root, p.slice_id);
            if (!s) return err(`ERR: no slice ${p.slice_id}`);
            const ac = (s.acceptance_criteria || []).find((a: any) => a.id === p.gate_id);
            if (!ac) return err(`ERR: no AC ${p.gate_id} in slice ${p.slice_id}`);
            ac.status = p.gate_status;
            saveSliceAndSyncParent(root, s);
            appendJournal(root, { op: 'set_gate', gate_scope: 'slice_ac', gate_id: p.gate_id, gate_status: p.gate_status });
            return ok(`slice ${p.slice_id} AC ${p.gate_id} -> ${p.gate_status}`);
          } else {
            const doc = loadAutodev(root);
            if (!doc) return err('ERR: no autodev.yaml');
            const item = (doc.gate?.final_standard || []).find((a: any) => a.id === p.gate_id);
            if (!item) return err(`ERR: no final_standard item ${p.gate_id}`);
            item.status = p.gate_status;
            saveAutodev(root, doc);
            appendJournal(root, { op: 'set_gate', gate_scope: 'final_standard', gate_id: p.gate_id, gate_status: p.gate_status });
            return ok(`final_standard ${p.gate_id} -> ${p.gate_status}`);
          }
        }
        case 'replan': {
          if (!p.slice_id) return err('ERR: replan requires slice_id');
          const s = loadSlice(root, p.slice_id);
          if (!s) return err(`ERR: no slice ${p.slice_id}`);
          const max = (loadAutodev(root)?.max_replans) ?? 3;
          const r = replan(s, max);
          saveSliceAndSyncParent(root, s);
          appendJournal(root, { op: 'replan', slice_id: p.slice_id, action: r.action, attempts: r.attempts });
          return ok(`slice ${p.slice_id} replan -> ${JSON.stringify(r)}`, r);
        }
        case 'check_slice_gate': {
          // ④ SLICE 门：依据 task/AC 当前状态推导并落盘 slice.stage，
          // 全 done+全 pass → done，并同步父 autodev.yaml 的 slices[].stage（否则 ⑤ 永远 false）。
          if (!p.slice_id) return err('ERR: check_slice_gate requires slice_id');
          const s = loadSlice(root, p.slice_id);
          if (!s) return err(`ERR: no slice ${p.slice_id}`);
          const g = reconcileSliceStage(s);
          saveSliceAndSyncParent(root, s);
          appendJournal(root, { op: 'check_slice_gate', slice_id: p.slice_id, stage: s.stage, pass: g.pass });
          const detail = { stage: s.stage, pass: g.pass, missing: g.missing };
          if (g.pass) return ok(`slice ${p.slice_id} gate PASSED -> stage:done (synced to parent)`, detail);
          return ok(`slice ${p.slice_id} gate NOT passed -> stage:${s.stage}; missing: ${g.missing.join('; ')}`, detail);
        }
        case 'set_slice_stage': {
          // 显式推进 slice 阶段（executing/verifying 等），同步父索引。
          // 注意：stage:done 应优先由 check_slice_gate 落盘（带门控判定），此处仅作显式推进/纠偏。
          if (!p.slice_id || !p.slice_stage) return err('ERR: set_slice_stage requires slice_id, slice_stage');
          if (!SLICE_STAGES.includes(p.slice_stage)) return err(`ERR: invalid slice_stage ${p.slice_stage}`);
          const s = loadSlice(root, p.slice_id);
          if (!s) return err(`ERR: no slice ${p.slice_id}`);
          s.stage = p.slice_stage;
          saveSliceAndSyncParent(root, s);
          appendJournal(root, { op: 'set_slice_stage', slice_id: p.slice_id, stage: p.slice_stage });
          return ok(`slice ${p.slice_id} stage -> ${p.slice_stage}`);
        }
        case 'build_standard': {
          const doc = loadAutodev(root);
          if (!doc) return err('ERR: no autodev.yaml');
          const std = buildFinalStandard(doc);
          // 门控不变式：R2 若删了 mandatory/seed，这里自动补回并提示（硬保障，不再是纯 prompt 期望）。
          const inv = validateGateInvariants(doc);
          saveAutodev(root, doc);
          appendJournal(root, { op: 'build_standard', count: std.length, invariant_restored: inv.restored });
          const warn = inv.restored.length
            ? `; GATE INVARIANT RESTORED ${inv.restored.join(', ')} (R2 may have dropped mandatory/seed)`
            : '';
          return ok(`final_standard built (${std.length} items)${warn}`, { items: std, invariant: inv });
        }
        case 'final_check': {
          const doc = loadAutodev(root);
          if (!doc) return err('ERR: no autodev.yaml');
          const r = checkFinalGate(doc);
          return ok(JSON.stringify(r, null, 2), r);
        }
        case 'write_local': {
          // §9 双写：把重产物落到 durable artifacts/，返回 durable + session(local://) 双 ref。
          if (!p.content || !p.ref) return err('ERR: write_local requires content + ref (filename)');
          const name = p.ref.replace(/^local:\/\//, '').replace(/[^\w.\-\/]/g, '_');
          const art = writeArtifact(root, name, p.content);
          appendJournal(root, { op: 'write_local', ref: art.durableRef, local: art.local });
          return ok(`durable artifact written: ${art.durableRef} (session ref ${art.local})`, art);
        }
        case 'journal': {
          // 读取 run.json 事件日志（resume 审计用）
          const j = readJournal(root);
          return ok(JSON.stringify(j, null, 2), j);
        }
        case 'resume': {
          // 给 compact/handoff 后的新会话一个"从哪继续"的事实集
          const r = resumeState(root);
          return ok(JSON.stringify(r, null, 2), r);
        }
        case 'verify': {
          // 真正执行 verify 命令（machine 类），据退出码判定；不采信 subagent 自报。
          if (!p.gate_id) return err('ERR: verify requires gate_id');
          const res = runVerify(root, {
            gate_id: p.gate_id,
            slice_id: p.slice_id,
            verify_cmd: p.verify_cmd,
            timeout_ms: p.timeout_ms,
          });
          if (!res.ok) return err(`ERR: verify failed: ${res.error}`);
          return ok(
            `gate ${p.gate_id} kind=${res.kind} ran=${res.ran} exit=${res.exit} status=${res.status}\n` +
            `artifact=${res.artifact}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
            res,
          );
        }
        case 'recon_score': {
          // RECON 维度置信度打分 + 路由（见 autodev-design.md §11 "维度置信度打分"）。
          let dims: any[];
          let subResults: Record<string, any> = {};
          if (p.recon_dims !== undefined) {
            try { dims = typeof p.recon_dims === 'string' ? JSON.parse(p.recon_dims) : p.recon_dims; }
            catch (e) { return err(`ERR: recon_dims invalid JSON: ${(e as Error).message}`); }
          } else {
            const doc = loadAutodev(root);
            if (!doc) return err('ERR: no autodev.yaml; pass `recon_dims` or init first');
            dims = doc.recon?.dimensions || [];
          }
          if (!Array.isArray(dims)) return err('ERR: recon_dims must be an array');
          if (p.sub_results !== undefined) {
            try { subResults = typeof p.sub_results === 'string' ? JSON.parse(p.sub_results) : p.sub_results; }
            catch (e) { return err(`ERR: sub_results invalid JSON: ${(e as Error).message}`); }
          }
          const opts = {
            threshold: typeof p.conf_threshold === 'number' ? p.conf_threshold : 0.55,
            maxPass: typeof p.max_pass === 'number' ? p.max_pass : 2,
          };
          const scored = scoreReconDimensions(dims, subResults);
          const groups = classifyReconConfidence(scored, opts);
          // 写回 autodev.yaml 的 recon.dimensions（携带 confidence / evidence_status / recon_pass）
          const doc = loadAutodev(root);
          if (doc) {
            doc.recon = doc.recon || {};
            doc.recon.dimensions = scored;
            saveAutodev(root, doc);
          }
          appendJournal(root, {
            op: 'recon_score',
            solid: groups.solid.length, revisit: groups.revisit.length, escalate: groups.escalate.length,
          });
          return ok(JSON.stringify({ scored, groups }, null, 2), { scored, groups });
        }
        default:
          return err(`ERR: unknown operation ${p.operation}`);
      }
    } catch (e: any) {
      return err(`autodev tool error: ${e?.message || String(e)}`);
    }
  },
});

export default factory;
