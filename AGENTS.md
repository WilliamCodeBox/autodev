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

## Self-ADR Operation (autodev-extension 自身架构决策记录)

### 触发条件

当用户明确要求记录一条架构决策时（如"把这个记成 ADR"、"记录一下这个决定"、"写一条 ADR"），Agent 应自动创建 ADR 文件。

触发场景举例：
- 当前开发中遇到了架构权衡，用户决定采用某方案
- 完成了关键设计决策的讨论
- 需要记录某个接口契约、模块边界、或数据格式的变更理由

### 记录方式

Agent 可直接通过 `eval` 调用 `appendADR()` 写入，或手动构造 markdown 用 `write` 工具创建。推荐用 `eval`：

```js
// 在 eval 中调用 appendADR（推荐）
import { appendADR } from '../tools/autodev/lib/autodev-state.mjs';
const r = appendADR('.', {
  title: 'ADR 标题（简短概括决策）',
  context: '决策背景和上下文',
  decision: '具体决策内容',
  consequences: ['正面/负面影响1', '影响2'],
  origin: 'manual',        // manual | DESIGN | HITL
  decider: 'human',        // human | autodev
  supersedes: undefined,   // 如取代之前某条 ADR，填其编号（如 '0005'）
});
console.log(`ADR-${r.id} written: ${r.path}`);
```

**注意**：`appendADR('.', ...)` 的 `root` 参数默认是当前工作目录（autodev-extension 根目录）。`appendADR` 会优先尝试加载 `autodev.yaml`。由于 autodev-extension 自身没有 `autodev.yaml` 文件，函数会自动 fallback 到**目录扫描模式**：扫描 `docs/adr/` 下已有文件取 `max_id + 1`，不依赖外部计数器文件。

### ADR 文件格式

输出文件：`docs/adr/{0004}-{slug}.md`

模板（YAML frontmatter 格式，兼容 MADR 工具链）：
```markdown
---
date: {YYYY-MM-DD}
status: accepted
decider: human
origin: manual
---

# ADR-0004: {title}

## Context
{背景描述}

## Decision
{决策内容}

## Consequences
- 正面/负面影响

## Links
- Supersedes: ADR-0002  （如适用）
```

### 约束

- **ADR 只增不删**。如需废弃某条 ADR，在新 ADR 中通过 `Links/Supersedes` 引用，而非删除旧文件。
- **编号由目录扫描自动推导**，不可手工指定。从未被使用过的编号不会回归利用（避免引用断裂）。
- **只记录架构决策**，不记录 task 推进、常规 approve/reject、构建/测试结果（这些已进 journal）。
- 所有 ADR 归入 `docs/adr/` 目录，按文件名排序即为时间轴。
- 读取：`read docs/adr/{id}-{slug}.md`（复用通用 read 工具）。

### 与消费项目 ADR 的区别

| 维度 | 消费项目 ADR | 自 ADR |
|------|-------------|--------|
| 写入位置 | 消费项目的 `docs/adr/` | autodev-extension 自身的 `docs/adr/` |
| 计数器 | `autodev.yaml` 的 `adr.next_id` | 目录扫描 `max_id + 1` |
| journal | 写入 `run.json` | 不写 journal |
| 目标用户 | 消费项目的开发者 | autodev 自身的开发者和 Agent |

## Git Convention
- **Force push is forbidden** (`git push --force`). History must be linearly traceable.
- All remote branch conflicts resolved via rebase or merge -- never overwrite remote history.

---

## Documentation Conventions

### Version Control
- Single source of truth: `VERSION` file at repo root, one line, semver (e.g. `1.0.0`).
- Release tarball named `autodev-v{VERSION}-offline.tar.gz`.
- Git tag `v{VERSION}` on each release commit.

### Changelog
- File: `CHANGELOG.md` at repo root.
- Format: [Keep a Changelog](https://keepachangelog.com) -- sections Added / Changed / Fixed / Removed per version.
- Date format: `YYYY-MM-DD`.
- **MUST use `web_search` to confirm the current date before every changelog update.** Never guess or trust system clock alone.

### English / Chinese Documentation
All project documentation uses English **by default**. Chinese is a derived parallel translation.

| File | Language | Location |
|------|----------|----------|
| `README.md` | English | repo root |
| `docs/README.zh.md` | Chinese | `docs/` |
| `docs/ARCHITECTURE.md` | English | `docs/` |
| `docs/TESTING.md` | English | `docs/` |
| `docs/DESIGN_DECISIONS.md` | English | `docs/` |
| `docs/INSTALL.md` | English | `docs/` |

### Chinese/English Sync (Must Keep Parallel)
- `README.md` (English, root) and `docs/README.zh.md` (Chinese, docs/) **must have identical structure**: same headings, same order, same section count, same navigation links.
- When adding a new section, feature, or link to `README.md`, the equivalent change MUST be applied to `docs/README.zh.md` in the same commit.
- Chinese translation maintains technical accuracy; section headers and navigation links stay structurally identical.

### Cross-Link Consistency
- Every `docs/*.md` file is reachable from `docs/README.zh.md`'s "了解更多" table.
- The index bar at the top of `README.md` and `docs/README.zh.md` must list the same set of linked documents.
- When renaming, moving, or deleting any file, ALL cross-references across `README.md`, `docs/README.zh.md`, and `docs/*.md` must be updated in the same commit.
- Relative paths: `README.md` references `docs/*.md` as `docs/FILE.md`; `docs/*.md` references sibling as `FILE.md`, parent as `../README.md`.

### File Layout
```
autodev-extension/
  README.md              ← English landing page, indexes all docs/*
  VERSION                ← semver (single line)
  CHANGELOG.md           ← Keep a Changelog format
  AGENTS.md              ← this file (project-wide conventions)
  docs/
    README.zh.md         ← Chinese translation of README.md
    INSTALL.md           ← installation guide
    ARCHITECTURE.md      ← full architecture and design features
    TESTING.md           ← testing methodology and coverage
    DESIGN_DECISIONS.md  ← rationale and limitations
```
