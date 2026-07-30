---
name: autodev
description: >
  Autonomous software-development loop for oh-my-pi. Given a goal + initial acceptance
  intent, it drives LLM-decided recon -> 2-round plan/design/acceptance gating ->
  orchestrated slice execution -> YAML state gates -> final acceptance. Load when the
  user wants autodev to "auto-complete and verify" a refactor / rewrite / new-feature task,
  or when extending/writing the autodev keyword.
---

# autodev

A thin orchestration layer on top of oh-my-pi's `workflow` (recon fan-out) and `orchestrate`
(staged execution) primitives. It adds: (a) **LLM-driven recon dimensions** (no hardcoding),
(b) a reusable **TwoRoundGate** primitive for plan/design/acceptance, (c) **YAML state management**
with todo/doing/blocked/done + slice gates, (d) a **blocked → replan (≤3) → PAUSED** policy.

## When to use
- User says "autodev <goal>", or asks to autonomously finish + verify a coding task.
- Scenarios: code refactor, code rewrite, new-feature R&D.
- Extending the autodev keyword itself (state tool, gate logic, recon synthesis).
- Intervention modes: `/autodev hitl` (human-in-the-loop, pause at approval points) or
  `/autodev hotl` (human-on-the-loop, agent autonomous + human may steer/pause); `/autodev`
  alone = fully autonomous (auto).

## Core loop
1. **RECON-PLAN** — fan-out (workflow) N isolated subagents to *propose* recon dimensions from
   goal + developer_seed + base-taxonomy *candidates*; synthesize `dimensions[]`. Not hardcoded.
2. **RECON** — one isolated recon subagent per dimension → structured dossier (file:line evidence).
3. **PLAN** — TwoRoundGate forms the top-level plan's acceptance standard (R1 draft → R2 adversarial);
   `mandatory` (compile/build/test) is force-merged, R2 cannot remove it. Split into slices.
4. **SLICE EXECUTE** — orchestrate per slice: 2-round detailed design, then Implement→Verify stages;
   tasks managed via the `autodev` tool (todo→doing→done; blocked writes reason).
5. **FINAL** — build_standard + final_check; all pass → DONE, else reopen slice.

## Modes (干预策略层)
autodev 的三种模式是同一核心循环上叠加的"人类干预策略层"——核心循环零分叉、状态机单一权威。
模式由 `/autodev` 入口的首词决定（`$ARGUMENTS` 分发），全部走同一个 `commands/autodev.md`：

- **auto**（`/autodev`）：无人工干预，Agent 自治跑完 RECON→PLAN→SLICE EXECUTE→FINAL。
- **HITL / 人在环**（`/autodev hitl`）：四个审批点暂停等人裁决——`plan_approval` / `slice_pre_exec` /
  `verify_failure` / `final_acceptance`（默认关，需 `config gates.final_acceptance=true` 开启）。控制面：
  `/autodev gate <id> accept|deny|force [reason]`。未裁决 gate 存在时，
  `transition_task` / `set_gate`(slice_ac) / `check_slice_gate` 返回 `BLOCKED_BY_PENDING_GATE`
  （状态级硬阻塞，P0-3）。
- **HOTL / 人在环上**（`/autodev hotl`）：Agent 自治，人类监控 + 随时介入。控制面：
  `/autodev steer <text>`、`/autodev lifecycle pause|resume|cancel`、`/autodev status`。
  steer 在工具层吸收点（transition_task / check_slice_gate / replan 内）自动消费（P0-4）；
  replan 超限收敛到 `hotl.loop_state=paused`，人类用 `/autodev lifecycle resume` 继续（P0-5/6）。

模式语义统一（P0-7）：`mode` 仅作命令来源标记；HOTL 激活唯一由 `hotl.mode=supervised` 决定；两干预层互斥；
`/autodev` 入口显式置位清除上次 yaml 残留。

## TwoRoundGate (plan / per-slice design / acceptance)
R1: fan-out isolated subagents draft gates (machine + llm_judge) → parent synthesizes proposal.
R2: fan-out isolated subagents find loopholes → parent finalizes. Force-merge mandatory.

## YAML state
- `.omp/autodev/autodev.yaml`: `goal, max_replans, recon.dimensions, gate{mandatory,developer_seed,derived,final_standard}, slices[]`.
- `.omp/autodev/slices/<id>.yaml`: `slice_id, stage, replan_attempts, acceptance_criteria[], tasks[]`.

## autodev tool operations
(root defaults to ".").
Core ops: `init | read | read_slice | transition_task | set_gate | replan | build_standard | final_check | check_slice_gate | set_slice_stage | verify | recon_score | handoff | write_local | journal | resume | read_gate`.
Intervention-layer ops: `set_mode | hitl_request | hitl_respond | hitl_status | hitl_config | hotl_init | hotl_steer | hotl_poll | hotl_pause | hotl_resume | hotl_cancel | hotl_status | hotl_dashboard`.
Examples:
`autodev(operation="transition_task", slice_id="S1", task_id="T2", to_status="done")`
`autodev(operation="replan", slice_id="S1")` → `{action:"replan"|"paused", attempts}`
`autodev(operation="hitl_respond", gate_id="hitl:plan_approval:S1:...", decision="approve")`
`autodev(operation="hotl_steer", steer_kind="resume", scope="slice:S1", note="unblock and continue")`

## References in this extension
- `src/design/recon-synth.ts` — RECON-PLAN prompt + schema builders (design-only, not in offline package).
- `src/design/tworound-gate.ts` — TwoRoundGate prompt + schema builders (design-only).
- `tools/autodev/lib/autodev-state.mjs` — state machine core (verified by `tests/test-state.mjs`); holds P0-7 mode helpers + P0-8 atomic write + P0-3 reconcile guard.
- `tools/autodev/lib/hitl-gates.mjs` — HITL approval-point + adjudication logic (verified by `tests/test-hitl.mjs`).
- `tools/autodev/lib/hotl-steer.mjs` — HOTL monitor/control + tool-layer steer absorption (verified by `tests/test-hotl.mjs`).
- `tools/autodev/index.ts` — the custom tool (self-contained: lib inlined under `tools/autodev/lib/`); wires 13 intervention ops + P0-4/5 guards into transition_task/check_slice_gate/replan.
- `commands/autodev.md` — the `/autodev` command (main-loop prompt + subcommand dispatch, markdown form).
- `autodev-design.md` (repo root, v7) — full architecture. `autodev-subcommands-design.md` (repo root) — HITL/HOTL subcommand design (consolidated). `HOTL-design.md` / `autodev-hitl-design.md` (repo root) — per-layer detail.

## Design rationale (why not hardcode recon)
Dynamic decomposition beats static templates on task-variance (Microsoft Agent Framework);
"let the model list what to investigate" is the proven PLAN stage of repo-scout. So recon
dimensions are a *generated product*, auditable in `autodev.yaml`, not a constant.
