// 02-blocked-replan.mjs — blocked → replan 路径
// 验证 task 进入 blocked 状态 → replan 回到 planning → 超限后 paused
import fs from 'node:fs';
import path from 'node:path';
import {
  initAutodev, loadAutodev, loadSlice, saveSlice, saveSliceAndSyncParent,
  transitionTask, replan, checkSliceGate,
} from '../lib/state.mjs';

export const name = 'blocked-replan';
export const description = 'blocked → replan (≤3) → paused (>3), 验证回退与超限机制';

export async function run(root, check) {
  initAutodev(root, {
    project: 'blocked-test', goal: '重构 reader', mode: 'auto', status: 'running', max_replans: 3,
    gate: { mandatory: [], developer_seed: [], derived: [], final_standard: [] },
    recon: { dimensions: [] },
    slices: [{ id: 'S1', title: '重构核心', stage: 'planning', depends_on: [], replan_attempts: 0, slice_file: '.omp/autodev/slices/S1.yaml' }],
  });
  saveSlice(root, {
    slice_id: 'S1', title: '重构核心',
    stage: 'executing', replan_attempts: 0, depends_on: [],
    acceptance_criteria: [{ id: 'AC1', desc: '编译通过', verify: 'cmake --build .', kind: 'machine', status: 'pending' }],
    tasks: [{ id: 'T1', title: '重构模块 A', status: 'todo', owner_role: 'executor', accept: '编译通过' }],
  });

  let sl = loadSlice(root, 'S1');

  // ── T1 doing → blocked ──
  transitionTask(sl, 'T1', 'doing');
  transitionTask(sl, 'T1', 'blocked', { reason: '依赖的外部库 API 变更', blocked_by: [] });
  saveSliceAndSyncParent(root, sl);
  sl = loadSlice(root, 'S1');
  check('T1 blocked 含 reason', sl.tasks.find(t => t.id === 'T1')?.reason?.includes('API 变更'));

  // ── replan #1 ──
  let r = replan(sl, 3);
  saveSliceAndSyncParent(root, sl); // 持久化 replan 结果
  check('replan #1 → replan action', r.action === 'replan');
  check('replan #1 → attempts=1', r.attempts === 1);
  check('replan #1 → stage=planning', sl.stage === 'planning');
  sl = loadSlice(root, 'S1');
  check('replan #1 → attempts=1 on disk', sl.replan_attempts === 1);

  // ── 模拟 blocked 后续三次 ──
  for (let i = 2; i <= 4; i++) {
    sl.tasks[0].status = 'todo';
    sl.stage = 'executing';
    saveSliceAndSyncParent(root, sl);
    sl = loadSlice(root, 'S1');

    transitionTask(sl, 'T1', 'doing');
    transitionTask(sl, 'T1', 'blocked', { reason: '仍有问题', blocked_by: [] });
    saveSliceAndSyncParent(root, sl);
    sl = loadSlice(root, 'S1');

    r = replan(sl, 3);
    saveSliceAndSyncParent(root, sl);
    check(`replan #${i} → attempts=${i}`, r.attempts === i);
    check(`replan #${i} → action=${r.action}`, i <= 3 ? r.action === 'replan' : r.action === 'paused');
  }

  sl = loadSlice(root, 'S1');
  check('replan_attempts=4', sl.replan_attempts === 4);
  check('stage=paused (超限)', sl.stage === 'paused');

  // ── blocked slice gate 不通过 ──
  const g = checkSliceGate(sl);
  check('blocked slice gate 不通过', g.pass === false);
}
