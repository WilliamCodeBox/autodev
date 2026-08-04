# ADR-0006: npm 包分发替代 tarball

| 字段 | 值 |
|------|-----|
| **状态** | accepted |
| **日期** | 2026-08-04 |
| **决策者** | @WilliamCodeBox |
| **影响范围** | 安装通路、升级机制、agent 定义分发 |

## 背景

autodev v1.0.0 通过 `pack-offline.py` 打包为 `autodev-v{VERSION}-offline.tar.gz`，用户手动解压到 `~/.omp/agent/` 或 `<project>/.omp/`。该脚本在 commit `3b7b16c`("Drop dead files") 删除后无替代方案。

v1.1.0 新增 3 个自定义 subagent 定义（`autodev-scout` / `autodev-gatekeeper` / `autodev-implementer`），依靠 omp 的 frontmatter 机制提供工具白名单强制、输出格式 JTD 校验等安全边界。这些 agent 定义必须随包分发，且需要版本化升级能力。

## 决策

改用 npm 包 `@williamcodebox/autodev` 分发，安装命令 `omp plugin install @williamcodebox/autodev`。

### 依据

1. **omp 原生支持**：`task/discovery.ts:100-105` 和 `omp-extension-roots.ts:187-227` 将 npm/link plugin 的 `agents/` 目录纳入 agent 发现链路，优先级高于内置 agent。
2. **版本管理**：npm semver + `omp plugin update` 提供标准化升级路径，替代手动覆盖 tarball。
3. **目录约定**：omp extension package 的 `commands/`、`skills/`、`tools/`、`agents/` 通过目录约定自动发现，无需 JS extension 模块入口（不写 `omp.extensions`）。
4. **安装即启用**：`installer.ts:85` 默认 `enabled: true`，用户无需额外配置。

### 迁移风险（已文档化）

- **发现优先级遮蔽**：`project .omp/ > user ~/.omp/agent/ > npm plugin`。用户级旧 agent 文件会静默遮蔽 npm 新版。INSTALL.md 已记录清理步骤。
- **handoff resume 依赖**：新会话必须已安装包，否则 agent 找不到触发 fail-loud。commands/autodev.md 已声明前置条件。

## 后果

- **正面**：标准化安装/升级/卸载；agent 定义随版本分发；依赖 npm 生态。
- **负面**：需要 npm registry 访问；非 npm 用户需手动拷贝文件（等同于旧 tarball 方式，但不再提供预打包脚本）。
- **需维护**：`package.json` 的 `files` 字段必须包含 `agents/`、`commands/`、`skills/`、`tools/`、`lib/`。
