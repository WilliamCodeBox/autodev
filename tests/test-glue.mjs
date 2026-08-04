// _glue-check.mjs — 端到端验证 index.ts factory（mock pi.zod）跑通 P0 逻辑。
// 运行：node --experimental-strip-types tests/test-glue.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const builder = { optional() { return this; }, describe() { return this; } };
const zod = {
  object: (s) => s,
  enum: () => ({ ...builder }),
  string: () => ({ ...builder }),
  any: () => ({ ...builder }),
  number: () => ({ ...builder }),
  boolean: () => ({ ...builder }),
  array: () => ({ ...builder }),
};
const pi = { zod };

const state = await import('../tools/autodev/lib/autodev-state.mjs');
const factory = (await import('../tools/autodev/index.ts')).default;
const tool = factory(pi);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-glue-'));
let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ok  -', m); } else { fail++; console.error('  FAIL-', m); } };

// init
const initDoc = {
  project: 't', mode: 'auto',
  slices: [{ slice_id: 'S1', stage: 'planning', replan_attempts: 0,
    tasks: [{ id: 'T1', status: 'todo' }], acceptance_criteria: [{ id: 'C1', status: 'pending' }] }],
  hitl: { enabled: false, pending_gates: [], decisions: [] },
  hotl: { mode: 'autonomous', steers: [], loop_state: 'running' },
};
let r = await tool.execute('t1', { operation: 'init', autodev: initDoc, root });
assert(!r.isError, 'init ok: ' + r.content[0].text);
// 物化 slice 文件（真实主循环会建）
state.saveSlice(root, initDoc.slices[0]);

// set_mode hitl
r = await tool.execute('t3', { operation: 'set_mode', mode: 'hitl', root });
assert(!r.isError && r.content[0].text.includes('hitl'), 'set_mode hitl: ' + r.content[0].text);

// hitl_request plan_approval（P0-3：开 gate 后 transition_task 应被硬阻）
r = await tool.execute('t4', { operation: 'hitl_request', slice_id: 'S1', gate: 'plan_approval', root });
assert(!r.isError, 'hitl_request ok');
const gateId = JSON.parse(r.content[0].text.match(/\{[\s\S]*\}/)[0]).id;

r = await tool.execute('t5', { operation: 'transition_task', slice_id: 'S1', task_id: 'T1', to_status: 'done', root });
assert(r.isError && r.content[0].text.includes('BLOCKED_BY_PENDING_GATE'), 'P0-3 hard block on transition_task: ' + r.content[0].text);

// hitl_respond approve 解除
r = await tool.execute('t6', { operation: 'hitl_respond', gate_id: gateId, decision: 'approve', root });
assert(!r.isError, 'hitl_respond approve ok');

r = await tool.execute('t7', { operation: 'transition_task', slice_id: 'S1', task_id: 'T1', to_status: 'done', root });
assert(!r.isError, 'after approve, transition_task allowed');

// hotl 模式 + steer 解阻（P0-4/6）
r = await tool.execute('t8', { operation: 'hotl_init', root });
assert(!r.isError, 'hotl_init ok');
// 置 S1 为 paused + replan_attempts=3，下发 resume steer，经 replan 吸收点解阻
const st = state.loadSlice(root, 'S1');
st.stage = 'paused'; st.replan_attempts = 3;
state.saveSlice(root, st);
await tool.execute('t9', { operation: 'hotl_steer', steer_kind: 'resume', scope: 'slice:S1', note: 'go', root });
r = await tool.execute('t10', { operation: 'replan', slice_id: 'S1', root });
assert(!r.isError, 'replan ok after steer');
const reloaded = state.loadSlice(root, 'S1');
assert(reloaded.stage === 'planning' && reloaded.replan_attempts === 0, `P0-6 unblock reset (stage=${reloaded.stage}, attempts=${reloaded.replan_attempts})`);

// replan 超限收敛到 paused（P0-5）
for (let i = 0; i < 4; i++) await tool.execute('tx' + i, { operation: 'replan', slice_id: 'S1', root });
const doc = state.loadAutodev(root);
assert(doc.hotl.loop_state === 'paused', 'P0-5 convergeToPaused set hotl.loop_state=paused');

console.log(`\nglue: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
