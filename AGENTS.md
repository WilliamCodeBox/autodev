# autodev 项目准则

## 架构设计偏好

**不增实体，砍到骨头。** 方案不因"以后可能有用"而保留任何东西。YAML 索引、原子双写、渐进披露三层——这些"虽然不错但不需要"的一律砍掉。唯一留存的标准是：没有它这件事做不成。

**运行时状态 ≠ 项目产物。** `.omp/` 是机器状态，人类不直接读；`docs/` 是人类交付物，版本化、可浏览。混在一起是设计错误。

**功能边界必须锋利。** ADR 和 DESIGN 产物的区别、ADR 和 run.json 的区别、ADR 和 recon 记录的区别——每一条都要能一句话说清。说不清意味着职责没划对。

**新加功能的默认回答是"不"。** 每引入一个 tool operation、一个触发点、一个索引，都要对抗审查来证明它不可或缺。

**代码要能被测试明确覆盖。** 不仅仅是函数跑通，而是边界条件（缺参、空列表、无 init state）和不变式都写进测试文件，跟已有测试一起运行。

**提示词和代码同等重要。** SKILL.md 的使用指南是 LLM 的行为契约，不是注释——它定义了 LLM 该在什么时候、依据什么条件做判断，跟代码里的校验同等重要。

## 验证方法论

autodev 的可靠性取决于两层：状态机硬逻辑 + LLM 对提示词的服从。前者可确定性验证，后者需对抗式审查。

### 方法论：两轴测试

#### 轴一：代码正确性（确定性验证）
**测什么**：autodev-state.mjs 的 YAML 读写、task 迁移边、slice stage 推进、replan 超限、HITL/HOTL 门控、上下文护栏。

**怎么测**：引入真实 lib，在 `fs.mkdtempSync()` 下做真实 YAML I/O，按操作序列驱动（init → transitionTask → replan → checkSliceGate → checkFinalGate），每步断言磁盘状态。

**为什么**：state lib 是 omp 运行时加载的同一份代码（无 mock），YAML 落盘格式与运行时完全一致——测的是"真实跑的样子"。

#### 轴二：提示词约束（对抗式审查）
**测什么**：LLM 是否严格遵循 autodev 命令的步骤顺序（RECON-PLAN → RECON → PLAN → SLICE EXECUTE → FINAL），不跳步、不漏步、不发明不存在的操作。

**怎么测**：两层——
1. **端到端**（06-e2e-omp）：`omp -p` 执行极简 autodev 任务，验证状态文件被正确写入（扩展可加载、工具可调用）。这是最低通过条件。
2. **对抗审查**（`--omp` 标志）：收集 state bundle（YAML + run.json + 日志）→ 调用 `omp -p` 扇出 N 个隔离 subagent，各审一个维度（状态机合法性、YAML 完整性、门控正确性、边界条件），回 JSON 裁决。

**为什么用 LLM 审 LLM**：提示词约束本质上是一个语义问题——"模型是否理解并执行了给定流程"。最经济的判断方式是让另一个模型用 adversarial 视角审查产出，找出"该有却没有"的阶段证据。

## 8 场景覆盖矩阵

| 场景 | 轴 | 覆盖 |
|---|---|---|
| happy-path | 代码 | init→slice→task→reconcile→final gate 全闭环，recon 保留、父 stage 同步 |
| blocked-replan | 代码 | doing→blocked→replan(attempts++)→超限 paused，磁盘持久化 |
| hitl-mode | 代码 | establishMode 三层互斥、pending gate 硬阻塞(hitl.pending_gates)、approve 解除 |
| gate-invariants | 代码 | R2 删 mandatory→validateGateInvariants 补回，幂等 |
| hotl-steer | 代码 | steer→poll→pause→resume→cancel，loop_state 派生 |
| e2e-omp | 提示词 | omp -p 跑 autodev（无 omp 自动 skip） |
| context-budget | 代码 | 三态 zone、readGate 硬拒绝、LRU 驱逐 + pinned 保护 |
| prompt-regression | 提示词 | LLM 对 prompt 契约的遵守：双通道、mandatory 不变式、schema 输出（eval cell） |

## 运行

```bash
node tests/run-integration.mjs              # 轴一：全场景
node tests/run-integration.mjs --omp        # 轴一 + 轴二
node tests/run-integration.mjs --only=X     # 过滤
node tests/run-integration.mjs --list       # 列场景
node tests/test-state.mjs                   # 已有单元测试
node tests/test-prompts.mjs                 # 提示词结构测试（毫秒级）
node tests/test-prompts-consistency.mjs     # 提示词交叉一致性测试（毫秒级）
# 行为测试在 eval cell 中运行（见 tests/prompt-behavior.mjs）
```
