# autodev 集成测试对抗审查报告

**审查范围:** `tests/` 下全部测试文件 + 7 个集成场景  
**审查方法:** 8 维度并行审查 → 3 轮对抗反驳 → 手动代码验证  
**审查日期:** 2026-07-29

---

## 总览

| 维度 | 总发现 | 存活(验证) |
|---|---|---|
| 状态机核心语义 | 20 | 8 (4 error + 4 warn) |
| HITL 干预层 | 13 | 2 (2 error) |
| HOTL 监控层 | 11 | 3 (3 error) |
| YAML 持久化 | 13 | 2 (1 error + 1 warn) |
| 上下文预算护栏 | 4 | 1 (1 warn) |
| Journal/Artifacts | 3 | 1 (1 error) |
| Recon 打分 | 6 | 2 (2 error) |
| 场景覆盖率 | 14 | 2 (2 error) |

**总计:** 84 项初步发现 → 59 条 actionable → 3 轮对抗反驳 → **21 条进入最终报告**（16 error, 5 warn）

---

## P0 级（阻断性）

### 1. test-p1.mjs 动态 import 路径错误 → P1-4/P1-5/P1-8 测试静默跳过

**文件:** `tests/test-p1.mjs:109,119,172`  
**严重度:** `error` — 测试完全未执行

L109 和 L119 用 `await import('./autodev-state.mjs')` 但 `tests/` 目录下不存在 `autodev-state.mjs`。正确的文件在 `src/tools/autodev/lib/autodev-state.mjs`。

这导致：
- **P1-4 override 禁自动 DONE** — 核心安全机制的全套断言 (`rec.overridden`, `rec.blockedByOverride`, `s.stage !== 'done'`, `fg.overridePending`) 从未执行
- **P1-5 modify patch 校验** — gate 唯一定位 + modify 校验逻辑未测
- **P1-8 re-confirm journal** — `readJournal(ROOT)` 调用崩溃，后面断言跳过

**修复:** 将动态 import 改为顶部静态 import：
```js
import { reconcileSliceStage, checkFinalGate } from '../src/tools/autodev/lib/autodev-state.mjs';
import { readJournal } from '../src/tools/autodev/lib/autodev-state.mjs';
```
删除 `L109`、`L119`、`L172` 三处的动态 import。

### 2. cancelled 不在 SLICE_STAGES 枚举中

**文件:** `src/tools/autodev/lib/autodev-state.mjs:8` + `src/tools/autodev/lib/hotl-steer.mjs:208-210`  
**严重度:** `error` — 运行时异常路径

`SLICE_STAGES = ['queued','planning','executing','verifying','done','blocked','paused','awaiting_human']` — 不含 `cancelled`。

但 `absorbSteer()` 在 `kind === 'cancel'` 时执行 `slice.stage = 'cancelled'`。`index.ts` 中 `set_slice_stage` op 用 `SLICE_STAGES.includes` 校验——任何被 cancel 的 slice 会被拒绝写入。

`STAGE_WEIGHT` 却有 `cancelled: 0`，与枚举不一致。

**修复:** 将 `'cancelled'` 加入 SLICE_STAGES 枚举；或在 absorbSteer 中把 cancelled 映射为 `blocked` 或 `paused`。

### 3. detectSteerConflicts sameScope 引用不存在的 slice_id 字段

**文件:** `src/tools/autodev/lib/hotl-steer.mjs:128`  
**严重度:** `error` — P1-7 scope 间冲突判定失效

```js
const sameScope = (s) => s.scope === steer.scope || (steer.scope === `slice:${s.slice_id}` && s.scope === 'run');
```

steer 记录字段为 `{ id, kind, text, scope, intent, touches_done, created_at, applied }` — **无 `slice_id` 字段**。`s.slice_id` 始终 `undefined`，导致 `steer.scope === 'slice:undefined'` 恒 false。整个 OR 分支是死代码。

后果：run 域的 pending cancel 指令与 slice:S1 域的新 steer 之间不做冲突检测。

**修复:** 改 sameScope 为：
```js
const sameScope = (s) => s.scope === steer.scope;
```
因为 steer 结构中已有 `scope` 字段精确匹配（'run' 或 'slice:S1'），无需 slice_id 辅助。

### 4. loadAutodev/loadSlice 在文件损坏时抛出未捕获异常

**文件:** `src/tools/autodev/lib/autodev-state.mjs:117-121, 149-151`  
**严重度:** `error` — 截断/损坏文件导致全线崩溃

```js
export function loadAutodev(root = '.') {
  const p = autodevPath(root);
  if (!fs.existsSync(p)) return null;
  return yamlParse(fs.readFileSync(p, 'utf8')) || null;
}
```

如果 `.omp/autodev/autodev.yaml` 被截断（进程崩溃 mid-write 或并发冲突），`yamlParse()` 抛出 `YAMLException`，**所有 30+ 调用者**（syncSliceStageToParent, checkFinalGate, hitl-gates.mjs, hotl-steer.mjs 等）都会崩溃。

**修复:** 包裹 try/catch，损坏时返回 null 并 console.warn：
```js
export function loadAutodev(root = '.') {
  const p = autodevPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    const result = yamlParse(fs.readFileSync(p, 'utf8'));
    return (typeof result === 'object' && result !== null) ? result : null;
  } catch (e) {
    console.warn(`[autodev] corrupted ${p}:`, e.message);
    return null;
  }
}
```

