# Key Design Decisions

Each architecture decision is recorded as an individual ADR (Architecture Decision Record) in [`docs/adr/`](adr/). Below is an index with one-line summaries.

| # | ADR | Summary |
|---|-----|---------|
| 1 | [`0001-动态侦察维度非硬编码模板.md`](adr/0001-动态侦察维度非硬编码模板.md) | 侦察维度由 LLM 在 RECON-PLAN 阶段动态生成，而非固定模板 |
| 2 | [`0002-yaml-而非内存状态.md`](adr/0002-yaml-而非内存状态.md) | YAML 快照 + run.json 日志持久化状态，支持崩溃恢复、审计、异步协作 |
| 3 | [`0003-分离-parent-agent-和-subagent-工具.md`](adr/0003-分离-parent-agent-和-subagent-工具.md) | 分层防止 confused deputy：parent 管流程，subagent 管文件 |
| 4 | [`0004-上下文预算作为硬工具层拦截.md`](adr/0004-上下文预算作为硬工具层拦截.md) | 硬 gate 拦截超出预算的 read，不依赖 LLM 自我评估 |
| 5 | [`0005-hitlhotl-共享同一核心循环.md`](adr/0005-hitlhotl-共享同一核心循环.md) | 三种模式共享同一核心循环；核心逻辑只测一次，不存在分叉遗忘 |

## Limitations

| # | Limitation | Impact |
|---|-----------|--------|
| 1 | **No sandbox isolation** | Code execution relies on omp's process isolation; cannot run untrusted code |
| 2 | **No event-driven entry** | Fully manual `/autodev` startup; no GitHub webhook / CI integration |
| 3 | **Single-model routing** | All phases use the same model; no tiered routing (small model for recon, large model for design) |
| 4 | **No PR/Git workflow** | No auto commit/PR after verify passes; results stay as local file modifications |
| 5 | **No conversational correction** | HITL is approval-style (accept/deny/force), not interactive edit-by-conversation |
| 6 | **Bound to omp framework** | Cannot be used independently |
