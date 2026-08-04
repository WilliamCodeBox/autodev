// test-guard.mjs
// 验证上下文预算护栏 + handoff 逻辑（node tests/test-guard.mjs）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  estimateTokens, resolveModelMax, checkBudget, evaluateReadGate,
  ContextLedger, getContextBudget, writeHandoff, renderHandoff,
} from '../tools/autodev/lib/autodev-state.mjs';

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  pass++;
  console.log('  ✓', name);
}
function near(name, a, b, eps = 1) {
  assert.ok(Math.abs(a - b) <= eps, `${name}: ${a} vs ${b}`);
  pass++;
  console.log('  ✓', name, `(${a}≈${b})`);
}

console.log('== estimateTokens (保守，中文更贵) ==');
{
  const en = estimateTokens('hello world this is a test of token counting for english text only here');
  const zh = estimateTokens('这是一个用于测试中文 token 估算是否保守的样例文本需要足够长一些才能看出差异');
  ok('中文 token 显著多于同等长度英文-ish', zh > en);
  ok('非空文本 > 0', en > 0 && zh > 0);
  ok('空串为 0', estimateTokens('') === 0);
}

console.log('== resolveModelMax (相对窗口，无 abs cap) ==');
{
  near('override 优先', resolveModelMax(200000, 1000000), 1000000);
  near('读 omp 值', resolveModelMax(256000, undefined), 256000);
  near('兜底默认 200000', resolveModelMax(undefined, undefined), 200000);
}

console.log('== checkBudget 三态（modelMax=200000, target40%, hard50%） ==');
{
  const modelMax = 200000;
  const budget = { targetPct: 0.4, hardCeilingPct: 0.5 };
  ok('used=0 → green', checkBudget(0, modelMax, budget) === 'green');
  ok('used=79999 → green', checkBudget(79999, modelMax, budget) === 'green');
  ok('used=80000 → amber', checkBudget(80000, modelMax, budget) === 'amber');
  ok('used=99999 → amber', checkBudget(99999, modelMax, budget) === 'amber');
  ok('used=100000 → red', checkBudget(100000, modelMax, budget) === 'red');
  ok('used=150000 → red', checkBudget(150000, modelMax, budget) === 'red');
}

console.log('== evaluateReadGate（门核心，纯函数） ==');
{
  const modelMax = 200000;
  const budget = { targetPct: 0.4, hardCeilingPct: 0.5 };
  // 当前 30K，加载 10K → 投影 40K < 80K 目标 → green 允许
  let d = evaluateReadGate(30000, 10000, modelMax, budget);
  ok('read_gate green 允许', d.allowed === true && d.zone === 'green');
  // 当前 75K，加载 10K → 投影 85K ∈ [80K,100K) → amber，需驱逐
  d = evaluateReadGate(75000, 10000, modelMax, budget);
  ok('read_gate amber 拒绝+NEED_EVICT', d.allowed === false && d.zone === 'amber' && d.action === 'evict_then_reload');
  // 当前 98K，加载 10K → 投影 108K ≥ 100K 硬上限 → red，compact/handoff
  d = evaluateReadGate(98000, 10000, modelMax, budget);
  ok('read_gate red 拒绝+CONTEXT_BUDGET_EXCEEDED', d.allowed === false && d.zone === 'red' && d.action === 'compact_or_handoff');
}

console.log('== ContextLedger（乐观记账 + LRU 驱逐，pinned 不驱） ==');
{
  const l = new ContextLedger();
  l.pin('goal', 5000);
  l.add('slice-S1', 20000);
  l.add('recon-x', 15000);
  near('used 求和', l.used, 40000);
  // 驱逐最旧非 pinned（slice-S1）
  const ev = l.evictLowest();
  ok('驱逐了最旧非 pinned', ev && ev.ref === 'slice-S1');
  near('驱逐后 used', l.used, 20000);
  // 再驱逐 → recon-x
  const ev2 = l.evictLowest();
  ok('再驱逐 recon-x', ev2 && ev2.ref === 'recon-x');
  // 只剩 pinned，无可驱逐
  const ev3 = l.evictLowest();
  ok('pinned 永不被驱逐', ev3 === null && l.used === 5000);
}

console.log('== getContextBudget 缺省与显式 ==');
{
  const b1 = getContextBudget({});
  ok('缺省 targetPct=0.4', b1.targetPct === 0.4 && b1.hardCeilingPct === 0.5);
  const b2 = getContextBudget({ contextBudget: { targetPct: 0.35, hardCeilingPct: 0.45 } });
  ok('显式覆盖生效', b2.targetPct === 0.35 && b2.hardCeilingPct === 0.45);
}

console.log('== writeHandoff（durable，5 段，无 Risks） ==');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-handoff-'));
  const p = writeHandoff(tmp, 'S1', {
    state: {
      stage: 'done', gate_status: 'pass', replan_attempts: 0,
      changed_files: [{ path: 'src/reader.cc', status: 'modified' }],
      open_tasks: [{ id: 'T2', status: 'done' }],
    },
    context: ['Decisions: 抽出了 MeshData struct', 'Key findings: 见 local://recon-numerical.md'],
    intent: 'S2 必须完成 Fortran→C++ 边界层，验收见其 2-round 标准',
    returnPath: 'blocked → parent 重规划(≤3) → 仍卡则 PAUSED',
    verification: ['Recall: 覆盖 S1 关键决策', 'Continuation: S2 可独立启动'],
  });
  const md = fs.readFileSync(p, 'utf8');
  ok('文件存在且非空', md.length > 0);
  for (const sec of ['## State', '## Context', '## Intent', '## Return path', '## Verification']) {
    ok(`含段落 ${sec}`, md.includes(sec));
  }
  ok('不含 Risks 段（领域无关）', !md.includes('## Risks'));
  ok('State 含 slice_id/changed_files/open_tasks', md.includes('slice_id: S1') && md.includes('changed_files:') && md.includes('open_tasks:'));
  // 幂等渲染
  const md2 = renderHandoff('S1', {});
  ok('空 data 渲染不崩且有 5 段', ['## State','## Context','## Intent','## Return path','## Verification'].every((s) => md2.includes(s)));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nALL GUARD TESTS PASSED: ${pass}`);
