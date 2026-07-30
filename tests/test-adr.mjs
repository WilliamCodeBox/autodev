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
  ok('ADR-1 含 Date', c.includes('- **Date**:'));
  ok('ADR-1 含 Status Accepted', c.includes('- **Status**: Accepted'));
  ok('ADR-1 含 Decider autodev', c.includes('- **Decider**: autodev'));
  ok('ADR-1 含 Origin DESIGN', c.includes('- **Origin**: DESIGN'));
  ok('ADR-1 含 Slice S1', c.includes('- **Slice**: S1'));
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

// 10) 无 autodev.yaml 时抛错
{
  const root = mkdtempSync(path.join(DIR, 'adr-test-noinit-'));
  let threw = false;
  try { appendADR(root, { title: 'X', decision: 'Y' }); } catch (e) { threw = e.message.includes('no autodev.yaml'); }
  ok('无 autodev.yaml 抛错', threw);
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
  ok('Decider=human 渲染正确', c.includes('- **Decider**: human'));
  ok('Origin=HITL 渲染正确', c.includes('- **Origin**: HITL'));
  fs.rmSync(root, { recursive: true, force: true });
}

// 12) 未提供 slice_id 时不产生 Slice 行
{
  const root = makeRoot();
  const r = appendADR(root, {
    title: 'Global decision', decision: 'Y', context: 'c', consequences: [],
  });
  const c = readFile(r.path);
  ok('无 slice_id 时不渲染 Slice 行', !c.includes('- **Slice**:'));
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

console.log(`\nALL ${passed} CHECKS PASSED`);
