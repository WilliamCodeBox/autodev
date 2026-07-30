# Key Design Decisions

## Why dynamic (not hardcoded) reconnaissance dimensions

Dynamic decomposition adapts better to task variance than static templates. "Let the LLM decide what to investigate" is a proven PLAN-stage strategy. Reconnaissance dimensions are generated artifacts, auditable in `autodev.yaml`, not constants.

## Why YAML instead of in-memory state

Persistent state supports crash recovery, audit trails, and asynchronous collaboration (multiple people see the same YAML). Once the orchestration target shifts from "call stack / event stream" to "state machine", there must be a **queryable, assertable, recoverable** source of truth. YAML snapshots + run.json append-only logs provide both snapshot recovery and historical replay -- the same pattern as database WAL + checkpoint.

## Why separate parent-agent and subagent tools

The parent agent sees state operation tools (transition task, advance stage, gates), while subagents see file operation tools. This layering prevents a single LLM from operating both state and files at the same time, avoiding the confused deputy problem.

## Why context budget is a hard tool-level gate, not model self-awareness

Models won't self-reject. Only a tool can intercept at load time. `evaluateReadGate` is a pure function, testable -- it doesn't depend on the model's "judgment."

## Why HITL/HOTL are not two separate codebases

All three modes share the same core loop. Core logic (state machine transitions, gate advancement, replan) is tested once, and there's no risk of "auto fixed a bug but the hitl branch forgot it."

## Limitations

| # | Limitation | Impact |
|---|-----------|--------|
| 1 | **No sandbox isolation** | Code execution relies on omp's process isolation; cannot run untrusted code |
| 2 | **No event-driven entry** | Fully manual `/autodev` startup; no GitHub webhook / CI integration |
| 3 | **Single-model routing** | All phases use the same model; no tiered routing (small model for recon, large model for design) |
| 4 | **No PR/Git workflow** | No auto commit/PR after verify passes; results stay as local file modifications |
| 5 | **No conversational correction** | HITL is approval-style (accept/deny/force), not interactive edit-by-conversation |
| 6 | **Bound to omp framework** | Cannot be used independently |
