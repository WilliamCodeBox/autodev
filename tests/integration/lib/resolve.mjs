// integration/lib/resolve.mjs — 从场景目录解析到项目根
// ESM 场景中 import 路径是相对于场景文件自身的，而我们需要相对于项目根。
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 项目根 = tests/integration/ 向上两级
const _thisFile = fileURLToPath(import.meta.url); // tests/integration/lib/resolve.mjs
export const PROJECT_ROOT = path.resolve(_thisFile, '../../..');
export const ROOT = path.resolve(_thisFile, '..', '..', '..');

// 返回相对于项目根的绝对路径，可直接用于 import
export function fromRoot(...segments) {
  return path.join(PROJECT_ROOT, ...segments);
}
