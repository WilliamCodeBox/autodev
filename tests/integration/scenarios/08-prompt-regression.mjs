// 08-prompt-regression.mjs — 提示词行为回归测试场景
//
// 注意事项：
//   - 这个场景不能在纯 node 环境运行——它需要 eval cell 的 completion() 函数。
//   - 在集成测试运行器中自动跳过（打印运行指引）。
//   - 要真正运行，在 eval cell 中执行以下代码：
//
//     ```js
//     import { run } from '../prompt-behavior.mjs';
//     const checks = [];
//     function ok(name, cond) { checks.push({ name, pass: cond }); }
//     await run(ok, completion);
//     const fail = checks.filter(c => !c.pass);
//     console.log(`\n行为回归: ${checks.length - fail.length}/${checks.length} 通过`);
//     if (fail.length) { console.log('失败项:'); fail.forEach(f => console.log(`  ✗ ${f.name}`)); }
//     ```
//
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'prompt-regression';
export const description = '提示词行为回归：验证 LLM 遵循 subagent 双通道契约、mandatory 不变式、schema 输出约束';

export async function run(root, check) {
  console.log('');
  console.log('  [SKIP] prompt-behavior test 需要 eval cell 的 completion() 函数。');
  console.log('  在 eval cell 中运行:');
  console.log('');
  console.log('    import { run } from \'../tests/prompt-behavior.mjs\';');
  console.log('    const checks = [];');
  console.log('    function ok(name, cond) { checks.push({ name, pass: cond }); }');
  console.log('    await run(ok, completion);');
  console.log('    const fail = checks.filter(c => !c.pass);');
  console.log('    console.log(`${checks.length - fail.length}/${checks.length} 通过`);');
  console.log('    fail.forEach(f => console.log(`  ✗ ${f.name}`));');
  console.log('');
  check('prompt 行为回归（跳过，见上文指引）', true);
}
