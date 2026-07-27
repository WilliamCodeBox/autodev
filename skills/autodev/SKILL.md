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

## Core loop
1. **RECON-PLAN** — fan-out (workflow) N isolated subagents to *propose* recon dimensions from
   goal + developer_seed + base-taxonomy *candidates*; synthesize `dimensions[]`. Not hardcoded.
2. **RECON** — one isolated recon subagent per dimension → structured dossier (file:line evidence).
3. **PLAN** — TwoRoundGate forms the top-level plan's acceptance standard (R1 draft → R2 adversarial);
   `mandatory` (compile/build/test) is force-merged, R2 cannot remove it. Split into slices.
4. **SLICE EXECUTE** — orchestrate per slice: 2-round detailed design, then Implement→Verify stages;
   tasks managed via the `autodev` tool (todo→doing→done; blocked writes reason).
5. **FINAL** — build_standard + final_check; all pass → DONE, else reopen slice.

## TwoRoundGate (plan / per-slice design / acceptance)
R1: fan-out isolated subagents draft gates (machine + llm_judge) → parent synthesizes proposal.
R2: fan-out isolated subagents find loopholes → parent finalizes. Force-merge mandatory.

## YAML state
- `.omp/autodev/autodev.yaml`: `goal, max_replans, recon.dimensions, gate{mandatory,developer_seed,derived,final_standard}, slices[]`.
- `.omp/autodev/slices/<id>.yaml`: `slice_id, stage, replan_attempts, acceptance_criteria[], tasks[]`.

## autodev tool operations
`init | read | read_slice | transition_task | set_gate | replan | build_standard | final_check`
(root defaults to "."). Example:
`autodev(operation="transition_task", slice_id="S1", task_id="T2", to_status="done")`
`autodev(operation="replan", slice_id="S1")` → `{action:"replan"|"paused", attempts}`

## References in this extension
- `design/recon-synth.ts` — RECON-PLAN prompt + schema builders (design-only, not in offline package).
- `design/tworound-gate.ts` — TwoRoundGate prompt + schema builders (design-only).
- `tools/autodev/lib/autodev-state.mjs` — state machine core (verified by `tools/autodev/lib/test-state.mjs`).
- `tools/autodev/index.ts` — the custom tool (self-contained: lib inlined under `tools/autodev/lib/`).
- `commands/autodev.md` — the `/autodev` command (main-loop prompt, markdown form).

## Design rationale (why not hardcode recon)
Dynamic decomposition beats static templates on task-variance (Microsoft Agent Framework);
"let the model list what to investigate" is the proven PLAN stage of repo-scout. So recon
dimensions are a *generated product*, auditable in `autodev.yaml`, not a constant.
