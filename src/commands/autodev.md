---
name: autodev
description: >
  Autonomous goal completion with LLM-driven recon + 2-round gating + YAML state.
  Given a goal + acceptance intent, autodev drives recon -> 2-round plan -> slice
  execution (orchestrate) -> YAML state gates -> final acceptance, until DONE or PAUSED.
---

## 子命令分发（$ARGUMENTS 首词解析）
autodev 支持两种模式入口与一个**跨模式控制面**（5 个动词共享）。**先解析 `$ARGUMENTS` 的首个词**再决定行为：

| 首词 | 行为 |
|------|------|
| （空） | **auto**：调 `autodev` tool `set_mode auto`，跑下方主循环（无人工干预） |
| `hitl` | 仅 `hitl` → 调 `set_mode hitl`，跑主循环 + **每关键决策点暂停等人审批**（见 HITL 检查点）；若带后续参数 → 控制面，不跑循环 |
| `hotl` | 仅 `hotl` → 调 `hotl_init`，跑主循环（Agent 自治，人可随时介入）；若带后续参数 → 控制面，不跑循环 |
| `gate` | **跨模式控制面**：调 `autodev` tool `hitl_respond`（`decision` = 第二个词 `accept|deny|force`，`gate_id` = 第三个词，`note` = 剩余参数），不跑循环 |
| `steer` | **跨模式控制面**：调 `autodev` tool `hotl_steer`（`note` = 剩余文本；scope 自动从 text 中推断 `@slice:` / `@task:`），不跑循环 |
| `lifecycle` | **跨模式控制面**：调 `autodev` tool `hotl_<第二个词>`（`pause|resume|cancel`），不跑循环 |
| `status` | **跨模式控制面**：调 `autodev` tool `hitl_status`（含自动吸收 pending steer），返回完整状态，不跑循环 |
| `config` | **跨模式控制面**：调 `autodev` tool `hitl_config`（`hitl_patch` 从 `<key>=<value>` 参数对构建），不跑循环 |
| `help` | 输出下方帮助并停止 |

若首词是 `hitl`/`hotl` 但**无后续参数**，先置对应模式，再跑主循环。其余首词（`gate|steer|lifecycle|status|config|help`）**始终只执行控制面 op，不跑主循环**。

## 帮助
- **auto（默认）**：`/autodev` —— Agent 完全自治跑完 RECON→PLAN→SLICE EXECUTE→FINAL。
- **HITL（人在环）**：`/autodev hitl` 启动；在 plan_approval / slice_pre_exec / verify_failure / final_acceptance 四个审批点暂停等人裁决。
  控制面：`/autodev gate <id> accept|deny|force [reason]`、`/autodev status`、`/autodev config mode=advisory`。
- **HOTL（人在环上）**：`/autodev hotl` 启动；Agent 自治，人类监控 + 随时介入。
  控制面：`/autodev steer <text>`、`/autodev lifecycle pause|resume|cancel`、`/autodev status`。
- **跨模式控制面（5 个动词，hitl/hotl 下通用）：**
  `/autodev gate <id> accept|deny|force [reason]` — 审批 gate
  `/autodev steer <text>` — 注入引导指令
  `/autodev lifecycle pause|resume|cancel` — 生命周期控制
  `/autodev status` — 统一状态查询（含自动吸收 pendig steer）
  `/autodev config <key>=<value>` — 动态配置
- 通用：`/autodev help` 显示本帮助。

# /autodev —— 自主完成目标并验收

你是 autodev 的父 agent。按以下**主循环契约**推进，直到最终验收通过或进入 PAUSED：

> **干预模式钩子（务必先读）**：本会话的模式由入口决定——`auto` 无干预；`hitl` 在每个关键决策点**暂停等人审批**（见下方 ④ ⑤ 的 HITL 检查点）；`hotl` Agent 自治、人类随时 steer。无论哪种模式，状态级硬约束都在工具层兜底（如 HITL 有未裁决 gate 时 `transition_task`/`check_slice_gate` 返回 `BLOCKED_BY_PENDING_GATE`，不会静默绕过；HOTL 的 steer 在工具层吸收点自动消费）。

