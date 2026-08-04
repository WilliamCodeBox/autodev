# Testing

autodev's reliability depends on two layers: state machine hard logic (deterministic verification) + LLM prompt adherence (adversarial review).

## Axis 1: Code Correctness (Deterministic Verification)

Runs under `fs.mkdtempSync()` with real YAML I/O, driven by operation sequences (init -> transitionTask -> replan -> checkSliceGate -> checkFinalGate), asserting disk state at each step. The state library is the same code loaded by the omp runtime (no mocks).

## Axis 2: Prompt Constraint (Adversarial Review)

Collects a state bundle (YAML + run.json + logs) -> fans out to N isolated subagents, each auditing one dimension (state machine legality, YAML completeness, gate correctness, boundary conditions), returning a JSON verdict.

Why use an LLM to review an LLM? Prompt constraints are a semantic problem -- "does the model understand and follow the given procedure." The most economical way to judge is to have another model examine the output from an adversarial perspective.

## Running Tests

```bash
# Run all integration tests (Axis 1)
node tests/run-integration.mjs

# Enable Axis 2 adversarial review (requires omp)
node tests/run-integration.mjs --omp

# List available scenarios
node tests/run-integration.mjs --list

# Run a specific scenario
node tests/run-integration.mjs --only=SceneName
```

## 9-Scenario Coverage Matrix

| Scenario | Axis | Coverage |
|----------|------|----------|
| happy-path | Code | init -> slice -> task -> reconcile -> final gate full cycle |
| blocked-replan | Code | doing -> blocked -> replan -> exceeded -> paused |
| hitl-mode | Code | three-layer mutual exclusion, pending gate hard block, approve unblock |
| gate-invariants | Code | R2 deletes mandatory -> validateGateInvariants restores |
| hotl-steer | Code | steer -> poll -> pause -> resume -> cancel |
| e2e-omp | Prompt | `omp -p` runs autodev (auto-skips without omp) |
| context-budget | Code | three-zone, readGate hard reject, LRU eviction |
| agent-frontmatter | Code | static check: name/tools/output schema, whitelist enforcement (test-agents.mjs) |
| tool-layer-hardening | Code | verified_at guard, isPaused blocking (test-state.mjs + test-hotl.mjs addenda) |

### Unit Tests (independent of omp)
```bash
node tests/test-agents.mjs     # agent frontmatter & whitelist (v1.1.0)
node tests/test-state.mjs      # state machine core + verified_at (v1.1.0)
node tests/test-hotl.mjs       # HOTL + isPaused guards (v1.1.0)
node tests/test-hitl.mjs       # HITL gates
node tests/test-glue.mjs       # tool API glue
node tests/test-guard.mjs      # prompt structural guard
node tests/test-latent-bugs.mjs # latent bugs regression
