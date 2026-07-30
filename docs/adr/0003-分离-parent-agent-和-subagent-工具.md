---
date: 2026-07-30
status: accepted
decider: autodev
origin: DESIGN
---

# ADR-0003: 分离 parent-agent 和 subagent 工具

## Context

autodev 中存在两种角色：编排者（parent agent，操控状态机）和执行者（subagent，操控文件）。如果同一个 LLM 实例同时拥有 state ops 和 file ops，可能发生 confused deputy 问题 —— 操作文件时意外改变了状态机，或操作状态机时意外改写了文件。

## Decision

parent agent 只看到状态操作工具（transitionTask, checkGate），subagent 只看到文件操作工具（read, write, edit）。这一分层防止单个 LLM 在同一时间操控状态和文件，避免 confused deputy 问题。

## Consequences

- 优点：安全 —— 状态机不被文件操作意外干扰
- 优点：职责清晰 —— parent 管流程，subagent 管实现
- 代价：parent→subagent 的通讯开销
- 代价：subagent 无法在需要时直接查询状态

