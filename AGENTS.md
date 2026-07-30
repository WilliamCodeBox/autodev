# autodev Project Guidelines

## Architecture Design Preferences

**Don't add entities. Cut to the bone.** Nothing stays because "it might be useful later." YAML indexing, atomic dual-write, progressive disclosure layers -- anything "nice but not needed" gets cut. The only retention criterion is: it can't be done without it.

**Runtime state != project artifacts.** `.omp/` is machine state, not meant for human reading; `docs/` is human deliverable, versioned and browsable. Mixing them is a design error.

**Feature boundaries must be sharp.** The difference between ADR and DESIGN output, between ADR and run.json, between ADR and recon records -- each must be explainable in one sentence. If not, the responsibility is wrong.

**Default answer for new features is "no."** Every new tool operation, trigger point, or index must pass adversarial scrutiny to prove it's indispensable.

**Code must be clearly covered by tests.** Not just functions passing, but boundary conditions (missing params, empty lists, no init state) and invariants written into test files, running alongside existing tests.

**Prompts are as important as code.** The usage guide in SKILL.md is an LLM behavior contract, not a comment -- it defines when and on what basis the LLM should make judgments, equal in importance to validation in code.

## Verification Methodology

autodev's reliability depends on two layers: state machine hard logic (deterministic verification) + LLM prompt adherence (adversarial review).

### Two-Axis Testing

#### Axis 1: Code Correctness (Deterministic Verification)
**What it tests**: YAML read/write in autodev-state.mjs, task transition edges, slice stage advancement, replan limits, HITL/HOTL gating, context budget guardrails.

**How**: Uses real lib, runs real YAML I/O under `fs.mkdtempSync()`, driven by operation sequences (init -> transitionTask -> replan -> checkSliceGate -> checkFinalGate), asserting disk state at each step.

**Why**: The state lib is the same code loaded by the omp runtime (no mocks), the on-disk YAML format is identical to runtime -- testing "how it actually runs."

#### Axis 2: Prompt Constraint (Adversarial Review)
**What it tests**: Whether the LLM strictly follows autodev command step order (RECON-PLAN -> RECON -> PLAN -> SLICE EXECUTE -> FINAL), without skipping steps, missing steps, or inventing non-existent operations.

**How**, two layers:
1. **End-to-end** (06-e2e-omp): `omp -p` runs a minimal autodev task, verifying state files are correctly written (extension loads, tools callable). Minimum passing condition.
2. **Adversarial review** (`--omp` flag): collects a state bundle (YAML + run.json + logs) -> calls `omp -p` to fan out to N isolated subagents, each auditing one dimension (state machine legality, YAML completeness, gate correctness, boundary conditions), returning a JSON verdict.

**Why use LLM to review LLM**: Prompt constraints are a semantic problem -- "does the model understand and follow the given procedure." The most economical way to judge is to have another model examine the output from an adversarial perspective, finding "should have but doesn't" evidence.

## 8-Scenario Coverage Matrix

| Scenario | Axis | Coverage |
|----------|------|----------|
| happy-path | Code | init -> slice -> task -> reconcile -> final gate full cycle, recon preserved, parent stage synced |
| blocked-replan | Code | doing -> blocked -> replan (attempts++) -> exceeded -> paused, disk persistence |
| hitl-mode | Code | establishMode three-layer mutual exclusion, pending gate hard block (hitl.pending_gates), approve unblock |
| gate-invariants | Code | R2 deletes mandatory -> validateGateInvariants restores, idempotent |
| hotl-steer | Code | steer -> poll -> pause -> resume -> cancel, loop_state derivation |
| e2e-omp | Prompt | `omp -p` runs autodev (auto-skips without omp) |
| context-budget | Code | three-zone, readGate hard reject, LRU eviction + pinned protection |
| prompt-regression | Prompt | LLM adherence to prompt contract: dual-channel, mandatory invariants, schema output (eval cell) |

## Running

```bash
node tests/run-integration.mjs              # Axis 1: all scenarios
node tests/run-integration.mjs --omp        # Axis 1 + Axis 2
node tests/run-integration.mjs --only=X     # Filter by scenario
node tests/run-integration.mjs --list       # List scenarios
node tests/test-state.mjs                   # Unit tests
node tests/test-prompts.mjs                 # Prompt structure tests (milliseconds)
node tests/test-prompts-consistency.mjs     # Prompt cross-consistency tests (milliseconds)
# Behavioral tests run in eval cells (see tests/prompt-behavior.mjs)
```

## Git Convention
- **Force push is forbidden** (`git push --force`). History must be linearly traceable.
- All remote branch conflicts resolved via rebase or merge -- never overwrite remote history.
