# Changelog

All notable changes to autodev are documented here. Version scheme: `VERSION` file at root. Distributed as npm package `@williamcodebox/autodev` (formerly tarball `autodev-v{VERSION}-offline.tar.gz`).

## [1.1.0] - 2026-08-04

### Added
- **Named subagent definitions** (3 agents via `agents/*.md`, enforced by omp frontmatter tool whitelists):
  - `autodev-scout`: Fast read-only explorer for RECON-PLAN and RECON phases (tools: read, grep, glob, autodev; model: @smol; read-summarize: false)
  - `autodev-gatekeeper`: PLAN phase decision engine with TwoRoundGate (R1 draft + R2 adversarial audit by N isolated instances). Spawns autodev-scout for targeted investigation. (tools: read, grep, glob, autodev; model: @slow)
  - `autodev-implementer`: SLICE EXECUTE agent, the only agent with write access. Design→Implement→Verify cycle within .omp/ firewall. (tools: read, write, edit, bash, grep, glob, autodev; model: @slow)
- **Fail-loud dispatch**: parent prompt mandates exact agent name spawning; failure to find named agent causes hard stop (no silent fallback to anonymous task)
- **P0-2 fix**: `set_gate` now rejects `pass` on machine gates without prior `verify` evidence (`verified_at` timestamp from `runVerify`)
- **P1-2 fix**: `isPaused` guard added to four state-mutation operations (`transition_task`, `set_gate`, `check_slice_gate`, `set_slice_stage`)—HOTL pause is now machine-enforced, not prompt-only
- **ADR-0006**: npm distribution migration

### Changed
- **Distribution**: switched from tarball (`pack-offline.py`) to npm package `@williamcodebox/autodev`. Install via `omp plugin install @williamcodebox/autodev`.
- **Directory layout**: `commands/`, `skills/`, `tools/`, `agents/` now at repo root (required by omp extension package convention)
- **Parent prompt**: replaced inline subagent contract prose with named agent dispatch table; PLAN phase restored R2 fan-out of N isolated gatekeeper instances (per AGENTS.md constitution)
- **TwoRoundGate**: fixed R1+R2 merge violation—R2 now fans out 2-4 independent gatekeeper instances each auditing a single dimension (state machine legality, gate completeness, dependency ordering, boundary conditions), satisfying SKILL.md/ARCHITECTURE.md/AGENTS.md "N isolated subagents" requirement

### Fixed
- `spawns: scout` → `spawns: autodev-scout` (omp resolves spawn by agent.name, not filename; old value matched built-in scout)
- `.gitignore` now includes `.omp/agents/`

### Added
- Core state machine (`autodev-state.mjs`) with YAML-persisted task/slice/gate lifecycle
- Five-phase loop: RECON-PLAN -> RECON -> PLAN -> SLICE EXECUTE -> FINAL
- TwoRoundGate: adversarial acceptance review (R1 draft + R2 loophole finding)
- LLM-driven reconnaissance dimensions (dynamic decomposition per task)
- Three human intervention modes on same core loop (auto / HITL / HOTL)
- Context budget guardrails with three-zone enforcement (green/amber/red)
- Slice boundary handoff to prevent context rot across long tasks
- Genuine verification (spawns process, judges by exit code)
- Subagent dual-channel contract (heavy artifacts in `local://`, return value as JSON)
- 13+ tool-level intervention operations (gate, steer, lifecycle, status, config)
- HITL approval points with hard tool-level blocking on pending gates
- HOTL steering with auto-absorption at tool layer
- Prompt structural integrity testing (110 items)
- Prompt cross-consistency testing (29 items)
- Prompt behavior regression testing (15 items, LLM contract adherence)
- Two-axis integration testing framework (deterministic code + adversarial review)
- 7-scenario coverage matrix (happy-path, blocked-replan, hitl-mode, gate-invariants, hotl-steer, e2e-omp, context-budget)
- Architecture Decision Record (ADR) mechanism
- Advisory review workflow: Scout -> Decompose -> Fan-out -> Adversarial verification -> Manual verify -> Synthesize

### Changed
- Refactored into `tools/autodev/` + `tests/` layout with HITL/HOTL subsystems
- Collapsed command surface from 17 to 9 forms
- README modularized into `docs/` subpages (architecture, testing, design decisions)
- Removed dead design modules
- Translated INSTALL.md and AGENTS.md to English

### Fixed
- P0 bugs found during adversarial review (state machine invariants, YAML consistency)
