# Changelog

All notable changes to autodev are documented here. Version scheme: `VERSION` file at root, tarball name `autodev-v{VERSION}-offline.tar.gz`.

## [7.0.0] - 2025-01

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
- Refactored into `src/tools/autodev/` + `tests/` layout with HITL/HOTL subsystems
- Collapsed command surface from 17 to 9 forms
- README modularized into `docs/` subpages (architecture, testing, design decisions)
- Removed dead design modules
- Translated INSTALL.md and AGENTS.md to English

### Fixed
- P0 bugs found during adversarial review (state machine invariants, YAML consistency)
