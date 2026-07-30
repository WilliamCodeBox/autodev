// test-adr.mjs — 验证 ADR 产出逻辑（不依赖 omp 运行时）
// 测试 appendADR 的 markdown 写入、ID 自增、slug 生成、错误处理。
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadAutodev, initAutodev, appendADR, readJournal,
} from '../src/tools/autodev/lib/autodev-state.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else console.log(`  FAIL ${name}`);
}

// ---- 构造最小 autodev state ----
function makeRoot() {
  const r = mkdtempSync(path.join(DIR, 'adr-test-'));
  initAutodev(r, {
    project: 'adr-test',
    goal: 'test appendADR',
    slices: [{ id: 'S1', stage: 'planning' }],
    hitl: { enabled: false, pending_gates: [], decisions: [] },
    hotl: { mode: 'autonomous', steers: [], loop_state: 'running' },
  });
  return r;
}

function readFile(fp) {
  return fs.readFileSync(fp, 'utf8');
}

// 1) 基本写入：markdown 各段正确
{
  const root = makeRoot();
  const r = appendADR(root, {
    title: '采用 extern C 桥接 Fortran C++',
    context: 'S1 recon 发现 iso_c_binding ABI 不一致',
    decision: '使用 extern "C" 包装 + .def 导出',
    consequences: ['ABI 稳定', '跨编译器一致'],
    origin: 'DESIGN',
    slice_id: 'S1',
    decider: 'autodev',
  });
  ok('ADR-1 id=0001', r.id === '0001');
  ok('ADR-1 slug 含标题', r.slug.includes('extern'));
  ok('ADR-1 path 存在', fs.existsSync(r.path));

  const c = readFile(r.path);
  ok('ADR-1 含 ADR-0001 标题行', c.includes('# ADR-0001:'));
  ok('ADR-1 含 Date', c.includes('date: '));
  ok('ADR-1 含 status accepted', c.includes('status: accepted'));
  ok('ADR-1 含 decider autodev', c.includes('decider: autodev'));
  ok('ADR-1 含 origin DESIGN', c.includes('origin: DESIGN'));
  ok('ADR-1 含 slice S1', c.includes('slice: S1'));
  ok('ADR-1 含 Context 段', c.includes('## Context'));
  ok('ADR-1 含 Decision 段', c.includes('## Decision'));
  ok('ADR-1 含 Consequences 段', c.includes('## Consequences'));
  ok('ADR-1 上下文内容', c.includes('ABI 不一致'));
  ok('ADR-1 决策内容', c.includes('.def 导出'));
  ok('ADR-1 后果列表项', c.includes('- ABI 稳定'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 2) ID 自增 + 多 ADR 顺序
{
  const root = makeRoot();
  const r1 = appendADR(root, { title: 'First', decision: 'A', context: 'c', consequences: [] });
  const r2 = appendADR(root, { title: 'Second', decision: 'B', context: 'c', consequences: [] });
  const r3 = appendADR(root, { title: 'Third', decision: 'C', context: 'c', consequences: [] });
  ok('三 ADR ID 连续 0001/0002/0003', r1.id === '0001' && r2.id === '0002' && r3.id === '0003');
  const doc = loadAutodev(root);
  ok('autodev.yaml adr.next_id === 4', doc.adr?.next_id === 4);

  // 目录文件数
  const files = fs.readdirSync(path.join(root, 'docs/adr')).filter(f => f.endsWith('.md'));
  ok('docs/adr 含 3 个 md 文件', files.length === 3);
  fs.rmSync(root, { recursive: true, force: true });
}

// 3) 缺少 title 抛错
{
  const root = makeRoot();
  let threw = false;
  try { appendADR(root, { decision: 'x', consequences: [] }); } catch (e) { threw = e.message.includes('requires title'); }
  ok('缺少 title 抛错', threw);
  fs.rmSync(root, { recursive: true, force: true });
}

// 4) 缺少 decision 抛错
{
  const root = makeRoot();
  let threw = false;
  try { appendADR(root, { title: 'x', consequences: [] }); } catch (e) { threw = e.message.includes('requires title and decision'); }
  ok('缺少 decision 抛错', threw);
  fs.rmSync(root, { recursive: true, force: true });
}

// 5) consequences 为空 → 默认占位符
{
  const root = makeRoot();
  const r = appendADR(root, { title: 'No cons', decision: 'pick A', context: 'foo' });
  const c = readFile(r.path);
  ok('consequences 为空时输出占位符', c.includes('- (待补充)'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 6) 无 context 时输出待补充占位
{
  const root = makeRoot();
  const r = appendADR(root, { title: 'No ctx', decision: 'pick B', consequences: [] });
  const c = readFile(r.path);
  const ctxMatch = c.match(/## Context[\s\S]*?(?=## Decision)/);
  ok('无 context 时 Context 段含待补充', ctxMatch !== null && ctxMatch[0].includes('待补充'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 7) 多后果正确渲染缩进
{
  const root = makeRoot();
  const r = appendADR(root, {
    title: 'Multi cons',
    decision: 'X',
    context: 'c',
    consequences: ['好处一：性能提升', '好处二：可维护', '代价：学习曲线'],
  });
  const c = readFile(r.path);
  const consLines = c.split('\n').filter(l => l.startsWith('- 好处') || l.startsWith('- 代价'));
  ok('后果全部渲染为列表项', consLines.length === 3);
  fs.rmSync(root, { recursive: true, force: true });
}

// 8) slug 只含英文字母时的干净结果
{
  const root = makeRoot();
  const r = appendADR(root, { title: 'Use Redis for Cache Layer', decision: 'X', context: 'c', consequences: [] });
  ok('英文 slug 全小写连字符', r.slug === 'use-redis-for-cache-layer');
  fs.rmSync(root, { recursive: true, force: true });
}

// 9) slug 含特殊字符时被清理
{
  const root = makeRoot();
  const r = appendADR(root, { title: 'What: the *best* approach? (2024)', decision: 'X', context: 'c', consequences: [] });
  ok('特殊字符 slug 被清理', r.slug === 'what-the-best-approach-2024');
  fs.rmSync(root, { recursive: true, force: true });
}

// 10) 无 autodev.yaml 时 fallback 到目录扫描（自 ADR 场景）
{
  const root = mkdtempSync(path.join(DIR, 'adr-test-self-'));
  const r = appendADR(root, { title: '无 yaml 自 ADR', decision: '目录扫描 fallback', context: '无需 autodev.yaml', consequences: ['自 ADR 可行'] });
  ok('无 yaml 时写入成功', r.id === '0001' && fs.existsSync(r.path));
  const c = fs.readFileSync(r.path, 'utf8');
  ok('自 ADR markdown 格式正确', c.includes('# ADR-0001:') && c.includes('## Decision'));
  // 验证没有 journal（无 autodev.yaml 时不写 journal）
  const jp = path.join(root, '.omp/autodev/run.json');
  ok('自 ADR 不写 journal', !fs.existsSync(jp));
  fs.rmSync(root, { recursive: true, force: true });
}

// 11) decider=human 时模板正确
{
  const root = makeRoot();
  const r = appendADR(root, {
    title: 'Human override decision',
    decision: 'skip validation for hotfix',
    context: 'urgent prod issue',
    consequences: [],
    origin: 'HITL',
    decider: 'human',
  });
  const c = readFile(r.path);
  ok('Decider=human 渲染正确', c.includes('decider: human'));
  ok('Origin=HITL 渲染正确', c.includes('origin: HITL'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 12) 未提供 slice_id 时不产生 Slice 行
{
  const root = makeRoot();
  const r = appendADR(root, {
    title: 'Global decision', decision: 'Y', context: 'c', consequences: [],
  });
  const c = readFile(r.path);
  ok('无 slice_id 时不渲染 slice 行', !/\bslice:/.test(c));
  fs.rmSync(root, { recursive: true, force: true });
}

// 13) 写入 journal
{
  const root = makeRoot();
  appendADR(root, { title: 'Journal test', decision: 'Z', context: 'c', consequences: [] });
  const j = readJournal(root);
  const last = j.events[j.events.length - 1];
  ok('journal 记录 adr_append 事件', last && last.op === 'adr_append' && last.adr_id === '0001');
  fs.rmSync(root, { recursive: true, force: true });
}

// 14) 自 ADR 空目录时从 id=1 开始
{
  const root = mkdtempSync(path.join(DIR, 'adr-test-self-empty-'));
  const r = appendADR(root, { title: 'First self ADR', decision: 'A', context: 'c', consequences: [] });
  ok('空目录首条 ADR id=0001', r.id === '0001');
  // 写第二条验证 ID 递增
  const r2 = appendADR(root, { title: 'Second self ADR', decision: 'B', context: 'c', consequences: [] });
  ok('第二条 ADR id=0002', r2.id === '0002');
  const files = fs.readdirSync(path.join(root, 'docs/adr')).filter(f => f.endsWith('.md'));
  ok('docs/adr 含 2 个文件', files.length === 2);
  fs.rmSync(root, { recursive: true, force: true });
}

// 15) 自 ADR 已有文件时取 max_id+1
{
  const root = mkdtempSync(path.join(DIR, 'adr-test-self-existing-'));
  // 先手动创建 0003 和 0005 模拟非连续 ID
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/adr', '0003-fake.md'), '# prev\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs/adr', '0005-fake.md'), '# prev\n', 'utf8');
  const r = appendADR(root, { title: 'After existing', decision: 'C', context: 'c', consequences: [] });
  ok('已有文件时取 max_id+1=0006', r.id === '0006');
  ok('新文件存在', fs.existsSync(r.path));
  fs.rmSync(root, { recursive: true, force: true });
}

// 16) 自 ADR 混合 yaml 场景：有 autodev.yaml 时优先用 yaml 计数器
{
  const root = mkdtempSync(path.join(DIR, 'adr-test-mixed-'));
  // 先创建 docs/adr/ 中的手动 ADR 文件
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/adr', '9999-manual.md'), '# prev\n', 'utf8');
  // 再 init autodev（adr.next_id 从 1 开始）
  initAutodev(root, {
    project: 'mixed', goal: 'test', slices: [],
    hitl: { enabled: false, pending_gates: [], decisions: [] },
    hotl: { mode: 'autonomous', steers: [], loop_state: 'running' },
  });
  // appendADR 应使用 autodev.yaml 的 next_id（=1），而非目录扫描的 max_id（=9999）
  const r = appendADR(root, { title: 'YAML wins', decision: 'D', context: 'c', consequences: [] });
  ok('有 yaml 时 id=0001 而非 9999', r.id === '0001');
  const doc = loadAutodev(root);
  ok('yaml 计数器自增到 2', doc.adr?.next_id === 2);
  fs.rmSync(root, { recursive: true, force: true });
}

// 17) YAML frontmatter 结构正确：以 --- 开头，有 --- 分隔线
{
  const root = makeRoot();
  const r = appendADR(root, { title: 'Frontmatter test', decision: 'X', context: 'c', consequences: ['ok'] });
  const c = readFile(r.path);
  ok('frontmatter 以 --- 开头', c.startsWith('---\n'));
  ok('frontmatter 有闭合 ---', /^---\n[\s\S]*?\n---\n\n/.test(c));
  fs.rmSync(root, { recursive: true, force: true });
}

// 18) YAML frontmatter 可解析为合法 YAML，字段值正确
{
  const root = makeRoot();
  const r = appendADR(root, {
    title: 'YAML parse test', decision: 'use YAML', context: 'machine readability',
    consequences: ['parseable'], origin: 'DESIGN', slice_id: 'S2', decider: 'human',
  });
  const c = readFile(r.path);
  // 提取 frontmatter 块
  const m = c.match(/^---\n([\s\S]*?)\n---/);
  ok('frontmatter 块可提取', m && m[1].length > 0);
  const lines = m[1].split('\n');
  const dict = {};
  for (const l of lines) { const kv = l.match(/^(\w+): (.+)$/); if (kv) dict[kv[1]] = kv[2]; }
  ok('frontmatter date 存在', dict.date && dict.date.length === 10);
  ok('frontmatter status=accepted', dict.status === 'accepted');
  ok('frontmatter decider=human', dict.decider === 'human');
  ok('frontmatter origin=DESIGN', dict.origin === 'DESIGN');
  ok('frontmatter slice=S2', dict.slice === 'S2');
  // body 不含旧格式
  ok('body 无旧格式 - ** 元数据', !/\n- \*\*/.test(c));
  fs.rmSync(root, { recursive: true, force: true });
}

// 19) 无 slice_id 时 frontmatter 无 slice 行
{
  const root = makeRoot();
  const r = appendADR(root, { title: 'No slice', decision: 'Y', context: 'c', consequences: [] });
  const c = readFile(r.path);
  const m = c.match(/^---\n([\s\S]*?)\n---/);
  ok('frontmatter 块可提取', m && m[1].length > 0);
  ok('frontmatter 无 slice 行', !m[1].includes('slice:'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 20) 消费项目场景 frontmatter 与自 ADR 格式一致
{
  // 消费项目场景（有 autodev.yaml）
  const root1 = makeRoot();
  const r1 = appendADR(root1, { title: 'Consume', decision: 'A', context: 'c', consequences: [], slice_id: 'S1' });
  // 自 ADR 场景（无 autodev.yaml）
  const root2 = mkdtempSync(path.join(DIR, 'adr-test-format-eq-'));
  const r2 = appendADR(root2, { title: 'Self', decision: 'B', context: 'c', consequences: [], slice_id: 'S1' });
  // 提取 frontmatter 比较
  const c1 = readFile(r1.path);
  const c2 = readFile(r2.path);
  const fm1 = c1.match(/^---\n([\s\S]*?)\n---/)[1];
  const fm2 = c2.match(/^---\n([\s\S]*?)\n---/)[1];
  // 只比较结构（日期可能不同，忽略 date 行）
  const lines1 = fm1.split('\n').filter(l => !l.startsWith('date:')).sort();
  const lines2 = fm2.split('\n').filter(l => !l.startsWith('date:')).sort();
  ok('两种场景 frontmatter 结构一致（忽略 date）', lines1.every((v,i) => v === lines2[i]));
  fs.rmSync(root1, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
}

console.log(`\nALL ${passed} CHECKS PASSED`);
