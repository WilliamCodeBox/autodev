// integration/review.mjs — 对抗式审查：用 omp -p 扇出 subagent 审查 autodev 状态
//
// 职责：收集场景状态快照（YAML + run.json + 日志）→ 拼成审查 prompt
//       → spawn `omp -p` 扇出 4 个对抗 subagent → 汇总裁决
//
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 审查维度（每个维度是一个 subagent 的关注点）
const REVIEW_DIMENSIONS = [
  {
    id: 'state-machine',
    title: '状态机合法性',
    focus: 'task 迁移边是否正确（done 为终态、blocked→replan 合规）；slice stage 推进是否对应 checkSliceGate 结果；replan_attempts 是否 ≤ max_replans',
  },
  {
    id: 'yaml-integrity',
    title: 'YAML 完整性',
    focus: 'autodev.yaml 与 slices/*.yaml 引用一致；slice_file 路径可解析；父 stage 与子 stage 同步；无丢失字段',
  },
  {
    id: 'gate-correctness',
    title: '门控正确性',
    focus: 'mandatory 项是否在 final_standard 中；R2 不能删除 mandatory/seed；final_standard 全部 pass 后才能 DONE；HITL gate 未 resolve 时 sliceHasPendingGate 阻塞',
  },
  {
    id: 'edge-cases',
    title: '边界条件',
    focus: 'replan 超限后 paused；重复 init 拒绝；空值/缺失字段是否优雅处理；atomicWrite 是否正确',
  },
];

// 创建 state bundle 的 Markdown 表示
function renderBundle(ctx) {
  const bundle = ctx.bundle();
  let md = '# autodev 状态快照\n\n';

  // 状态机摘要
  const doc = ctx.autodev;
  if (doc) {
    md += `## 项目: ${doc.project || 'N/A'}\n`;
    md += `- mode: ${doc.mode || 'N/A'}\n`;
    md += `- status: ${doc.status || 'N/A'}\n`;
    md += `- slices: ${(doc.slices || []).map(s => `${s.id}(${s.stage})`).join(', ') || 'none'}\n`;
    md += `- recon dimensions: ${doc.recon?.dimensions?.length || 0}\n`;
    md += `- mandatory gates: ${doc.gate?.mandatory?.length || 0}\n`;
    md += `- final_standard: ${doc.gate?.final_standard?.map(g => `${g.id}=${g.status}`).join(', ') || 'none'}\n`;
    md += `- pending_gates: ${(doc.pending_gates || []).map(p => p.gate_id).join(', ') || 'none'}\n`;
    md += `- gate_history: ${(doc.gate_history || []).length} entries\n\n`;
  }

  // Slice 详情
  if (ctx.slices && Object.keys(ctx.slices).length > 0) {
    md += '## Slices\n\n';
    for (const [id, sl] of Object.entries(ctx.slices)) {
      md += `### ${id}: ${sl.title || ''} (stage=${sl.stage}, attempts=${sl.replan_attempts})\n`;
      md += `- tasks: ${(sl.tasks || []).map(t => `${t.id}=${t.status}${t.reason ? `(${t.reason})` : ''}`).join(', ')}\n`;
      md += `- ACs: ${(sl.acceptance_criteria || []).map(a => `${a.id}=${a.status}`).join(', ')}\n`;
    }
    md += '\n';
  }

  // 所有文件原始内容
  md += '## 原始文件\n\n';
  for (const [fp, content] of Object.entries(bundle.files)) {
    md += `### ${fp}\n\`\`\`${fp.endsWith('.json') ? 'json' : 'yaml'}\n${content}\n\`\`\`\n\n`;
  }

  return md;
}

// 拼审查 prompt
function buildReviewPrompt(ctx, customPrompt) {
  const stateMd = renderBundle(ctx);
  const dims = REVIEW_DIMENSIONS;

  return `你是一个 autodev 集成测试的对抗审查员。

## 任务
审查下面这份 autodev 运行时状态快照，判断各维度是否正确。

## 审查维度
${dims.map(d => `- **${d.title}** (${d.id}): ${d.focus}`).join('\n')}

${customPrompt || ''}

## 状态快照

${stateMd}

## 要求
1. 对每个维度，用 \`task\` 扇出一个隔离的 subagent 进行专项审查
2. 每个 subagent 输出: { "pass": true/false, "findings": ["..."] }
3. 汇总为一个最终裁决 JSON:
\`\`\`json
{
  "pass": true,
  "summary": "一句话结论",
  "findings": [
    { "dimension": "state-machine", "severity": "error|warn|info", "msg": "..." }
  ]
}
\`\`\`

仅输出 JSON，不要多余文字。`;
}

// 运行 omp -p 审查
export async function runAdversarial(ctx, customPrompt) {
  const prompt = buildReviewPrompt(ctx, customPrompt);

  return new Promise((resolve, reject) => {
    const child = spawn('omp', ['-p', prompt, '--no-session', '--max-time', '120'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.on('close', (code) => {
      if (code !== 0) {
        // omp -p 可能返回非零，但仍有输出
        console.warn(`  omp exited ${code}`);
      }

      // 尝试从 stdout 提取 JSON（可能会混入其他文本）
      try {
        // 找最后一个 ```json ... ``` 或 { "pass": ... }
        const jsonMatch = stdout.match(/\`\`\`json\s*([\s\S]*?)\s*\`\`\`/);
        const jsonStr = jsonMatch ? jsonMatch[1] : stdout;
        const verdict = JSON.parse(jsonStr.trim());
        resolve(verdict);
      } catch {
        // 解析失败：返回 raw output 作为 findings
        resolve({
          pass: false,
          summary: 'omp review 输出无法解析为 JSON',
          findings: [
            { dimension: 'parser', severity: 'error', msg: `omp exited ${code}, raw: ${stdout.slice(0, 500)}` },
          ],
        });
      }
    });

    child.on('error', (e) => {
      resolve({
        pass: false,
        summary: `omp not available: ${e.message}`,
        findings: [{ dimension: 'runner', severity: 'error', msg: e.message }],
      });
    });
  });
}
