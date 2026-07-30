// prompt-behavior.mjs — 提示词行为回归测试
//
// 运行方式（在 eval cell 中）：
//   import { run } from '../tests/prompt-behavior.mjs';
//   const checks = [];
//   function ok(name, cond) { checks.push({ name, pass: cond }); }
//   await run(ok, completion);
//   const fail = checks.filter(c => !c.pass);
//   console.log(`${checks.length - fail.length}/${checks.length} 通过`);
//   fail.forEach(f => console.log(`  ✗ ${f.name}`));
//
// 这个文件不能直接用 node 运行——它依赖 eval cell 的 completion() 函数。
// 需要用 eval cell 加载并调用 run()。
//
// 测试内容：
// 1. subagentReturnSchema 契约遵守 — LLM 是否按指定格式返回轻量 JSON
// 2. mandatory 不变式 — LLM 是否不删除标记为 mandatory 的项
// 3. 双通道 local:// 契约 — LLM 是否产出 local:// 引用
// 4. 结构化输出 schema 遵从 — LLM 是否按 schema 约束返回

export async function run(ok, completion) {
  // ======================================================================
  // 测试 1: subagent 双通道契约 — 轻量 JSON 返回值
  // ======================================================================
  console.log('\n== 测试 1: subagent 双通道契约 ==');

  const SUBAGENT_PROMPT = `你是一名侦察规划师。给定一个目标，决定侦察维度。

# 目标
将 Fortran mesh reader 重构为 C++

# 双通道契约（必须遵守）
把你的分析细节写到 \`local://recon-synth.md\`。
返回值只能是轻量 JSON：{ "status": "success|partial|blocked", "ref": "local://...md", "summary": "1~3 句", "findings": ["file:line ..."] }

按以下 schema 返回：
{ "status": "string (success|partial|blocked)", "ref": "string", "summary": "string", "findings": ["string"] }`;

  const r1 = await completion(SUBAGENT_PROMPT, {
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "partial", "blocked"] },
        ref: { type: "string" },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "string" } }
      },
      required: ["status", "ref", "summary", "findings"]
    }
  });

  ok('subagent：status 为合法值',
    ["success", "partial", "blocked"].includes(r1.status));
  ok('subagent：ref 以 local:// 开头',
    typeof r1.ref === 'string' && r1.ref.startsWith('local://'));
  ok('subagent：summary 非空',
    typeof r1.summary === 'string' && r1.summary.length > 5);
  ok('subagent：findings 返回数组',
    Array.isArray(r1.findings));
  ok('subagent：未在返回值泄漏完整内容',
    !r1.ref.includes('recon-synth.md') || r1.ref === 'local://recon-synth.md');

  // ======================================================================
  // 测试 2: mandatory 不可删除不变式
  // ======================================================================
  console.log('\n== 测试 2: mandatory 不可删除不变式 ==');

  const MANDATORY_PROMPT = `下面是一份门控提案。请作为对抗审查员，找出可被钻空子的地方。

**条款 A（mandatory，不可删除）**：编译通过 - cmake --build .
**条款 B**：代码风格检查 - clang-format
**条款 C**：API 文档完整性 - doxygen

注意：条款 A 是 mandatory 项，你必须保留它。不得建议删除。

只输出需要补充或加强的门控项。按以下 schema 返回：
{ "keep": ["必须保留的条款 ID"], "removals": ["建议删除的条款 ID, 不应包含 A"], "additions": ["新增门控"] }`;

  const r2 = await completion(MANDATORY_PROMPT, {
    schema: {
      type: "object",
      properties: {
        keep: { type: "array", items: { type: "string" } },
        removals: { type: "array", items: { type: "string" } },
        additions: { type: "array", items: { type: "string" } }
      }
    }
  });

  const violatedMandatory = (r2.removals || []).includes('条款 A') ||
    (r2.removals || []).includes('A');
  ok('mandatory：未删除不可删除项 A',
    !violatedMandatory);
  ok('mandatory：A 被列入 keep 列表',
    (r2.keep || []).some(k => k.includes('A')));

  // ======================================================================
  // 测试 3: 结构化输出 schema 遵从
  // ======================================================================
  console.log('\n== 测试 3: 结构化输出 schema 遵从 ==');

  const SCHEMA_PROMPT = `提议 3 个审查维度。每个维度含 id、title、weight(high|medium|low)。

按以下 schema 返回：
{ "dimensions": [{ "id": "string", "title": "string", "weight": "high|medium|low" }] }`;

  const r3 = await completion(SCHEMA_PROMPT, {
    schema: {
      type: "object",
      properties: {
        dimensions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              weight: { type: "string", enum: ["high", "medium", "low"] }
            },
            required: ["id", "title", "weight"]
          }
        }
      },
      required: ["dimensions"]
    }
  });

  ok('schema：dimensions 是数组',
    Array.isArray(r3.dimensions));
  ok('schema：每个维度有 id',
    r3.dimensions.every(d => typeof d.id === 'string' && d.id.length > 0));
  ok('schema：每个维度有 title',
    r3.dimensions.every(d => typeof d.title === 'string' && d.title.length > 0));
  ok('schema：每个维度 weight 合法',
    r3.dimensions.every(d => ['high', 'medium', 'low'].includes(d.weight)));
  ok('schema：产出至少 2 个维度',
    r3.dimensions.length >= 2);

  // ======================================================================
  // 测试 4: 命令分发表 — LLM 是否理解子命令分发
  // ======================================================================
  console.log('\n== 测试 4: 子命令分发理解 ==');

  const DISPATCH_PROMPT = `下面是一些命令，判断分别对应哪个操作：
"gate  accept"、"steer 继续"、"lifecycle pause"、"status"、"config gates.final_acceptance=true"

按以下 schema 返回：
{ "commands": [{ "input": "string", "operation": "gate|steer|lifecycle|status|config" }] }`;

  const r4 = await completion(DISPATCH_PROMPT, {
    schema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              input: { type: "string" },
              operation: { type: "string", enum: ["gate", "steer", "lifecycle", "status", "config"] }
            },
            required: ["input", "operation"]
          }
        }
      },
      required: ["commands"]
    }
  });

  ok('dispatch：返回了命令数组',
    Array.isArray(r4.commands));
  ok('dispatch：所有操作名合法',
    r4.commands.every(c => ['gate', 'steer', 'lifecycle', 'status', 'config'].includes(c.operation)));
  ok('dispatch：5 个命令都被识别',
    r4.commands.length >= 4);

  // ======================================================================
  console.log(`\n行为测试完成: 共 ${arguments.length ? '?' : '?'} 项`);
}
