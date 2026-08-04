// tools/autodev/index.ts
// oh-my-pi 自定义 tool：autodev 状态/YAML/门控管理。
// 这是 autodev 的"薄编排层"里唯一新增的运行时能力；编排本身交给 workflow/orchestrate 原语。
//
// 格式要点（与 omp 真实加载对齐）：
//   - 通过 omp 注入的 `pi.zod` 收参，无外部依赖（裸 tools/ 目录 omp 不保证解析得到 npm 包）。
//   - 返回值必须是 { content:[{type:'text',text}], details, isError }，不能返回裸字符串。
//   - YAML 解析/序列化用 ./lib/js-yaml.mjs（vendored ESM 构建，无 npm 依赖，离线可解析）。
import fs from 'node:fs';
import path from 'node:path';
import {
  loadAutodev, saveAutodev, loadSlice, saveSlice, initAutodev,
  transitionTask, replan, checkFinalGate, buildFinalStandard,
  autodevPath, slicePath,
  estimateTokens, resolveModelMax, evaluateReadGate, getContextBudget, writeHandoff,
  writeArtifact, readArtifact, readJournal, appendJournal, resumeState, runVerify,
  saveSliceAndSyncParent, reconcileSliceStage, validateGateInvariants, SLICE_STAGES,
  establishMode, isHotlActive, isPaused, isWaiting, sliceHasPendingGate, clearHitlResidual,
  appendADR,
} from './lib/autodev-state.mjs';
import { scoreReconDimensions, classifyReconConfidence } from './lib/recon-score.mjs';
import {
  hitlRequest, hitlRespond, hitlStatus, hitlConfig, applyTimeoutPolicy,
  classifyMachineGate,
} from './lib/hitl-gates.mjs';
import {
  hotlInit, hotlSteer, hotlPoll, hotlPause, hotlResume, hotlCancel, hotlStatus, hotlDashboard,
  convergeToPaused, absorbSteer,
} from './lib/hotl-steer.mjs';

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
      // 干预策略层（HITL / HOTL）—— autodev-subcommands-design.md
      'set_mode',
      'hitl_request', 'hitl_respond', 'hitl_status', 'hitl_config',
      'hotl_init', 'hotl_steer', 'hotl_poll', 'hotl_pause', 'hotl_resume',
      'hotl_cancel', 'hotl_status', 'hotl_dashboard',
      // ADR —— 架构决策记录（项目级产出，非流程历史）
      'adr_append',
    ]),
    root: pi.zod.string().optional().describe('Project root, default "."'),
    autodev: pi.zod.any().optional().describe('Full autodev.yaml object for init'),
    force: pi.zod.boolean().optional().describe('init: if true, overwrite existing autodev.yaml (default refuse to avoid silent state wipe)'),
    slice_id: pi.zod.string().optional(),
    slice_stage: pi.zod.enum(SLICE_STAGES as any).optional().describe('set_slice_stage: new stage for the slice (incl. awaiting_human / cancelled)'),
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
    // ---- 干预策略层参数（HITL / HOTL）----
    mode: pi.zod.enum(['auto', 'hitl', 'hotl']).optional().describe('set_mode: establish run mode and clear prior intervention-layer residual (P0-7)'),
    gate: pi.zod.enum(['plan_approval', 'slice_pre_exec', 'verify_failure', 'final_acceptance']).optional().describe('hitl_request: which approval point'),
    sensitivity: pi.zod.enum(['numerical_risk', 'mpi_boundary']).optional().describe('hitl_request: P1-2 high-sensitivity flag; advisory timeout will NOT auto-approve these gates'),
    decision: pi.zod.enum(['approve', 'reject', 'modify', 'override']).optional().describe('hitl_respond: human adjudication'),
    note: pi.zod.string().optional().describe('hitl_respond: human note; or hotl_steer text for a steer directive'),
    hitl_patch: pi.zod.any().optional().describe('hitl_config: { enabled, mode, default_timeout_sec, gates, max_wait_sec } patch object'),
    steer_kind: pi.zod.enum(['steer', 'pause', 'resume', 'cancel']).optional().describe('hotl_steer: directive kind'),
    steer_scope: pi.zod.string().optional().describe('hotl_steer: "run" | "slice:<id>" | "task:<sliceId>:<taskId>"'),
    scope: pi.zod.string().optional().describe('hotl_steer: alias for steer_scope (accepted for convenience)'),
    steer_intent: pi.zod.enum(['low', 'medium', 'high']).optional().describe('hotl_steer: P1-8 structured impact (LLM-judged, written back); medium/high forces re-confirm journal'),
    steer_touches_done: pi.zod.boolean().optional().describe('hotl_steer: P1-9 global(run) steers of kind=steer MUST declare whether they touch done dimensions; omit => conflict'),
    // ---- ADR 参数字段（adr_append）----
    adr_title: pi.zod.string().optional().describe('adr_append: 架构决策标题'),
    adr_context: pi.zod.string().optional().describe('adr_append: 触发此决策的上下文'),
    adr_decision: pi.zod.string().optional().describe('adr_append: 决策描述（选择什么，不选什么）'),
    adr_consequences: pi.zod.array(pi.zod.string()).optional().describe('adr_append: 后果数组（好处、代价、风险）'),
    adr_origin: pi.zod.string().optional().describe('adr_append: 来源（DESIGN / HITL / MANUAL）'),
    adr_decider: pi.zod.enum(['autodev', 'human']).optional().describe('adr_append: 决策者'),
    retry: pi.zod.number().optional().describe('verify: retry count for this gate, used by P1-3 critical-machine-gate classification'),
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
          // P0-3 硬阻塞：本 slice 存在未裁决 HITL gate 时，拒绝推进任何 task。
          const docTT = loadAutodev(root);
          // P1-2：HOTL paused 时拒绝所有状态推进（机器强制，非 prompt 咨询）。
          if (docTT && isPaused(docTT)) return err(`LOOP_PAUSED: HOTL is paused; all state mutations blocked until hotl_resume`);
          if (docTT && sliceHasPendingGate(docTT, p.slice_id)) {
            const ids = (docTT.hitl.pending_gates || [])
              .filter((g: any) => !g.resolved && g.scope !== 'final' && g.slice_id === p.slice_id)
              .map((g: any) => g.id);
            return err(`BLOCKED_BY_PENDING_GATE: slice ${p.slice_id} has unresolved HITL gate(s) ${ids.join(', ')}; call hitl_respond first`);
          }
          // P1-12：HOTL 下禁止对 done task 任何迁移（含 done→blocked，叙事上 done 不可回退）。
          const curTask = (s.tasks || []).find((t: any) => t.id === p.task_id);
          if (docTT && isHotlActive(docTT) && curTask && curTask.status === 'done') {
            return err(`HOTL_FORBID_DONE_TRANSITION: task ${p.task_id} is 'done'; under HOTL no transition on done tasks is allowed (narrative: done does not roll back)`);
          }
          transitionTask(s, p.task_id, p.to_status, { reason: p.reason, blocked_by: p.blocked_by });
          // P0-4 吸收点：HOTL 人类 steer 在 task 迁移后消费（不靠 LLM 自觉）。
          if (docTT && isHotlActive(docTT)) {
            const absorbed = absorbSteer(root, docTT, s);
            if (absorbed.applied.length || absorbed.conflicts.length) {
              appendJournal(root, { op: 'transition_task_absorb', slice_id: p.slice_id, applied: absorbed.applied.map((a: any) => a.steer_id), conflicts: absorbed.conflicts.map((c: any) => c.steer_id) });
            }
          }
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
            // P0-3 硬阻塞：pending HITL gate 存在时禁止改 AC 状态（override 走 hitl_respond）。
            const docSG = loadAutodev(root);
            // P1-2：HOTL paused 时拒绝所有状态推进。
            if (docSG && isPaused(docSG)) return err(`LOOP_PAUSED: HOTL is paused; all state mutations blocked until hotl_resume`);
            if (docSG && sliceHasPendingGate(docSG, p.slice_id)) {
              const ids = (docSG.hitl.pending_gates || [])
                .filter((g: any) => !g.resolved && g.scope !== 'final' && g.slice_id === p.slice_id)
                .map((g: any) => g.id);
              return err(`BLOCKED_BY_PENDING_GATE: slice ${p.slice_id} has unresolved HITL gate(s) ${ids.join(', ')}; call hitl_respond first`);
            }
            const ac = (s.acceptance_criteria || []).find((a: any) => a.id === p.gate_id);
            if (!ac) return err(`ERR: no AC ${p.gate_id} in slice ${p.slice_id}`);
            // P0-2 硬校验：machine gate（含 verify 命令）写 pass 必须有 runVerify 的时间戳证据。
            // llm_judge 或纯人工裁决（无 verify 命令）无需 verified_at——这两类不依赖机器验证。
            if (p.gate_status === 'pass' && ac.verify && !ac.verified_at) {
              return err(`ERR: machine gate ${p.gate_id} has verify command but no verified_at timestamp — call verify first, then set_gate based on exit code`);
            }
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
          const docRP = loadAutodev(root);
          const max = (docRP?.max_replans) ?? 3;
          const r = replan(s, max);
          // P0-4 吸收点：replan 也是 HOTL 吸收点（人类可能在重规划前/中下发 steer）。
          if (docRP && isHotlActive(docRP)) {
            const absorbed = absorbSteer(root, docRP, s);
            if (absorbed.applied.length || absorbed.conflicts.length) {
              appendJournal(root, { op: 'replan_absorb', slice_id: p.slice_id, applied: absorbed.applied.map((a: any) => a.steer_id), conflicts: absorbed.conflicts.map((c: any) => c.steer_id) });
            }
          }
          saveSliceAndSyncParent(root, s);
          appendJournal(root, { op: 'replan', slice_id: p.slice_id, action: r.action, attempts: r.attempts });
          // P0-5：HOTL 激活时，核心状态机置 slice=paused 仅到 slice 级；编排层在此收敛 loop_state=paused + 通知。
          if (r.action === 'paused' && docRP && isHotlActive(docRP)) {
            convergeToPaused(root, `slice ${p.slice_id} hit replan limit (${r.attempts}/${max})`);
          }
          return ok(`slice ${p.slice_id} replan -> ${JSON.stringify(r)}`, r);
        }
        case 'check_slice_gate': {
          // ④ SLICE 门：依据 task/AC 当前状态推导并落盘 slice.stage，
          // 全 done+全 pass → done，并同步父 autodev.yaml 的 slices[].stage（否则 ⑤ 永远 false）。
          if (!p.slice_id) return err('ERR: check_slice_gate requires slice_id');
          const s = loadSlice(root, p.slice_id);
          if (!s) return err(`ERR: no slice ${p.slice_id}`);
          // P0-3 硬阻塞：pending HITL gate 存在时，禁止 reconcile 推进到 done。
          const docCSG = loadAutodev(root);
          // P1-2：HOTL paused 时拒绝所有状态推进。
          if (docCSG && isPaused(docCSG)) return err(`LOOP_PAUSED: HOTL is paused; all state mutations blocked until hotl_resume`);
          if (docCSG && sliceHasPendingGate(docCSG, p.slice_id)) {
            const ids = (docCSG.hitl.pending_gates || [])
              .filter((g: any) => !g.resolved && g.scope !== 'final' && g.slice_id === p.slice_id)
              .map((g: any) => g.id);
            return err(`BLOCKED_BY_PENDING_GATE: slice ${p.slice_id} has unresolved HITL gate(s) ${ids.join(', ')}; call hitl_respond first`);
          }
          const g = reconcileSliceStage(s);
          // P0-4 吸收点：HOTL steer 在门控判定后消费。
          if (docCSG && isHotlActive(docCSG)) {
            const absorbed = absorbSteer(root, docCSG, s);
            if (absorbed.applied.length || absorbed.conflicts.length) {
              appendJournal(root, { op: 'check_slice_gate_absorb', slice_id: p.slice_id, applied: absorbed.applied.map((a: any) => a.steer_id), conflicts: absorbed.conflicts.map((c: any) => c.steer_id) });
            }
          }
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
          // P1-2：HOTL paused 时拒绝所有状态推进。
          const docSSS = loadAutodev(root);
          if (docSSS && isPaused(docSSS)) return err(`LOOP_PAUSED: HOTL is paused; all state mutations blocked until hotl_resume`);
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
          // P1-3：确定性"关键 machine 门"判定——machine 类 + 重试 >= 上限 + 退出码非 0
          // 视为 critical，必须停下发 verify_failure HITL，而非 flaky 疲劳式重试。
          const cls = classifyMachineGate({ kind: res.kind, retry: typeof p.retry === 'number' ? p.retry : (res.retry || 0), exitCode: res.exit });
          const criticalNote = cls.critical
            ? `\n[CRITICAL MACHINE GATE] ${cls.reason}. STOP and open HITL: autodev(operation="hitl_request", gate="verify_failure", slice_id="${p.slice_id || ''}").`
            : '';
          return ok(
            `gate ${p.gate_id} kind=${res.kind} ran=${res.ran} exit=${res.exit} status=${res.status}\n` +
            `classification: ${cls.critical ? 'CRITICAL' : 'non-critical'} — ${cls.reason}${criticalNote}\n` +
            `artifact=${res.artifact}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
            { ...res, classification: cls },
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
        // ===================================================================
        // 干预策略层：HITL / HOTL（autodev-subcommands-design.md）
        // 这些 op 不跑主循环，由 /autodev hitl <action> / /autodev hotl <verb> 直接调用。
        // ===================================================================
        case 'set_mode': {
          // 入口显式置位（P0-7）：清掉上次的干预层残留，消除 yaml 污染。
          const docSM = loadAutodev(root);
          if (!docSM) return err('ERR: no autodev.yaml; run init first');
          const m = p.mode || 'auto';
          establishMode(docSM, m);
          saveAutodev(root, docSM);
          appendJournal(root, { op: 'set_mode', mode: m });
          return ok(`mode established: ${m} (hotl.mode=${docSM.hotl.mode}, hitl.enabled=${!!docSM.hitl.enabled})`);
        }
        case 'hitl_request': {
          // 主循环在审批点调用：发起一个等待人类裁决的 gate（状态级硬阻塞）。
          const r = hitlRequest(root, { sliceId: p.slice_id, gate: p.gate, sensitivity: p.sensitivity });
          if (!r.ok) return err(`hitl_request failed: ${r.error}`);
          return ok(`HITL gate opened: ${JSON.stringify(r.gate, null, 2)}`, r);
        }
        case 'hitl_respond': {
          // 人类裁决：approve / reject / modify / override。
          if (!p.gate_id || !p.decision) return err('ERR: hitl_respond requires gate_id, decision');
          const r = hitlRespond(root, { gateId: p.gate_id, decision: p.decision, note: p.note, sliceId: p.slice_id });
          if (!r.ok) return err(`hitl_respond failed: ${r.error}`);
          return ok(`HITL gate ${p.gate_id} -> ${p.decision}${r.needs_replan ? ' (needs replan)' : ''}`, r);
        }
        case 'hitl_status': {
          // 查询 pending gate + 超时评估（advisory 自动放行）。
          const r = hitlStatus(root, p.gate_id);
          if (!r.ok) return err(`hitl_status failed: ${r.error}`);
          return ok(JSON.stringify(r, null, 2), r);
        }
        case 'hitl_config': {
          // 读写 hitl.* 配置（enabled / mode / gates / default_timeout_sec）。
          const r = hitlConfig(root, p.hitl_patch || {});
          if (!r.ok) return err(`hitl_config failed: ${r.error}`);
          return ok(`HITL config updated: ${JSON.stringify(r.hitl, null, 2)}`, r);
        }
        case 'hotl_init': {
          // 激活 HOTL（/autodev hotl 入口）：mode=supervised + 清 HITL 残留（P0-7）。
          // P1-10：探测 pi.sendMessage 是否在当前运行时可用，结果落 hotl.notify_capability，
          // 不支持时 dashboard 明示（避免静默死推）。
          const pushCap = typeof pi?.sendMessage === 'function' ? 'push' : 'unsupported';
          const r = hotlInit(root, { notify_capability: pushCap });
          if (!r.ok) return err(`hotl_init failed: ${r.error}`);
          const capNote = pushCap === 'unsupported'
            ? ' [NOTE: pi.sendMessage unavailable in this runtime — human must poll dashboard, no external push]'
            : ' [NOTE: external push enabled]';
          return ok(`HOTL activated (supervised); Agent runs autonomously, human monitors + may steer${capNote}`, r);
        }
        case 'hotl_steer': {
          // 记录人类 steer 指令（不直接执行，等下次 tool 层吸收点消费，P0-4）。
          if (!p.steer_kind || !p.note) return err('ERR: hotl_steer requires steer_kind and note (directive text)');
          const r = hotlSteer(root, {
            kind: p.steer_kind, text: p.note, scope: p.steer_scope ?? p.scope ?? 'run',
            intent: p.steer_intent, touches_done: p.steer_touches_done,
          });
          if (!r.ok) return err(`hotl_steer failed: ${r.error}`);
          const intentNote = r.steer.intent === 'medium' || r.steer.intent === 'high'
            ? ` (intent=${r.steer.intent} → requires human re-confirm at next checkpoint)` : '';
          return ok(`HOTL steer recorded: ${r.steer.id} (kind=${r.steer.kind}, scope=${r.steer.scope}, intent=${r.steer.intent})${intentNote}; absorbed at next tool transition`, r);
        }
        case 'hotl_poll': {
          // 监控快照：slice 阶段 + 未消费 steer + 通知（人类 dashboard 数据源）。
          const r = hotlPoll(root, p.steer_scope || 'run');
          if (!r.ok) return err(`hotl_poll failed: ${r.error}`);
          return ok(JSON.stringify(r, null, 2), r);
        }
        case 'hotl_pause': {
          const r = hotlPause(root);
          if (!r.ok) return err(`hotl_pause failed: ${r.error}`);
          // P1-6：强指令文本——机器已置 loop_state=paused，Agent 必须立即停下并等待人类。
          return ok(
            `HOTL loop PAUSED by human (loop_state=paused).\n` +
            `STRONG INSTRUCTION: you MUST stop all autonomous work now. Do not call transition_task/check_slice_gate/replan until hotl_resume. ` +
            `Re-poll status via autodev(operation="hotl_status").`, r);
        }
        case 'hotl_resume': {
          const r = hotlResume(root);
          if (!r.ok) return err(`hotl_resume failed: ${r.error}`);
          return ok(`HOTL loop RESUMED by human (loop_state=running). You may continue autonomous work.`, r);
        }
        case 'hotl_cancel': {
          const r = hotlCancel(root);
          if (!r.ok) return err(`hotl_cancel failed: ${r.error}`);
          // P1-6：强指令——取消是终态，Agent 必须终止运行。
          return ok(
            `HOTL run CANCELLED by human (loop_state=cancelled).\n` +
            `STRONG INSTRUCTION: terminate the run now. Do not issue further autodev operations except read/status.`, r);
        }
        case 'hotl_status': {
          const r = hotlStatus(root);
          if (!r.ok) return err(`hotl_status failed: ${r.error}`);
          return ok(JSON.stringify(r, null, 2), r);
        }
        case 'hotl_dashboard': {
          // 给人类 dashboard 用的精简卡片（纯数据）。
          const r = hotlDashboard(root);
          if (!r.ok) return err(`hotl_dashboard failed: ${r.error}`);
          return ok(JSON.stringify(r, null, 2), r);
        }
        case 'adr_append': {
          // 写一条 ADR markdown 到 docs/adr/，更新 autodev.yaml 的 adr.next_id。
          // 不维护 YAML 索引，不原子双写。
          if (!p.adr_title || !p.adr_decision) return err('ERR: adr_append requires adr_title and adr_decision');
          const cons = Array.isArray(p.adr_consequences) ? p.adr_consequences : (p.adr_consequences ? [p.adr_consequences] : []);
          const r = appendADR(root, {
            title: p.adr_title,
            context: p.adr_context || '',
            decision: p.adr_decision,
            consequences: cons,
            origin: p.adr_origin || 'manual',
            slice_id: p.slice_id,
            decider: p.adr_decider,
          });
          return ok(`ADR-${r.id} written: ${r.path}`);
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