## 可用能力
- **autodev tool**：读写 YAML 状态、迁移 task 状态（`transition_task`，带合法迁移边校验）、推进/查询 slice 阶段（`set_slice_stage` / `check_slice_gate`）、查 slice/final 门控（`final_check`）、replan、构建并**强制校验** final_standard 门控不变式（`build_standard`）。
  另有四个支撑 resume/验收的操作：`verify`（**真实执行** verify 命令，据退出码判定，不采信 subagent 自报）、
  `write_local`（把重产物**双写**到 durable `artifacts/`，返回 durable+local 双 ref）、
  `journal`（读 `.omp/autodev/run.json` 事件日志）、`resume`（聚合 last-event + statusSummary + handoffs，供 compact/handoff 后新会话锚定）、
  `recon_score`（RECON 维度置信度打分 + 路由：solid/revisit/escalate，结果回写 autodev.yaml）。
- **workflow 原语**（`workflow` 关键词）：写确定性扇出脚本，用 `agent()/parallel()` 派生上下文隔离 subagent。
- **orchestrate 原语**：按阶段派发 task-tool subagent，阶段间上下文隔离、每阶段自带验收。

## Subagent 双通道契约（local://）
所有 subagent 遵循同一契约（详见设计文档 §9）：把**全部重产物**写到 `local://{role}-{slug}.md`，返回值**只能是轻量 JSON**——
`{ "status": "success|partial|blocked", "ref": "local://...md", "summary": "1~3 句结论", "findings": [...], "next_action_or_blocker": "..." }`。
**禁止**在返回值里塞原始数据或完整文件内容。父 agent 默认只消费 `summary + ref`，仅在需验证/决策时才 `read local://...md`。
关键产物同时持久化到 `.omp/autodev/artifacts/`，避免 compact/handoff 后引用失效。

## 上下文预算护栏（始终在"最优区域"工作）
父上下文窗口有限，且存在"最优区域"（相对模型窗口 30%~50% 时性价比最高；超过则 context rot 静默退化、
Lost-in-the-Middle 让中段信息准确率掉 30%+）。autodev 用一道**工具级硬闸门**强制父 agent 待在最优区域：

- **三态百分比**（写进 autodev.yaml 的 `contextBudget`，**相对模型窗口，不写死绝对值**）：
  `targetPct: 0.40`（绿区中心）/ `hardCeilingPct: 0.50`（硬上限 = 0.50 × modelMaxContext）。
  modelMaxContext 由 omp 读取（Goal Mode 的 contextWindow / models.yml）；200K/256K/1M 窗口模型一律按比例。
- **读闸门（强制）**：每次要加载 `local://` 或 `.omp/autodev/artifacts/` 内容前，先调
  `autodev` tool 的 `read_gate`（传入 `used_tokens` = omp getCurrentUsage 或 ledger.used、
  `content`/可读 `ref`）。返回 `allowed:false` 时**必须停止加载**：
  - `zone: red`（>= 硬上限）→ 立即 `/compact` 或 `/handoff`，**不得带着超额上下文做决策**；
  - `zone: amber`（>= 目标）→ 先驱逐工作集里最旧的驻留项（goal+invariants 永不被驱逐），再重试 read_gate。
- **工作集固定**：常驻 = goal + invariants（mandatory/seed）+ 当前 slice digest + 下 1~3 task；其余全在
  YAML / `local://` 里，按需 read_gate 拉。每个 slice 边界强制 compact/handoff。
- **三段布局（对抗 Lost-in-the-Middle）**：你的 prompt 永远按
  **顶（primacy）= goal + 当前门 + mandatory/invariants** / **中 = 当前工作集（仅当前 slice 摘要 + 下 1~3 task）** /
  **底（recency）= 下一步动作指令** 排布。关键验收标准绝不埋在 recon dump 中间——重产物只留 `local://` 引用。

## 主循环（严格按顺序）
### ① RECON-PLAN（LLM 决定侦察维度，不硬编码）
用 `workflow` 扇出 N 个隔离 subagent，各自基于目标+developer_seed+base taxonomy 候选，提议一组 recon 维度
（id/title/rationale/weight/suggested_tools/expected_artifact）。**每个 subagent 把重产物写 `local://recon-<dim>.md`，只回轻量 JSON summary**；
你综合成最终 `dimensions[]`，落盘到 autodev.yaml 的 `recon.dimensions`。base taxonomy 只是候选种子，可增删改。
（可选 2-round：再扇出对抗 subagent 裁剪不相关/冗余维度，同样走双通道契约。）

### ② RECON（真实侦察）
对每个维度派一个隔离 recon subagent，返回结构化 dossier，每条结论带 `file:line` 证据。

