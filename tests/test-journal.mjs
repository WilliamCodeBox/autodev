// test-journal.mjs — 验证 run journal + durable artifacts 双写 + 真实 verify 执行（不依赖 omp 运行时）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveAutodev, loadAutodev, loadSlice, saveSlice,
  writeArtifact, readArtifact, readJournal, appendJournal, resumeState, runVerify,
  buildFinalStandard,
} from '../src/tools/autodev/lib/autodev-state.mjs';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  PASS', name);
}

// 用临时 root 隔离运行，避免污染项目 .omp/
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-journal-'));
const nodeBin = process.execPath; // 跨平台拿到 node 可执行文件，verify 测试用

// 准备无内层引号的 verify 脚本（cmd.exe 的 /c "..." 包装不耐内层引号，生产命令通常也无引号）
const passScript = path.join(root, 'pass.js');
const failScript = path.join(root, 'fail.js');
fs.writeFileSync(passScript, 'process.exit(0);\n');
fs.writeFileSync(failScript, 'process.exit(3);\n');
const passCmd = `${nodeBin} ${passScript}`;
const failCmd = `${nodeBin} ${failScript}`;

// ---- 准备一个最小 autodev.yaml + slice ----
const autodev = {
  project: 'journal-test',
  goal: 'demo',
  max_replans: 3,
  gate: {
    mandatory: [{ id: 'G0', desc: 'build', verify: passCmd, kind: 'machine', status: 'pending' }],
    developer_seed: [],
    derived: [],
    final_standard: [],
  },
  slices: [{ id: 'S1', stage: 'executing', replan_attempts: 0, slice_file: '.omp/autodev/slices/S1.yaml' }],
};
saveAutodev(root, autodev);
const slice = {
  slice_id: 'S1',
  stage: 'executing',
  replan_attempts: 0,
  acceptance_criteria: [{ id: 'S1-AC1', desc: 'smoke', verify: passCmd, kind: 'machine', status: 'pending' }],
  tasks: [{ id: 'T1', status: 'done' }],
};
saveSlice(root, slice);
const _d = loadAutodev(root);
buildFinalStandard(_d);
saveAutodev(root, _d);

console.log('== writeArtifact / readArtifact（durable 双写） ==');
{
  const art = writeArtifact(root, 'recon-num.md', '# 数值风险\n- file:line 证据');
  ok('返回 durable + local 双 ref', art.durableRef.startsWith('.omp/autodev/artifacts/') && art.local.startsWith('local://'));
  ok('durable 文件已落盘', fs.existsSync(art.durable));
  ok('readArtifact 往返一致', readArtifact(root, 'recon-num.md') === '# 数值风险\n- file:line 证据');
}

console.log('== runVerify：machine 命令退出 0 -> status=pass，并回写 gate ==');
{
  const res = runVerify(root, { gate_id: 'G0' });
  ok('ok=true', res.ok === true);
  ok('ran=true', res.ran === true);
  ok('exit=0', res.exit === 0);
  ok('status=pass', res.status === 'pass');
  ok('source=final_standard', res.source === 'final_standard');
  ok('落了 durable 产物', fs.existsSync(path.join(root, res.artifact)));
  const doc = loadAutodev(root);
  const g0 = doc.gate.final_standard.find((g) => g.id === 'G0');
  ok('gate G0 状态被回写为 pass', g0.status === 'pass');
}

console.log('== runVerify：machine 命令退出非 0 -> status=fail（不采信自报） ==');
{
  // 给 S1-AC1 一个必失败的命令
  const sl = loadSlice(root, 'S1');
  sl.acceptance_criteria[0].verify = failCmd;
  saveSlice(root, sl);
  const res = runVerify(root, { gate_id: 'S1-AC1', slice_id: 'S1' });
  ok('exit=3', res.exit === 3);
  ok('status=fail', res.status === 'fail');
  ok('source=slice_ac', res.source === 'slice_ac');
  const sl2 = loadSlice(root, 'S1');
  ok('AC S1-AC1 状态回写为 fail', sl2.acceptance_criteria[0].status === 'fail');
}

console.log('== runVerify：命令不存在 -> 判 fail，且不采信任何自报 ==');
{
  // 注意：shell:true 下未知命令仍会启动 shell（ran=true），但 shell 返回非 0 退出码，
  // 故 verdict=fail。这正是"不采信 subagent 自报 PASS"的硬保障。
  const res = runVerify(root, { gate_id: 'G0', verify_cmd: 'this_command_does_not_exist_xyz_12345' });
  ok('ok=true（不抛异常）', res.ok === true);
  ok('ran=true（shell 已执行）', res.ran === true);
  ok('status 为非 0（命令未找到）', res.status !== 0 && res.status !== null);
  ok('status=fail（判失败）', res.status === 'fail');
}

console.log('== runVerify：llm_judge 类只记录不自动判定（status=pending） ==');
{
  saveAutodev(root, Object.assign(loadAutodev(root), {}));
  const doc = loadAutodev(root);
  doc.gate.final_standard.push({ id: 'G-llm', desc: '语义正确', verify: '由模型按说明判定', kind: 'llm_judge', status: 'pending' });
  saveAutodev(root, doc);
  const res = runVerify(root, { gate_id: 'G-llm', verify_cmd: passCmd });
  ok('kind=llm_judge', res.kind === 'llm_judge');
  ok('status=pending（不自动判定）', res.status === 'pending');
}

console.log('== appendJournal / readJournal（append-only） ==');
{
  const e1 = appendJournal(root, { op: 'manual', note: 'a' });
  const e2 = appendJournal(root, { op: 'manual', note: 'b' });
  ok('事件带 ISO 时间戳', typeof e1.t === 'string' && e1.t.includes('T'));
  const j = readJournal(root);
  ok('事件按序追加', j.events.length >= 2 && j.events[j.events.length - 1].note === 'b');
  // 损坏的 journal 不崩
  const jp = path.join(root, '.omp/autodev', 'run.json');
  fs.writeFileSync(jp, '{bad json');
  const jbad = readJournal(root);
  ok('损坏 journal 安全回退为空', Array.isArray(jbad.events) && jbad.events.length === 0);
  // 恢复有效 journal（真实使用 appendJournal 永远写合法 JSON；此处复原以便后续 resume 断言）
  appendJournal(root, { op: 'repair' });
  ok('appendJournal 重写后恢复有效', readJournal(root).events.length > 0);
}

console.log('== resumeState：聚合最后事实供新会话锚定 ==');
{
  const r = resumeState(root);
  ok('hasJournal=true', r.hasJournal === true);
  ok('eventCount>0', r.eventCount > 0);
  ok('lastEvent 存在', r.lastEvent && typeof r.lastEvent.op === 'string');
  ok('statusSummary 反映 final gate 未全过', r.statusSummary && r.statusSummary.final_pass === false);
  ok('stateDir 指向 .omp/autodev', r.stateDir.endsWith(path.join('.omp', 'autodev')) || r.stateDir.includes('autodev'));
}

console.log(`\nALL ${passed} CHECKS PASSED`);