---

## P1 级（高影响）

### 5. hasFileLine 正则假阳性

**文件:** `src/tools/autodev/lib/recon-score.mjs:18`  
**严重度:** `error`

```js
return /\S+\.\w+:\d+/.test(s) || /:\s*\d+/.test(s);
```

`/:\s*\d+/` 匹配任意冒号+数字，如 `时间: 42秒`、`比例为 3:5`、`数量: 42个` — 大量 false positives。

**修复:** 删除第二个 regex。`/\S+\.\w+:\s*\d+/` 已足够覆盖 `src/a.f90:42` 和 `a.f90: 42`。

### 6. hasRiskSignal 'block' 子串匹配假阳性

**文件:** `src/tools/autodev/lib/recon-score.mjs:23`  
**严重度:** `error`

```js
const RISK_RE = /block|unknown|unclear|uncertain|contradict|矛盾|阻塞|未知|不确定|探不动|缺失关键/i;
```

`block` 无词边界 → `hasRiskSignal('pipeline is unblocked') === true`（假阳性），`blockchain`、`block storage`、`building block` 都命中。

**修复:** 加词边界锚定：
```js
const RISK_RE = /\b(?:blocked|blocking|unknown|unclear|uncertain|contradict(?:ory|ing)?)\b|阻塞|未知|不确定|探不动|缺失关键/i;
```

### 7. --omp 标志是死代码

**文件:** `tests/run-integration.mjs:5-6`  
**严重度:** `error`

`--omp` 被文档声明为可用标志（"对抗审查"），但 `run-integration.mjs:12-16` 仅解析 `--filter`/`--only`/`--list`，未解析 `--omp`，也未传递给 `runAll()`。

同时 `tests/integration/review.mjs` 引用的 `ctx.bundle()`/`ctx.autodev`/`ctx.slices` 是 `omp -p ScenarioCtx` 专有属性，在纯 node 测试进程中不存在。

**修复:** 要么实现 --omp 传递（解析参数→传给 runner→runScenario 后调 runAdversarial），要么删除 dead code。

### 8. test-journal.mjs 命令不存在测试断言检查错误字段

**文件:** `tests/test-journal.mjs`  
**严重度:** `error`

`ok('status 为非 0（命令未找到）', res.status !== 0 && res.status !== null);` — `runVerify` 返回 `{ exit: exitCode, status: 'fail'|'pass' }`，所以 `res.status` 是字符串 `'fail'`，与数字 `0`/`null` 比较因 JS 类型不同而意外通过，未真正验证退出码非零。

**修复:** `ok('exit 为非 0', res.exit !== 0 && res.exit !== null);`

---

## P2 级（低影响/边界）

### 9. ContextLedger.remove 不清除 pinned 集合

**文件:** `src/tools/autodev/lib/autodev-state.mjs`  
**严重度:** `warn`

`remove(ref)` 仅执行 `this.entries.delete(ref)` 不执行 `this.pinned.delete(ref)`，导致 `pin→remove→add` 后旧 pinned 残留，新条目被错误地视为 pinned 而永不驱逐。

### 10. estimateTokens CJK 正则未覆盖全角标点

**文件:** `src/tools/autodev/lib/autodev-state.mjs`  
**严重度:** `warn`

`[㐀-鿿豈-﫿]` 仅覆盖 CJK 汉字，未覆盖全角标点（U+3000-303F, U+FF00-FFEF）。`，`、`。`、`？` 等被计为 0.4 token/char 而非 1.44，导致中文文档 token 估算偏低。

### 11. 多个边界测试缺口

**文件:** `tests/test-state.mjs`  
**严重度:** `warn`

- `blocked→todo` 合法迁移未测（唯一回弹路径）
- `todo→blocked` 合法迁移未测
- `replan maxReplans=0` 边界未测
- `transitionTask` 非法 taskId 未测
- `canTransitionTask undefined/null` 未测
- `reconcileSliceStage queued/planning 免降级` 路径未测
- `checkSliceGate 空数组` 未测
- `checkFinalGate 空数组` 未测
- `SLICE_STAGES` 未验证全部 8 阶段

### 12. 集成场景覆盖率缺口

**文件:** `tests/integration/scenarios/`  
**严重度:** `warn`

- 缺少 `runVerify`/`appendJournal`/`writeArtifact`/`handoff`/`resumeState` 场景
- 缺少 `recon-score.mjs` 集成场景
- 03-hitl-mode 仅测试 approve path，缺少 reject/modify/override/advisory timeout
- 05-hotl-steer 缺少 steer conflict 检测场景

---

## 修复优先级建议

```
P0:  test-p1.mjs import 路径   → 阻断 P1-4 全部断言
P0:  cancelled 不在枚举中      → 运行时异常路径
P0:  detectSteerConflicts 死分支 → P1-7 失效
P0:  loadAutodev 损坏崩溃       → 全线崩溃风险
─────────────────────────────────────
P1:  hasFileLine 假阳性         → recon 打分不准
P1:  hasRiskSignal 假阳性       → recon 打分不准
P1:  --omp 死代码               → 对抗审查不可用
P1:  test-journal 断言错误字段   → 假通过
─────────────────────────────────────
P2:  ContextLedger.remove 不清理 → LRU 异常
P2:  estimateTokens 偏低        → budget 估算不准
P2:  边界测试缺口               → 覆盖率不足
P2:  集成场景缺口               → 覆盖不足
```