### ②b RECON 维度置信度打分（侦察质量门，进 PLAN 前必过）
把各维度 recon 返回喂给 `autodev` tool 的 `recon_score`（`recon_dims` 取自 autodev.yaml 的 `recon.dimensions`，
`sub_results` 为 `{ dimId: subagentReturn }` 映射），由纯逻辑算出每个维度的 `confidence(0~1)` + `evidence_status`
（covered/partial/missing/contradicted），并路由成三组：
- **solid**（confidence ≥ 阈值 0.55）：侦察扎实，当作 PLAN 坚实地基，直接进入 ③；
- **revisit**（confidence < 阈值 且 recon_pass < 2）：进 2-round 对抗裁剪（用 `recon-synth.ts` 的
  `buildReconConfidenceAdversarialPrompt`，对抗 subagent 对每个维度判 keep/prune/escalate，keep 则 recon_pass+1 再侦察一轮）；
- **escalate**（confidence < 阈值 且 recon_pass ≥ 2）：**停 recon，升级人工/PAUSED**（防"再侦察→仍低分"死循环）。
打分结果回写 autodev.yaml 的 `recon.dimensions`（携带 confidence/evidence_status/recon_pass）供审计。
**低置信高风险维度（尤其 numerical_risk / mpi_boundary / precision_repro）未达 solid 前不得锁定方案。**

### ③ PLAN（顶层方案，2-round 验收标准）
用 **TwoRoundGate** 形成顶层方案的验收标准：
- R1 起草：扇出多隔离 subagent 各自起草门控（machine + llm_judge 混合），你整合成提案；
  每个 subagent 写 `local://gate-*.md`，只回轻量 JSON。
- R2 对抗审查：再扇出多隔离 subagent 找 loopholes，你定稿；**mandatory 与 developer_seed 项不得被 R2 删除**，缺失由 `validateGateInvariants()` 自动补回。
- **强制项**（编译/构建/测试）由你强制并入 final_standard，R2 不可移除。
把目标拆成 slices（含 depends_on 拓扑），初始化 autodev.yaml 与每个 slice.yaml（autodev tool: init）。

**init 仅调用一次（硬约束）**：若 `.omp/autodev/autodev.yaml` 已存在，**禁止重复 init 覆盖**——会静默清零
`recon.dimensions` / `gate.*` / `slices[].stage/replan_attempts` 等全部累积进度。一律改用增量 operation
（`read` / `transition_task` / `set_gate` / `replan` / `build_standard`）推进；确需从零重置才显式传 `force:true`。

**slice 内容必须独立成文件（硬约束）**：每个 slice 的 `tasks` / `acceptance_criteria` **只**写在
`.omp/autodev/slices/<id>.yaml`；**严禁**把 slice 详细内容内联进 `autodev.yaml`（父 yaml 仅持有
`id/title/stage/depends_on/replan_attempts/slice_file` 等元数据）。

### ④ SLICE EXECUTE（orchestrate，逐 slice）
> **HITL 检查点 · plan_approval**（仅 hitl 模式）：在 ③ 定稿、进入 ④ 前，对每个 slice 调 `autodev` tool `hitl_request`（`gate: plan_approval`，`slice_id`）。**调完即停止**，提示人类："` await 审批：请运行 /autodev gate <id> accept`"。在 `hitl_respond` 裁决前不得进入 ④（工具层也会硬阻）。（若该 slice 涉及数值重构 / MPI 边界等高风险，附 `sensitivity: numerical_risk|mpi_boundary`，使 advisory 超时也**不**静默放行——P1-2）
对每个 slice 按 depends_on 顺序：
> **HITL 检查点 · slice_pre_exec**（仅 hitl 模式）：进入某 slice 执行前（`set_slice_stage executing` 之前），调 `autodev` tool `hitl_request`（`gate: slice_pre_exec`，`slice_id`）。**调完即停止**，提示人类："` await 审批：请运行 /autodev gate <id> accept`"。裁决前不得执行该 slice。
> **HOTL 说明**（仅 hotl 模式）：Agent 自治执行，**不暂停**。人类可在任意时刻 `/autodev steer <text>` 下发指令。
> **强约束（P1-6 / P0-4）**：你**必须**在每个主循环 checkpoint（每轮 `check_slice_gate` / `transition_task` / `replan` 调用点）主动调一次 `hotl_poll` 以吸收未消费的 steer——工具层也会在这些 op 内部自动吸收，但你必须显式 poll 以防 LLM 自觉漏吸收。若某 slice replan 超限收敛到 paused，人类用 `/autodev lifecycle resume` 继续。
> **机器强停（P1-6）**：一旦人类调 `hotl_pause`/`hotl_cancel`，工具层已置 `loop_state=paused|cancelled` 并返回 **STRONG INSTRUCTION**，你必须**立即停手**（pause=停止所有自治工作、等待 resume；cancel=终止运行）。这是机器强制，不是咨询——无视强停指令等于违反核心契约。
- 先走 **2-round 详细设计**（Design 阶段 subagent，其验收标准也走 TwoRoundGate）；
- 进入执行前先调 `autodev` tool: `set_slice_stage`（slice_id，slice_stage: executing）；
- 再 orchestrate 出 Implement → Verify 阶段 subagent，每阶段上下文隔离、自带验收；
  （Design/Implement/Verify 各自重产物写 `local://slice-<id>-*.md`，回轻量 JSON；**verify 命令由 autodev tool 实际执行，不采信 subagent 自报的 PASS**）
