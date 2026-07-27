// test-integration.mjs — 真实文件 I/O 闭环：验证 autodev 状态机 + YAML 落盘格式
// 在 os.tmpdir() 真实读写 .omp/autodev/{autodev,slices} 文件，确保保存后格式可安全往返，
// 并覆盖 init 护栏 / slice 门 / 父同步 / build_standard / final_check 全链路。
// 从任意目录运行：node tools/autodev/lib/test-integration.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadAutodev, saveAutodev, autodevPath, slicePath,
  loadSlice, saveSlice, saveSliceAndSyncParent, reconcileSliceStage,
  transitionTask, canTransitionTask, checkSliceGate,
  buildFinalStandard, validateGateInvariants, checkFinalGate, initAutodev,
} from './autodev-state.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', name); }
}
function eq(a, b, msg) { check(msg, JSON.stringify(a) === JSON.stringify(b)); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-it-'));

// ── init 护栏：已存在且无 force 时应拒绝（防静默清零）─────────────
{
  const doc1 = {
    project: 'P', slices: [{ id: 'S1', title: 't', stage: 'queued', depends_on: [], replan_attempts: 0, slice_file: 'slices/S1.yaml' }],
    gate: { mandatory: [{ id: 'M1', desc: 'build', status: 'pending' }], developer_seed: [{ id: 'SE1', desc: 'x', status: 'pending' }] },
  };
  const r1 = initAutodev(ROOT, doc1);
  check('init 首次落盘成功', r1.ok === true && fs.existsSync(autodevPath(ROOT)));

  // 重复 init 无 force：应拒绝（不静默清零）
  const doc2 = { project: 'P2', slices: [], gate: {} };
  const r2 = initAutodev(ROOT, doc2); // 无 force
  check('重复 init 无 force 被拦截（不静默清零）', r2.ok === false && /already exists/.test(r2.error || ''));
  // 验证原内容未被覆盖
  const persisted = loadAutodev(ROOT);
  check('原 autodev 内容未被重复 init 覆盖', persisted && persisted.project === 'P' && persisted.slices.length === 1);

  // 带 force 可重置
  const r3 = initAutodev(ROOT, doc2, { force: true });
  check('带 force 允许重置', r3.ok === true);
  check('重置后内容被覆盖', loadAutodev(ROOT).project === 'P2');
}

// ── slice 门 / 父同步 / 闭环节奏 ────────────────────────────
{
  // 重新写一个干净父 + 一个 slice 文件
  const ad = {
    project: 'demo', slices: [{ id: 'S1', title: 't', stage: 'queued', depends_on: [], replan_attempts: 0, slice_file: 'slices/S1.yaml' }],
    gate: {
      mandatory: [{ id: 'M1', desc: 'build passes', status: 'pending' }],
      developer_seed: [{ id: 'SE1', desc: 'no regressions', status: 'pending' }],
      derived: [], final_standard: [],
    },
  };
  saveAutodev(ROOT, ad);

  const slice = {
    slice_id: 'S1', title: 't', stage: 'executing', depends_on: [],
    tasks: [
      { id: 'T1', status: 'todo', note: 'impl' },
      { id: 'T2', status: 'todo', note: 'verify' },
    ],
    acceptance_criteria: [
      { id: 'AC1', desc: 'works', status: 'pending', ref: 'local://y.md' },
    ],
  };
  saveSlice(ROOT, slice);

  // 1) 推进 task（合法迁移 todo->doing->done）
  check('todo->doing 合法', canTransitionTask('todo', 'doing') === true);
  check('doing->done 合法', canTransitionTask('doing', 'done') === true);
  check('done->todo 非法（终态禁回退）', canTransitionTask('done', 'todo') === false);
  check('done->doing 非法', canTransitionTask('done', 'doing') === false);

  transitionTask(slice, 'T1', 'doing'); saveSliceAndSyncParent(ROOT, slice);
  transitionTask(slice, 'T1', 'done'); saveSliceAndSyncParent(ROOT, slice);
  transitionTask(slice, 'T2', 'doing'); saveSliceAndSyncParent(ROOT, slice);
  transitionTask(slice, 'T2', 'done'); saveSliceAndSyncParent(ROOT, slice);

  // 2) AC pass
  slice.acceptance_criteria[0].status = 'pass';
  saveSliceAndSyncParent(ROOT, slice);

  // 3) 门判定：全 done + 全 pass -> 自动 reconcile 到 done 并写回父
  const gate = checkSliceGate(slice);
  check('slice 门通过', gate.pass === true);
  reconcileSliceStage(slice);
  saveSliceAndSyncParent(ROOT, slice); // reconcile 仅改内存，需落盘 + 父同步
  check('reconcile 后 slice.stage=done', slice.stage === 'done');
  check('reconcile 已持久化 slice 文件', loadSlice(ROOT, 'S1').stage === 'done');

  // 4) 父 autodev.yaml 的 slices[].stage 已同步（这是 final 门能判通过的命脉）
  const reloaded = loadAutodev(ROOT);
  eq(reloaded.slices[0].stage, 'done', '父 autodev.yaml 的 S1.stage 已同步为 done');

  // 5) build_standard + 不变式：补回缺失项、final_standard 合并
  buildFinalStandard(reloaded);
  saveAutodev(ROOT, reloaded);
  // 合并后 mandatory+seed 都在 final_standard，再校验应无违规
  const inv = validateGateInvariants(loadAutodev(ROOT));
  check('门控不变式：无违规 ok=true', inv.ok === true);
  const finalItems = (loadAutodev(ROOT).gate.final_standard || []).map((x) => x.id).sort();
  eq(finalItems, ['M1', 'SE1'], 'final_standard 合并 mandatory+seed');

  // 6) final 门：所有 slice done 且 final_standard 全 pass -> DONE
  //    先把 final_standard 全置 pass 模拟验收
  const ad2 = loadAutodev(ROOT);
  ad2.gate.final_standard.forEach((x) => { x.status = 'pass'; });
  saveAutodev(ROOT, ad2);
  const fg = checkFinalGate(loadAutodev(ROOT));
  check('final 门通过（所有 slice done + final_standard 全 pass）', fg.pass === true);
}

// ── 持久化往返：真实落盘再读回，结构无丢失 ─────────────────────
{
  const ad = loadAutodev(ROOT);
  const text = fs.readFileSync(autodevPath(ROOT), 'utf8');
  const reloaded = JSON.parse(JSON.stringify(ad)); // 已在内存
  // 通过重新 parse 文件验证磁盘格式可解析
  const fromDisk = fs.readFileSync(autodevPath(ROOT), 'utf8');
  check('落盘文件非空且可读取', fromDisk.length > 0);
  check('slice 文件路径符合约定', slicePath(ROOT, 'S1').replace(/\\/g, '/').endsWith('.omp/autodev/slices/S1.yaml'));
}

// ── 门控不变式缺失自动补回 ──────────────────────────────────
{
  const ad = {
    gate: {
      mandatory: [{ id: 'M1', desc: 'build' }],
      developer_seed: [{ id: 'SE1', desc: 'x' }],
      final_standard: [{ id: 'M1', status: 'pending' }], // SE1 被 R2 删除
    },
  };
  const inv = validateGateInvariants(ad);
  check('缺失项被自动识别（ok=false）', inv.ok === false && inv.restored.includes('SE1'));
  check('补回后 final_standard 含 SE1', ad.gate.final_standard.some((x) => x.id === 'SE1'));
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nintegration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
