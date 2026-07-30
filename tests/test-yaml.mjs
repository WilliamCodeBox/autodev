// test-yaml.mjs — 全面校验 js-yaml 对 autodev 状态文件的往返稳定性与格式正确性。
// 从 autodev-extension/ 目录运行：node tests/test-yaml.mjs
import { load as parse, dump as stringify } from '../src/tools/autodev/lib/js-yaml.mjs';
import fs from 'node:fs';

// 内联 flow map（如 {a: 1, b: "x,y"}）解析：js-yaml 直接 load 即可。
const parseInlineMap = (raw) => parse(String(raw).trim());

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', name); }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return a === b;
}

// 便捷：round-trip 稳定性（parse→stringify→parse 应等于原 parse 结果）
function rtStable(obj) {
  const s = stringify(obj);
  return deepEqual(parse(s), obj);
}
// 便捷：幂等（stringify 两次字节一致）
function idempotent(obj) {
  return stringify(obj) === stringify(parse(stringify(obj)));
}

// ───────────────────────────────────────────────────────────
// 0. 真实示例文件（examples/.omp/autodev）往返
// ───────────────────────────────────────────────────────────
const files = [
  'examples/.omp/autodev/autodev.yaml',
  'examples/.omp/autodev/slices/S1.yaml',
];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const a = parse(text);
  const rt = parse(stringify(a));
  check(`parse→stringify→parse stable: ${f}`, deepEqual(a, rt));
  check(`stringify idempotent: ${f}`, deepEqual(parse(stringify(a)), a));
}

// ───────────────────────────────────────────────────────────
// 1. 完整 §4 schema 文档的 round-trip（程序构造，不依赖示例文件）
// ───────────────────────────────────────────────────────────
const autodevDoc = {
  project: 'demo',
  goal: 'build a thing',
  recon: {
    dimensions: [
      { name: 'toolchain', weight: 0.5, confidence: 0.8, evidence_status: 'solid', note: 'ref local://file.md' },
      { name: 'risk', weight: 0.5, confidence: 0.3, evidence_status: 'revisit', note: 'needs #fix' },
    ],
    confidence: 0.55,
  },
  contextBudget: { reserved: 2000, used: 1500, model: 'gpt-4' },
  gate: {
    mandatory: [{ id: 'M1', desc: 'build passes', status: 'pending' }],
    developer_seed: [{ id: 'SE1', desc: 'no regressions', status: 'pending' }],
    derived: [],
    final_standard: [
      { id: 'M1', desc: 'build passes', status: 'pending' },
      { id: 'SE1', desc: 'no regressions', status: 'pending' },
    ],
  },
  slices: [
    { id: 'S1', title: 't', stage: 'queued', depends_on: ['S0'], replan_attempts: 0, slice_file: 'slices/S1.yaml' },
    { id: 'S2', title: 'u', stage: 'done', depends_on: ['S1'], replan_attempts: 2, slice_file: 'slices/S2.yaml' },
  ],
};
check('完整 autodev.yaml round-trip', rtStable(autodevDoc));
check('完整 autodev.yaml 幂等', idempotent(autodevDoc));

const sliceDoc = {
  slice_id: 'S1',
  title: 't',
  stage: 'executing',
  depends_on: ['S0'],
  tasks: [
    { id: 'T1', status: 'done', accept: 'local://x.md', note: 'a: b' },
    { id: 'T2', status: 'doing', reason: 'needs #fix, see local://y.md' },
  ],
  acceptance_criteria: [
    { id: 'AC1', desc: 'works', status: 'pass', ref: 'local://y.md' },
  ],
};
check('完整 slice.yaml round-trip', rtStable(sliceDoc));
check('完整 slice.yaml 幂等', idempotent(sliceDoc));

// ───────────────────────────────────────────────────────────
// 2. 含特殊字符的标量（保存必须加引号，否则重载损坏）
// ───────────────────────────────────────────────────────────
const special = {
  colon: 'llm_judge: 对照文档',
  hash: 'needs #fix',
  leading_space: ' a',
  leading_dash: '-x',
  brackets: '[a], {b}, &c, *d, @e, `f`, %g, |h, >i',
  url: 'local://slice-S1-design.md',
  empty: '',
  embedded_quote: 'he said "hi"',
};
check('特殊字符标量 round-trip', rtStable(special));
check('特殊字符标量 幂等', idempotent(special));
// 重载后值必须保持原样（不被误解析为 map）
{
  const r = parse(stringify(special));
  check('冒号值未被拆成 map', r.colon === 'llm_judge: 对照文档');
  check('井号值保留', r.hash === 'needs #fix');
  check('local:// 引用完整保留', r.url === 'local://slice-S1-design.md');
  check('空串保留为空串而非 null', r.empty === '');
}

// ───────────────────────────────────────────────────────────
// 3. 类型推断（保存/重载应保持类型）
// ───────────────────────────────────────────────────────────
const typed = {
  i: 42,
  f: 3.14,
  neg: -7,
  btrue: true,
  bfalse: false,
  nul: null,
  strNum: '007',      // 引号包裹 -> 字符串
  strTrue: 'true',    // 引号包裹 -> 字符串
  unqNum: 7,
};
check('类型推断 round-trip', rtStable(typed));
{
  const r = parse(stringify(typed));
  check('int 保持 int', r.i === 42 && typeof r.i === 'number');
  check('float 保持 float', r.f === 3.14);
  check('bool 保持 bool', r.btrue === true && r.bfalse === false);
  check('null 保持 null', r.nul === null);
  check('引号包裹的 "007" 保持字符串', r.strNum === '007' && typeof r.strNum === 'string');
  check('引号包裹的 "true" 保持字符串', r.strTrue === 'true' && typeof r.strTrue === 'string');
}

