---
date: 2026-07-30
status: accepted
decider: autodev
origin: DESIGN
---

# ADR-0005: HITL/HOTL 共享同一核心循环

## Context

autodev 支持三种模式：auto（全自动）、HITL（人在环验证）、HOTL（人在环监督）。问题是这些模式是否应该实现为独立的代码路径？独立路径的维护代价高，一个模式修了 bug 另一模式可能忘记同步。

## Decision

所有三种模式共享同一个核心循环（core loop）。HITL 和 HOTL 通过状态机中的 mode flags（hitl.enabled / hotl.mode）来控制流程行为 —— 核心逻辑（状态机 transitions、gate 推进、replan）只测试一次，不存在"auto 修了 bug 但 hitl 分支忘了"的风险。

## Consequences

- 优点：维护性 —— 核心逻辑只测试一次
- 优点：一致性 —— bug 修复对所有模式生效
- 代价：条件分支增加核心路径的复杂度
- 代价：HITL/HOTL 特有逻辑（如 HITL pending gate 阻塞）核心代码需带条件判断

