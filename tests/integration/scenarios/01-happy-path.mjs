// 01-happy-path.mjs — 全生命周期快乐路径
// 验证 autodev 走过 init → slice → task transitions → slice gate → final gate
import fs from 'node:fs';
import path from 'node:path';
import {
  initAutodev, loadAutodev, loadSlice, saveSlice, saveSliceAndSyncParent,
  transitionTask, checkSliceGate, checkFinalGate, buildFinalStandard,
  reconcileSliceStage, saveAutodev,
} from '../lib/state.mjs';

export const name = 'happy-path';
export const description = '完整生命周期：init → slice → tasks → slice gate → final gate, 全部通过';

export async function run(root, check) {
  const initResult = initAutodev(root, {
    project: 'happy-test',
    goal: '重构 Fortran mesh reader 为 C++',
    mode: 'auto', status: 'running', max_replans: 3,
    recon: {
      dimensions: [
        { id: 'D1', title: '数值正确性', weight: 'high', confidence: 0.85, evidence_status: 'covered' },
        { id: 'D2', title: '改动影响面', weight: 'medium', confidence: 0.70, evidence_status: 'covered' },
      ],
    },
    gate: {
      mandatory: [{ id: 'G0', desc: '编译通过', verify: 'cmake --build .', kind: 'machine', status: 'pending' }],
      developer_seed: [{ id: 'G-dev-1', desc: 'API 语义一致', verify: 'llm_judge', kind: 'llm_judge', status: 'pending' }],
      derived: [], final_standard: [],
    },
    slices: [{ id: 'S1', title: '抽取 mesh 数据模型', stage: 'planning', depends_on: [], replan_attempts: 0, slice_file: '.omp/autodev/slices/S1.yaml' }],
  });
  check('init 成功', initResult.ok === true);
  check('重复 init 拒绝', initAutodev(root, { project: 'X', slices: [], gate: {} }).ok === false);

  let doc = loadAutodev(root);
  check('autodev.yaml 已创建', !!doc);
  check('项目名正确', doc.project === 'happy-test');
  check('recon 维度保留', doc.recon?.dimensions?.length === 2);
  check('mandatory gate 保留', doc.gate?.mandatory?.length === 1);

  // ── Step 2: create slice ──
  saveSlice(root, {
    slice_id: 'S1', title: '抽取 mesh 数据模型',
    stage: 'planning', replan_attempts: 0, depends_on: [],
    acceptance_criteria: [
      { id: 'S1-AC1', desc: '字段完整性', verify: 'grep + gtest', kind: 'machine', status: 'pending' },
      { id: 'S1-AC2', desc: '类型精度正确', verify: 'llm_judge', kind: 'llm_judge', status: 'pending' },
    ],
    tasks: [
      { id: 'T1', status: 'todo' }, { id: 'T2', status: 'todo' }, { id: 'T3', status: 'todo' },
    ],
  });
  let sl = loadSlice(root, 'S1');
  check('slice 文件已创建', sl?.slice_id === 'S1');
  check('slice 有 3 个 task', sl?.tasks?.length === 3);

  // ── Step 3: transition tasks todo→doing→done ──
  for (const tid of ['T1', 'T2', 'T3']) {
    transitionTask(sl, tid, 'doing');
    transitionTask(sl, tid, 'done');
    saveSliceAndSyncParent(root, sl);
    sl = loadSlice(root, 'S1');
    check(`T${tid.slice(1)} → done`, sl?.tasks?.find(t => t.id === tid)?.status === 'done');
  }

  // ── Step 4: checkSliceGate → reconcile → gate pass ──
  let gateResult = checkSliceGate(sl);
  check('AC 未全 pass 时 gate 拒绝', gateResult.pass === false);

  sl.acceptance_criteria[0].status = 'pass';
  sl.acceptance_criteria[1].status = 'pass';

  // reconcileSliceStage 会在全 pass+done 时将 stage 设为 done
  const r = reconcileSliceStage(sl);
  check('reconcile 后 stage=done', r.pass === true && sl.stage === 'done');
  saveSliceAndSyncParent(root, sl);

  doc = loadAutodev(root);
  check('父 autodev.yaml slice stage 同步为 done', doc.slices[0].stage === 'done');

  // ── Step 5: build + check final gate ──
  buildFinalStandard(doc);
  for (const g of doc.gate.final_standard) g.status = 'pass';
  saveAutodev(root, doc);
  doc = loadAutodev(root);

  const finalResult = checkFinalGate(doc);
  check('final gate 全部通过', finalResult.pass === true);
  check('final_standard 含 mandatory+seed', doc.gate.final_standard.length >= 2);
}
