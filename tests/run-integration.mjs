// run-integration.mjs — autodev 集成测试入口
//
// 用法：
//   node tests/run-integration.mjs              # state-level 全场景
//   node tests/run-integration.mjs --omp        # + 对抗审查（需要 omp + 网络）
//   node tests/run-integration.mjs --filter X   # 按场景名过滤
//   node tests/run-integration.mjs --list       # 列出所有场景
//   node tests/run-integration.mjs --only X     # 只跑指定场景
//
import { runAll } from './integration/runner.mjs';

const args = process.argv.slice(2);
const filter = args.find(a => a.startsWith('--filter='))?.split('=')[1];
const only = args.find(a => a.startsWith('--only='))?.split('=')[1];
const listOnly = args.includes('--list');

if (listOnly) {
  console.log('可用集成测试场景:\n');
  // 动态列出
  const { readdirSync } = await import('fs');
  const { join } = await import('path');
  const { fileURLToPath, pathToFileURL } = await import('url');
  const dir = fileURLToPath(new URL('./integration/scenarios/', import.meta.url));
  for (const e of readdirSync(dir).sort().filter(e => e.endsWith('.mjs'))) {
    const mod = await import(pathToFileURL(join(dir, e)).href);
    console.log(`  ${e.replace('.mjs', '')}: ${mod.description || '(无描述)'}`);
  }
  process.exit(0);
}

const total = await runAll({ filter: only || filter });
process.exit(total.fail > 0 ? 1 : 0);
