// integration/runner.mjs — autodev 集成测试运行器
//
// 每个场景 export 一个 run(root, ok) 函数，自行 import state lib。
// runner 负责创建 temp dir、收集结果、调用对抗审查。
//
// 用法：
//   node tests/run-integration.mjs              # state-level only
//   node tests/run-integration.mjs --omp        # + 对抗审查
//   node tests/run-integration.mjs --filter X   # 按文件名过滤
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function runScenario(scenarioPath) {
  const scenario = await import(scenarioPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-int-'));
  const start = Date.now();

  let pass = 0, fail = 0;
  const checks = [];

  function check(label, cond) {
    if (cond) { pass++; checks.push({ status: 'pass', label }); }
    else { fail++; checks.push({ status: 'fail', label }); }
  }

  console.log(`\n=== ${scenario.name} ===`);
  if (scenario.description) console.log(`  ${scenario.description}`);

  // 运行场景（场景自行 import state lib、驱动生命周期）
  try {
    await scenario.run(root, check);
  } catch (e) {
    check(`scenario threw: ${e.message}`, false);
    console.error(`  ${e.stack}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  for (const c of checks) {
    console.log(`  ${c.status === 'pass' ? '✓' : '✗'} ${c.label}`);
  }
  console.log(`  → ${pass} passed, ${fail} failed (${elapsed}s)`);

  return { name: scenario.name, pass, fail, elapsed, root };
}

export async function runAll({ filter } = {}) {
  const dir = fileURLToPath(new URL('./scenarios/', import.meta.url));
  const entries = fs.readdirSync(dir).filter(e => e.endsWith('.mjs'));
  if (filter) {
    const matched = entries.filter(e => e.includes(filter));
    if (matched.length === 0) { console.log(`No scenarios match "${filter}"`); return { pass: 0, fail: 0 }; }
  }

  let total = { pass: 0, fail: 0 };
  for (const entry of entries) {
    if (filter && !entry.includes(filter)) continue;
    const r = await runScenario(pathToFileURL(path.join(dir, entry)).href);
    total.pass += r.pass;
    total.fail += r.fail;
  }
  console.log(`\n=== 集成测试汇总: ${total.pass} 通过, ${total.fail} 失败 ===`);
  return total;
}
