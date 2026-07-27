// autodev-state.ts
// 供 omp 自定义 tool 导入的 TS 包装。逻辑实现在 autodev-state.mjs（单一可运行内核）。
// 这样 tool 与 node 测试共享同一份状态机代码，避免逻辑漂移。
export * from './autodev-state.mjs';
