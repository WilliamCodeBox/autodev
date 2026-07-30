// 05-hotl-steer.mjs — HOTL 模式：steer 下发 + 吸收 + 暂停恢复
import fs from 'node:fs';
import path from 'node:path';
import {
  initAutodev, loadAutodev, loadSlice, saveSlice, isHotlActive, isPaused,
} from '../lib/state.mjs';
import {
  hotlInit, hotlSteer, hotlPause, hotlResume, hotlCancel, hotlPoll,
} from '../lib/state.mjs';

export const name = 'hotl-steer';
export const description = 'HOTL: init → steer → poll → pause → resume → cancel';

export async function run(root, check) {
  initAutodev(root, {
    project: 'hotl-test', goal: 'HOTL 功能验证', mode: 'auto', status: 'running', max_replans: 3,
    gate: { mandatory: [], developer_seed: [], derived: [], final_standard: [] },
    recon: { dimensions: [] },
    slices: [
      { id: 'S1', title: '切片 A', stage: 'executing', depends_on: [], replan_attempts: 0, slice_file: '.omp/autodev/slices/S1.yaml' },
    ],
  });
  saveSlice(root, {
    slice_id: 'S1', title: '切片 A', stage: 'executing', replan_attempts: 0,
    acceptance_criteria: [{ id: 'AC1', desc: '编译通过', verify: 'cmake', kind: 'machine', status: 'pending' }],
    tasks: [{ id: 'T1', title: '实现 A', status: 'doing', owner_role: 'executor', accept: '通过' }],
  });

  let doc = loadAutodev(root);

  // ── hotlInit ──
  const init = hotlInit(root, {});
  check('hotlInit ok', init?.ok === true);
  doc = loadAutodev(root);
  check('HOTL 已激活', isHotlActive(doc) === true);
  check('hotl.mode=supervised', doc.hotl?.mode === 'supervised');
  check('hotl.loop_state=running', doc.hotl?.loop_state === 'running');

  // ── hotlSteer ──
  const s1 = hotlSteer(root, { kind: 'steer', text: '注意模块 A 的边界条件', scope: 'slice:S1' });
  check('hotlSteer ok', s1?.ok === true);
  doc = loadAutodev(root);
  check('steer 队列有 1 条未消费', doc.hotl?.steers?.filter(s => !s.applied)?.length === 1);
  check('steer scope 正确', doc.hotl?.steers?.[0]?.scope === 'slice:S1');

  // ── hotlPoll ──
  const pollResult = hotlPoll(root);
  check('hotlPoll 返回 pending_steers', Array.isArray(pollResult?.pending_steers));
  check('pending_steers 长度 >= 1', (pollResult?.pending_steers?.length || 0) >= 1);

  // ── hotlPause ──
  const pause = hotlPause(root);
  check('hotlPause ok', pause?.ok === true);
  doc = loadAutodev(root);
  check('loop_state=paused', doc.hotl?.loop_state === 'paused');
  check('isPaused 检测到暂停', isPaused(doc) === true);

  // ── hotlResume ──
  const resume = hotlResume(root);
  check('hotlResume ok', resume?.ok === true);
  doc = loadAutodev(root);
  check('loop_state=running', doc.hotl?.loop_state === 'running');
  check('isPaused 解除', isPaused(doc) === false);

  // ── hotlCancel ──
  const cancel = hotlCancel(root);
  check('hotlCancel ok', cancel?.ok === true);
  doc = loadAutodev(root);
  check('loop_state=cancelled', doc.hotl?.loop_state === 'cancelled');
}
