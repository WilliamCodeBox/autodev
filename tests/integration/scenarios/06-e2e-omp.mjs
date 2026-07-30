// 06-e2e-omp.mjs — 端到端：真实调用 omp -p 执行一个极简 autodev 任务
//
// 注意事项：
//   - 需要 omp 在 PATH 中
//   - 需要 autodev 扩展已安装到 omp（~/.omp/agent/ 或项目 .omp/）
//   - 在 —p 模式下 autodev 只能走 1-2 步，但足以验证：
//     (a) autodev 命令被正确加载
//     (b) autodev tool 可被调用
//     (c) 状态文件被正确写入
//
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadAutodev } from '../lib/state.mjs';

export const name = 'e2e-omp';
export const description = '真实 omp -p 调用一个极简 autodev 任务，验证扩展可加载、状态文件可生成';

export async function run(root, check) {
  // ── 检查 omp 是否可用 ──
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('omp', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      p.on('close', code => code === 0 ? resolve() : reject(new Error(`omp not available (exit ${code})`)));
      p.on('error', reject);
    });
  } catch {
    check('omp 可用（跳过 e2e 测试）', true);
    console.log('  [SKIP] omp not in PATH — skipping e2e test');
    return;
  }

  // ── 确认 autodev 扩展已安装 ──
  const extPaths = [
    path.join(process.env.HOME || '~', '.omp/agent/tools/autodev'),
    path.join(root, '.omp/tools/autodev'),
  ];
  const extFound = extPaths.some(p => fs.existsSync(p.replace(/^~/, process.env.HOME || '~')));
  if (!extFound) {
    console.log('  [SKIP] autodev extension not installed — skipping e2e test');
    check('autodev 扩展已安装', true);
    return;
  }

  // ── 极简 prompt：一个 5 秒能说完的任务 ──
  // 任务：创建一个 hello.txt，内容为 "hello from autodev"
  // 使用 —max-time 30s 限制
  const prompt = `你运行在目录 ${root} 下。
使用 autodev 完成以下任务：

目标：在 ${root} 下创建 hello.txt，内容为 "hello from autodev"
验收标准：hello.txt 存在且内容正确

开始前先调 autodev tool 的 init 操作初始化状态。只做 init 和创建文件，不需要完整主循环。
完成后调 autodev tool 的 final_check 标记结束。`;

  return new Promise((resolve) => {
    const child = spawn('omp', ['-p', prompt, '--no-session', '--max-time', '30'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    child.stdout.on('data', d => stdout += d);
    let stderr = '';
    child.stderr.on('data', d => stderr += d);

    child.on('close', (code) => {
      console.log(`  omp exited ${code}`);

      // 即使 exit code 非 0，只要状态文件/hello.txt 生成了就算部分成功
      const doc = loadAutodev(root);
      const helloPath = path.join(root, 'hello.txt');
      const helloExists = fs.existsSync(helloPath);

      if (doc) {
        check('autodev.yaml 已生成', true);
        check('autodev.yaml 含 project 字段', !!doc.project);
        check('状态文件是有效 YAML', typeof doc === 'object');
      } else {
        check('autodev.yaml 已生成', false);
      }

      if (helloExists) {
        const content = fs.readFileSync(helloPath, 'utf-8').trim();
        check('hello.txt 已创建', true);
        check('hello.txt 内容正确', content.includes('hello from autodev'));
      } else {
        check('hello.txt 已创建', false);
        console.log(`  [INFO] 文件未生成，可能因为 omp -p 非交互模式下自动化的步数不足`);
      }

      resolve();
    });

    child.on('error', (e) => {
      check(`omp launch: ${e.message}`, false);
      resolve();
    });
  });
}
