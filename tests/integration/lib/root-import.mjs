// integration/lib/root-import.mjs — 项目根解析工具
// 场景文件在 tests/integration/scenarios/ 下，import 需要相对于项目根
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 根 = tests/integration/lib/ 向上 3 级
const _this = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(_this, '..', '..', '..', '..');

export function projectPath(...segments) {
  return path.join(ROOT, ...segments);
}

// 文件 URL 形式的 path，直接给 import() 用
import { pathToFileURL } from 'node:url';
export function projectUrl(...segments) {
  return pathToFileURL(projectPath(...segments)).href;
}
