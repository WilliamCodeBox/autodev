# autodev 离线安装说明（Linux / 跨平台）

## 这个包是什么
`autodev` 是一个 oh-my-pi (omp) 扩展 keyword，让 omp 自动完成
"目标 → 侦察(RECON) → 方案(2-round) → 切片执行 → 验收" 的闭环。
本压缩包是**最小运行时子集**，已剔除所有开发期与测试文件。

## 零依赖 / 离线可用（重点）
- 包内仅 `.ts`（omp 用其内置 bun 即时转译）+ `.mjs`（标准 ES module）。
- **不依赖任何 npm 包**，无运行时 `package.json` 依赖，无需 `npm install` / `bun install`。
- 直接解压到目标机的 omp 扩展目录即可，**全程离线**。
- 所有文本文件行尾已统一为 LF，避免 Windows CRLF 在 Linux 上导致解析问题。

## 前提
- 目标 Linux 机器已安装 oh-my-pi (omp)，版本为 **v17 系**（本机开发验证于 v17.1.3）。
  omp 内含 bun runtime，负责加载 `.ts`。
- 你对目标 omp 扩展根目录有写权限。

## 包内容
```
tools/autodev/index.ts          # 唯一运行时入口（tool factory，自包含）
tools/autodev/lib/autodev-state.mjs   # 状态机 + 预算护栏 + handoff + verify + journal
tools/autodev/lib/recon-score.mjs     # RECON 维度置信度打分
tools/autodev/lib/yaml-lite.mjs       # 内联 YAML 解析/序列化（无 js-yaml 依赖）
commands/autodev.md             # /autodev slash command
skills/autodev/SKILL.md         # autodev skill 文档
INSTALL.md                      # 本文件
```
> `index.ts` 通过相对路径 `./lib/*.mjs` 引用 lib（**lib 已内联进 tools/autodev/，工具完全自包含**）。
> **可直接拷贝整个 `tools/autodev/` 到任意 omp 扩展根**，无需附带外部 `lib/`。

## 安装（二选一）

### A. 全局安装（所有项目可用）
```bash
# 解压到 omp 全局扩展根（以你的实际路径为准，常见为 ~/.omp/agent）
mkdir -p ~/.omp/agent
tar -xzf autodev-v7-offline.tar.gz -C ~/.omp/agent/
```
校验结构：
```bash
ls ~/.omp/agent/tools/autodev/index.ts
ls ~/.omp/agent/tools/autodev/lib/{autodev-state.mjs,recon-score.mjs,yaml-lite.mjs}
```

### B. 项目级安装（仅当前仓库）
```bash
cd <你的项目根>
mkdir -p .omp
tar -xzf autodev-v7-offline.tar.gz -C .omp/
```
校验结构：
```bash
ls .omp/tools/autodev/index.ts
ls .omp/tools/autodev/lib/{autodev-state.mjs,recon-score.mjs,yaml-lite.mjs}
```

## 启用
重启 omp（或重新加载扩展），让 tool / command / skill 被发现。
- 验证 tool：在 omp 中调用 autodev 的 `read` operation（无需参数即读取当前 autodev.yaml）。
- 验证 command：输入 `/autodev` 应出现该 slash command。

## 卸载
直接删除对应目录即可：
```bash
rm -rf ~/.omp/agent/tools/autodev \
       ~/.omp/agent/commands/autodev.md \
       ~/.omp/agent/skills/autodev
```
（项目级把 `~/.omp/agent` 换成 `<项目>/.omp`）

## 开发机已通过的验证
- bun 加载图解析：从 `tools/autodev/index.ts` 解析 `./lib` 导入图通过。
- 单元测试：111 项通过（状态机 14 + 护栏 31 + yaml 10 + journal 29 + recon 27）。
- RECON 置信闸门 dry-run：合成 CAE/HPC 仓库校准通过。

## 注意事项
- `verify` 命令走 `shell:true`：Linux 用 `/bin/sh`。verify 命令请用跨平台 CLI
  （cmake / ctest / make / gfortran 等），不要写死 bash heredoc。
- 若目标机 omp 版本非 v17 系，tool 约定（`pi.zod` 收参、返回 `{content,details,isError}`）
  可能不兼容，需对应调整。
