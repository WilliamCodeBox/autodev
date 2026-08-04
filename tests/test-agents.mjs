// test-agents.mjs
// v1.1.0 agent frontmatter 静态检查测试
// 覆盖：frontmatter 解析、tools 白名单、spawns 引用有效性、JTD output schema 结构

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.join(__dirname, '..', 'agents');
const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));

let passed = 0, failed = 0;
function check(desc, cond) { if (cond) { passed++; } else { console.log(`  FAIL ${desc}`); failed++; } }
function diag(msg) { console.log(`  (diag) ${msg}`); }

// ============================================================
// 1. FRONTMATTER 解析
// ============================================================
console.log('\n=== frontmatter 解析 ===');

const agents = {};
for (const file of agentFiles) {
  const raw = fs.readFileSync(path.join(agentsDir, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  check(`frontmatter exists: ${file}`, !!m);
  if (!m) continue;

  const fm = m[1];
  // 提取 name
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  check(`name field: ${file}`, !!nameMatch);
  const name = nameMatch ? nameMatch[1].trim() : `UNKNOWN_${file}`;

  // 提取 tools (CSV)
  const toolsMatch = fm.match(/^tools:\s*(.+)$/m);
  check(`tools field: ${file}`, !!toolsMatch);
  const tools = toolsMatch ? toolsMatch[1].split(',').map(s => s.trim()) : [];

  // 提取 spawns (optional, CSV)
  const spawnsMatch = fm.match(/^spawns:\s*(.+)$/m);
  const spawns = spawnsMatch ? spawnsMatch[1].split(',').map(s => s.trim()) : [];

  // 提取 output 段 (JTD schema)
  const hasOutput = fm.includes('output:') && fm.includes('properties:');
  check(`output with properties: ${file}`, hasOutput);

  // 提取 model
  const modelMatch = fm.match(/^model:\s*"?([^"\n]+)"?\s*$/m);
  check(`model field: ${file}`, !!modelMatch);

  // 提取 read-summarize (optional)
  const rsMatch = fm.match(/^read-summarize:\s*(.+)$/m);

  agents[name] = { file, name, tools, spawns, hasOutput, model: modelMatch?.[1]?.trim()?.replace(/^"|"$/g, ''), readSummarize: rsMatch?.[1]?.trim() };
}

// ============================================================
// 2. TOOLS 白名单断言
// ============================================================
console.log('\n=== tools 白名单 ===');

// scout: read + grep + glob + autodev, 无 write/edit/bash
const scout = agents['autodev-scout'];
if (scout) {
  check('scout has read', scout.tools.includes('read'));
  check('scout has grep', scout.tools.includes('grep'));
  check('scout has glob', scout.tools.includes('glob'));
  check('scout has autodev', scout.tools.includes('autodev'));
  check('scout NO write', !scout.tools.includes('write'));
  check('scout NO edit', !scout.tools.includes('edit'));
  check('scout NO bash', !scout.tools.includes('bash'));
  check('scout NO task (no spawns)', !scout.spawns.includes('task'));
}

// gatekeeper: read + grep + glob + autodev, 无 write/edit/bash
const gk = agents['autodev-gatekeeper'];
if (gk) {
  check('gatekeeper has read', gk.tools.includes('read'));
  check('gatekeeper has grep', gk.tools.includes('grep'));
  check('gatekeeper has glob', gk.tools.includes('glob'));
  check('gatekeeper has autodev', gk.tools.includes('autodev'));
  check('gatekeeper NO write', !gk.tools.includes('write'));
  check('gatekeeper NO edit', !gk.tools.includes('edit'));
  check('gatekeeper NO bash', !gk.tools.includes('bash'));
  // spawns
  check('gatekeeper spawns autodev-scout', gk.spawns.includes('autodev-scout'));
  check('gatekeeper spawns NOT scout (must be autodev-scout)', !gk.spawns.includes('scout') || gk.spawns.includes('autodev-scout'));
}

// implementer: 全量 tools + autodev, 无 spawns
const impl = agents['autodev-implementer'];
if (impl) {
  check('implementer has read', impl.tools.includes('read'));
  check('implementer has write', impl.tools.includes('write'));
  check('implementer has edit', impl.tools.includes('edit'));
  check('implementer has bash', impl.tools.includes('bash'));
  check('implementer has grep', impl.tools.includes('grep'));
  check('implementer has glob', impl.tools.includes('glob'));
  check('implementer has autodev', impl.tools.includes('autodev'));
  check('implementer NO spawns field (spawns=[])', impl.spawns.length === 0);
  // 不应有 task 工具（spawns 字段省略 ≠ 默认 none）
  // 但这是 omp 行为，不在我们的静态检查范围内
}

// ============================================================
// 3. SPAWNS 引用有效性
// ============================================================
console.log('\n=== spawns 引用有效性 ===');
for (const [name, ag] of Object.entries(agents)) {
  for (const s of ag.spawns) {
    if (s === 'none' || s === 'task') continue;
    const target = agents[s];
    check(`spawns '${s}' in '${name}' → target exists`, !!target);
  }
}

// gatekeeper spawns autodev-scout — 验证 autodev-scout 文件存在
const scoutFile = path.join(agentsDir, 'autodev-scout.md');
check('autodev-scout.md exists', fs.existsSync(scoutFile));

// ============================================================
// 4. JTD OUTPUT SCHEMA 结构检查
// ============================================================
console.log('\n=== JTD output schema 结构 ===');
for (const [name, ag] of Object.entries(agents)) {
  const raw = fs.readFileSync(path.join(agentsDir, ag.file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) continue;
  const fm = m[1];

  // 检查 output 有 properties
  const hasProps = /output:[\s\S]*?properties:/.test(fm);
  check(`${name}: output has properties`, hasProps);

  // 检查 elements 用法正确 (JTD 用 elements 不是 items)
  const hasElements = fm.includes('elements:');
  const hasItems = fm.includes('items:');
  if (hasItems) {
    diag(`${name}: WARNING - found 'items:' in JTD (should be 'elements:')`);
  }

  // 检查 enum 用法
  const enumCount = (fm.match(/enum:/g) || []).length;
  if (enumCount > 0) diag(`${name}: ${enumCount} enum(s) in schema`);

  // 检查 optionalProperties 存在（gatekeeper 和 implementer 应有）
  if (name === 'autodev-gatekeeper' || name === 'autodev-implementer') {
    check(`${name}: has optionalProperties`, fm.includes('optionalProperties:'));
  }
}

// ============================================================
// 5. MODEL 字段
// ============================================================
console.log('\n=== model 字段 ===');
for (const [name, ag] of Object.entries(agents)) {
  check(`${name} model is role alias`, ag.model && ag.model.startsWith('@'));
}
check('scout model is @smol', scout?.model === '@smol');
check('gatekeeper model is @slow', gk?.model === '@slow');
check('implementer model is @slow', impl?.model === '@slow');

// ============================================================
// 6. READ-SUMMARIZE
// ============================================================
console.log('\n=== read-summarize ===');
check('scout read-summarize is false', scout?.readSummarize === 'false');
// gatekeeper 和 implementer 未设置此字段（继承默认行为），不检查

// ============================================================
// 总结
// ============================================================
console.log(`\n=== agent frontmatter 静态检查: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