> **HITL 检查点 · verify_failure**（仅 hitl 模式）：若 `verify` 退出码非 0 或任务进入 blocked，调 `autodev` tool `hitl_request`（`gate: verify_failure`，`slice_id`）。**调完即停止**，提示人类："` await 审批：请运行 /autodev gate <id> accept|deny|force [reason]`（accept=接受现状继续 / deny=驳回回重规划 / force=人工免检染色）"。裁决前不得继续。
- task 状态用 autodev tool 管理：todo→doing→done（**done 为终态，禁止回退**，`transition_task` 会拒绝非法迁移）；done 需其 `accept` 通过；
- 每完成一个 task（done）或一条 AC（pass）后，**必须**调 `autodev` tool: `check_slice_gate`（slice_id）。
  该 op 会据 task/AC 当前状态**真实落盘** slice.stage：全 done+全 pass → `done`、有 blocked → `blocked`、其余 → `verifying`，
  并**同步父 autodev.yaml 的 `slices[].stage`**（这是 ⑤ 能判通过的前提，缺此则循环永远到不了 DONE）；
- 当 `check_slice_gate` 返回 `stage:done` → 该 slice 验收通过；否则按其 `missing` 进入 fix loop（bounded correction delta）。
- **slice 边界 handoff**：该 slice stage:done 后，写 `.omp/autodev/handoffs/S{id}.md`（autodev tool: handoff，
  传 State/Context/Intent/Return path/Verification 五段 JSON；不含 Risks 段，autodev 通用领域无关），
  再调原生 `/handoff` 以该文件为 prompt 开下一 slice 的新会话——**新会话只载 handoff + 自己的 slice YAML，
  永远从 green 起**，不背前序 slice 历史。

### ⑤ 最终验收
> **HITL 检查点 · final_acceptance**（仅 hitl 模式，默认关闭，需 `config gates.final_acceptance=true` 开启）：在公布 DONE 前，调 `autodev` tool `hitl_request`（`gate: final_acceptance`）。**调完即停止**，提示人类："` await 最终审批：请运行 /autodev gate <id> accept|deny|force [reason]`"。裁决前不得结束。
> **HOTL 说明**（仅 hotl 模式）：Agent 自治完成最终验收，无需暂停；人类可随时 `/autodev lifecycle pause`/`cancel` 介入。同样遵循 ④ 的机器强停约束——收到 `hotl_pause`/`hotl_cancel` 的 STRONG INSTRUCTION 必须立即停手。
所有 slice done 后，autodev tool: build_standard + final_check。
final_standard 全 pass → **DONE**，结束（最后做一次全局 `/handoff` 收尾，写明验收结论与遗留项）。
不通过 → 重开相关 slice。

**最终验收标准必经完整 TwoRoundGate**：`gate.final_standard` 的验收项形成**必须**走与 ③ 相同的 R1 起草 + R2 对抗审查流程，
**不得**跳过 2-round 直接定稿；其中 mandatory（编译/构建/测试）与 developer_seed 项**强制保留、R2 不可删除**。
`build_standard` 会强制校验该不变式——若 R2 误删了 mandatory/seed，工具**自动补回并报错提示**，不会静默放行。

## blocked 处置（贯穿 ④）
task 进 blocked：写入 reason，autodev tool: replan（回弹你重规划，replan_attempts++）。
replan_attempts ≤ 3 重试（回到 planning）；第 4 次仍 blocked → 该 slice stage: paused，全局停下等人。

## 落盘约定
autodev.yaml 在 `.omp/autodev/`；slice 在 `.omp/autodev/slices/<id>.yaml`。每个状态变更后用 autodev tool 落盘。

现在开始：先确认/补全目标与 developer_seed，然后进入 ①。
