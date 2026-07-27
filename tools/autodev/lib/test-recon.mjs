// test-recon.mjs —— recon 维度置信度打分测试
import assert from 'node:assert';
import { scoreReconDimension, scoreReconDimensions, classifyReconConfidence, hasFileLine, hasRiskSignal, confidenceDelta } from './recon-score.mjs';

let n = 0;
function ok(name, cond) {
  n++;
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`  ✓ ${name}`);
}
function section(t) { console.log(`\n== ${t} ==`); }

const DIM = { id: 'D1', title: '数值正确性风险', weight: 'high', expected_artifact: '风险点清单' };

section('hasFileLine 证据识别');
ok('src/a.f90:42 命中', hasFileLine('src/a.f90:42 隐式类型'));
ok('a.f90: 42 命中', hasFileLine('a.f90: 42 越界'));
ok('纯文本不命中', !hasFileLine('没有行号的证据'));
ok('数字行不误判', !hasFileLine('处理了 3 个模块'));

section('scoreReconDimension：基础分档');
{
  const r = scoreReconDimension(DIM, { status: 'success', findings: ['src/a.f90:42', 'src/b.f90:10'], summary: '已定位' });
  ok('success+2证据 -> conf=0.9', Math.abs(r.confidence - 0.9) < 1e-9);
  ok('evidence_status=covered', r.evidence_status === 'covered');
  ok('recon_pass 默认 1', r.recon_pass === 1);
}
{
  const r = scoreReconDimension(DIM, { status: 'partial', findings: [], summary: '只看了部分' });
  ok('partial+0证据 -> conf=0.4', Math.abs(r.confidence - 0.4) < 1e-9);
  ok('evidence_status=partial', r.evidence_status === 'partial');
}
{
  const r = scoreReconDimension(DIM, { status: 'blocked', findings: [], summary: '无法访问' });
  ok('blocked -> conf=0.15', Math.abs(r.confidence - 0.15) < 1e-9);
  ok('evidence_status=missing', r.evidence_status === 'missing');
}
{
  const r = scoreReconDimension(DIM, {}); // 无返回
  ok('无 sub -> 视为 blocked 0.15', Math.abs(r.confidence - 0.15) < 1e-9);
}

section('scoreReconDimension：证据加分封顶');
{
  const many = Array.from({ length: 10 }, (_, i) => `f${i}.f90:${i}`);
  const r = scoreReconDimension(DIM, { status: 'success', findings: many, summary: 'ok' });
  ok('10条证据加分封顶 +0.25 -> conf=0.95', Math.abs(r.confidence - 0.95) < 1e-9);
}

section('scoreReconDimension：风险信号压顶 + 矛盾态');
{
  const r = scoreReconDimension(DIM, { status: 'success', findings: ['a.f90:1', 'b.f90:2', 'c.f90:3'], summary: '已定位', next_action_or_blocker: '存在未知浮点结合性风险' });
  ok('高风险压顶 conf<=0.5', r.confidence <= 0.5);
  ok('原 covered 被降级为 contradicted', r.evidence_status === 'contradicted');
}
{
  const r = scoreReconDimension(DIM, { status: 'partial', findings: [], summary: '不确定影响面', next_action_or_blocker: '' });
  ok('partial+风险 -> 仍 partial（非 covered）', r.evidence_status === 'partial' && r.confidence <= 0.5);
}

section('recon_pass：写入与继承');
{
  const r = scoreReconDimension({ ...DIM, recon_pass: 2 }, { status: 'partial', findings: [] });
  ok('recon_pass=2 透传', r.recon_pass === 2);
}

section('scoreReconDimensions + classifyReconConfidence 路由');
{
  const dims = [
    { id: 'A', weight: 'high' },
    { id: 'B', weight: 'low' },
    { id: 'C', weight: 'medium' },
    { id: 'D', weight: 'low', recon_pass: 2 },
  ];
  const subs = {
    A: { status: 'success', findings: ['x.f90:1', 'y.f90:2'] }, // 0.9 -> solid
    B: { status: 'partial', findings: [] },                      // 0.4 -> revisit
    C: { status: 'partial', findings: [] },                      // 0.4 -> revisit
    D: { status: 'partial', findings: [] },                      // 0.4 但 pass=2 -> escalate
  };
  const scored = scoreReconDimensions(dims, subs);
  ok('打分数量一致', scored.length === 4);
  const g = classifyReconConfidence(scored);
  ok('solid=[A]', JSON.stringify(g.solid) === JSON.stringify(['A']));
  ok('revisit=[B,C]', JSON.stringify(g.revisit) === JSON.stringify(['B', 'C']));
  ok('escalate=[D]（pass 达上限）', JSON.stringify(g.escalate) === JSON.stringify(['D']));
}
{
  // 自定义阈值
  const dims = [{ id: 'X' }, { id: 'Y' }];
  const subs = { X: { status: 'success', findings: ['a:1'] }, Y: { status: 'success', findings: [] } };
  const scored = scoreReconDimensions(dims, subs); // X=0.8, Y=0.7
  const g = classifyReconConfidence(scored, { threshold: 0.75 });
  ok('阈值 0.75 -> solid=[X], revisit=[Y]', JSON.stringify(g.solid) === JSON.stringify(['X']) && JSON.stringify(g.revisit) === JSON.stringify(['Y']));
}

section('confidenceDelta 收敛辅助');
ok('涨幅计算', confidenceDelta(0.4, 0.45) === 0.05);
ok('涨幅四舍五入', confidenceDelta(0.4, 0.444) === 0.044);

section('hasRiskSignal 关键词');
ok('英文 block 命中', hasRiskSignal('status blocked'));
ok('中文 未知 命中', hasRiskSignal('存在未知依赖'));
ok('普通文本不命中', !hasRiskSignal('已完成分析'));

console.log(`\n✅ recon-score 全部通过：${n} 项`);