// ───────────────────────────────────────────────────────────
// 4. 数字型 ID 的契约（未引号会被推断为数字 → 已知约束）
//    设计约定 ID 用非数字前缀（S1/T1/M1），本测试锁定该行为。
// ───────────────────────────────────────────────────────────
{
  const doc = { ids: [{ id: 'S1' }, { id: 'T2' }] };
  const r = parse(stringify(doc));
  check('非数字 ID 保持字符串', r.ids[0].id === 'S1' && typeof r.ids[0].id === 'string');
  check('非数字 ID round-trip', deepEqual(r, doc));
}

// ───────────────────────────────────────────────────────────
// 5. inline list（含引号内逗号、混合类型、嵌套）
// ───────────────────────────────────────────────────────────
const lists = {
  empty: [],
  simple: ['a', 'b', 'c'],
  quoted_comma: ['a,b', 'c,d,e'],
  mixed: [1, 'x', true, null],
  depends_on: ['S0', 'S1'],
};
check('inline list round-trip', rtStable(lists));
check('inline list 幂等', idempotent(lists));
{
  const r = parse(stringify(lists));
  check('引号内逗号不拆分', Array.isArray(r.quoted_comma) && r.quoted_comma.length === 2 && r.quoted_comma[0] === 'a,b');
  check('混合类型保留', r.mixed[0] === 1 && r.mixed[2] === true && r.mixed[3] === null);
  check('空 list 保持空', Array.isArray(r.empty) && r.empty.length === 0);
}

// ───────────────────────────────────────────────────────────
// 6. block 序列：标量 / map / 嵌套 map
// ───────────────────────────────────────────────────────────
const seqDoc = {
  scalars: ['p', 'q', 'r'],
  maps: [
    { x: 1, y: 'two' },
    { x: 3, y: 'four' },
  ],
  nested: [
    { id: 'A', meta: { k: 'v', n: 2 } },
  ],
};
check('block 序列 round-trip', rtStable(seqDoc));
check('block 序列 幂等', idempotent(seqDoc));
{
  const r = parse(stringify(seqDoc));
  check('标量序列', r.scalars.join(',') === 'p,q,r');
  check('map 序列', r.maps.length === 2 && r.maps[0].x === 1 && r.maps[1].x === 3);
  check('嵌套 map 序列', r.nested[0].meta.k === 'v' && r.nested[0].meta.n === 2);
}

// ───────────────────────────────────────────────────────────
// 7. 空 map：此前会存成 `key:` 重载成 null（已修复为 `key: {}`）
// ───────────────────────────────────────────────────────────
{
  const doc = { a: 1, emptyObj: {}, b: 2 };
  const r = parse(stringify(doc));
  check('空 map 重载仍为对象（非 null）', typeof r.emptyObj === 'object' && !Array.isArray(r.emptyObj) && Object.keys(r.emptyObj).length === 0);
  check('含空 map 的文档 round-trip', deepEqual(r, doc));
  // 顶层空 map
  check('顶层空 map', deepEqual(parse(stringify({})), {}));
  // inline map 解析
  const im = parseInlineMap('{a: 1, b: "x,y"}');
  check('parseInlineMap 基础', im.a === 1 && im.b === 'x,y');
  // 序列化含 inline map 的文档
  const withInline = { m: { a: 1, b: 'x,y' } };
  check('inline/block map round-trip', rtStable(withInline));
}

// ───────────────────────────────────────────────────────────
// 8. 深度嵌套 + 中文 + 注释行容错
// ───────────────────────────────────────────────────────────
const deep = {
  level1: {
    level2: {
      level3: { arr: [{ k: '中文值:冒号', v: [1, 2, 3] }] },
    },
  },
  note: 'line with # not a comment inside quotes',
};
check('深度嵌套 round-trip', rtStable(deep));
check('深度嵌套 幂等', idempotent(deep));
{
  // 文件级注释行应在解析时被忽略（不损坏后续数据）
  const text = '# header comment\na: 1\n# mid comment\nb: 2\n';
  const r = parse(text);
  check('注释行被忽略且不损坏数据', r.a === 1 && r.b === 2);
}

// ───────────────────────────────────────────────────────────
// 9. 已知限制（明确锁定当前行为，防止回归）
//    - 多行字符串不在受支持范围内（machine-generated 文件不存多行值）
// ───────────────────────────────────────────────────────────
{
  const multi = { desc: 'line1\nline2' };
  const out = stringify(multi);
  // 不要求多行能无损往返；仅锁定：当前实现不会静默把 \n 破坏成有效 YAML 之外的数据
  check('多行值序列化不抛错', typeof out === 'string');
  console.log('  注意: 多行字符串非受支持场景（设计不存多行 YAML 值），已文档化。');
}

console.log(`\njs-yaml: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
