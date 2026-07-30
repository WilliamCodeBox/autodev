// 04-gate-invariants.mjs — 门控不变式自动补回
// 验证 validateGateInvariants 在 R2 误删 mandatory/seed 后自动恢复
import fs from 'node:fs';
import path from 'node:path';
import {
  initAutodev, loadAutodev, saveAutodev,
  buildFinalStandard, validateGateInvariants,
} from '../lib/state.mjs';

export const name = 'gate-invariants';
export const description = 'R2 对抗审查误删 mandatory/seed → validateGateInvariants 自动补回';

export async function run(root, check) {
  initAutodev(root, {
    project: 'invariant-test', goal: '验证门控不变式',
    mode: 'auto', status: 'running', max_replans: 3,
    gate: {
      mandatory: [
        { id: 'G0', desc: '编译通过', verify: 'cmake --build .', kind: 'machine', status: 'pending' },
        { id: 'G1', desc: 'ctest 通过', verify: 'ctest --output-on-failure', kind: 'machine', status: 'pending' },
      ],
      developer_seed: [
        { id: 'G-dev-1', desc: 'API 语义一致', verify: 'llm_judge', kind: 'llm_judge', status: 'pending' },
      ],
      derived: [
        { id: 'G-der-1', desc: '性能不退化', verify: 'bench 对比', kind: 'llm_judge', status: 'pending' },
      ],
      final_standard: [],
    },
    recon: { dimensions: [] },
    slices: [],
  });

  let doc = loadAutodev(root);

  // ── 初次 buildFinalStandard ──
  buildFinalStandard(doc);
  saveAutodev(root, doc);
  doc = loadAutodev(root);
  check('final_standard 初始含 mandatory(2)+seed(1)+derived(1) = 4 项',
    doc.gate.final_standard.length === 4);

  // ── 模拟 R2 恶意删除：只留 1 条 derived ──
  doc.gate.final_standard = [{ id: 'G-der-1', desc: '性能不退化', verify: 'bench', kind: 'llm_judge', status: 'pending' }];
  saveAutodev(root, doc);
  doc = loadAutodev(root);
  check('R2 删除后只剩 1 项', doc.gate.final_standard.length === 1);

  // ── validateGateInvariants 应补回被删的 mandatory + seed ──
  const result = validateGateInvariants(doc);
  check('validateGateInvariants 返回了被补回的 id', result.restored?.length >= 2);
  check('补回的 gate 包含 G0', result.restored?.includes('G0'));
  check('补回的 gate 包含 G-dev-1', result.restored?.includes('G-dev-1'));
  check('补回的 gate 包含 G1', result.restored?.includes('G1'));

  saveAutodev(root, doc);
  doc = loadAutodev(root);
  check('补回后 final_standard >= 3（mandatory 2 + seed 1）',
    doc.gate.final_standard.length >= 3);
  check('mandatory G0 已恢复', doc.gate.final_standard.some(g => g.id === 'G0'));
  check('mandatory G1 已恢复', doc.gate.final_standard.some(g => g.id === 'G1'));
  check('developer_seed G-dev-1 已恢复', doc.gate.final_standard.some(g => g.id === 'G-dev-1'));

  // ── 不变式不缺失时不应报告修复 ──
  const result2 = validateGateInvariants(doc);
  check('不变式完整时 restored 为空', result2.restored?.length === 0 || result2.restored === undefined);
}
