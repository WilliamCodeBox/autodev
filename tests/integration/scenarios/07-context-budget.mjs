// 07-context-budget.mjs — 上下文预算护栏
// 验证 evaluateReadGate 三态 + ContextLedger LRU 驱逐
import fs from 'node:fs';
import path from 'node:path';
import {
  estimateTokens, resolveModelMax, checkBudget, evaluateReadGate,
  ContextLedger, getContextBudget,
} from '../lib/state.mjs';

export const name = 'context-budget';
export const description = '上下文预算护栏: 三态 zone 判定 / LRU 驱逐 / readGate 硬拒绝';

export async function run(root, check) {
  // ── estimateTokens ──
  check('英文 token < 长度', estimateTokens('hello world') < 20);
  const zh = '这是一个比较长的中文句子，用来估计 token 数量';
  const e = estimateTokens(zh);
  check('中文 token 保守（字数*0.5 < 结果 < 字数*2）', e > zh.length * 0.5 && e < zh.length * 2);

  // ── resolveModelMax ──
  check('override 优先', resolveModelMax(200000, 128000) === 128000);
  check('无 override 用传入值', resolveModelMax(200000) === 200000);
  check('无传入值用默认', resolveModelMax(undefined) === 200000);

  // ── checkBudget 三态 ──
  // modelMax=200000, budget={ targetPct: 0.40, hardCeilingPct: 0.50 }
  // green: < 80000; amber: 80000~99999; red: >= 100000
  const b = { targetPct: 0.40, hardCeilingPct: 0.50 };
  check('green: used=50000', checkBudget(50000, 200000, b) === 'green');
  check('amber: used=90000', checkBudget(90000, 200000, b) === 'amber');
  check('red: used=100000', checkBudget(100000, 200000, b) === 'red');

  // ── evaluateReadGate ──
  check('green → allowed', evaluateReadGate(50000, 1000, 200000, b).allowed === true);
  check('red → refused', evaluateReadGate(100000, 1000, 200000, b).allowed === false);
  check('amber + 较大 incoming → refused', evaluateReadGate(80000, 25000, 200000, b).allowed === false);
  check('amber + 小 incoming → refused (amber 需 evict)', evaluateReadGate(80000, 500, 200000, b).allowed === false);

  // ── ContextLedger LRU 驱逐 ──
  // API: add(ref, tokens), pin(ref, tokens), used (getter), evictLowest()
  const ledger = new ContextLedger();

  ledger.pin('goal', 1000);
  ledger.add('slice-summary', 80000);
  check('加载 2 项后 used=81000', ledger.used === 81000);

  // 驱逐（LRU 顺序 = insertion order, pinned 除外）
  const evicted = ledger.evictLowest();
  check('evictLowest 返回非 pinned 项', evicted?.ref === 'slice-summary' && evicted?.tokens === 80000);
  check('驱逐后 used=1000', ledger.used === 1000);

  // pinned 永不驱逐
  const evicted2 = ledger.evictLowest();
  check('只有 pinned 时 evictLowest 返回 null', evicted2 === null);
  check('pinned 项保留', ledger.used === 1000);

  // ── getContextBudget 缺省 ──
  const budget = getContextBudget({});
  check('缺省 targetPct >= 0.3', budget.targetPct >= 0.3);
  check('缺省 hardCeilingPct >= 0.4', budget.hardCeilingPct >= 0.4);
}
