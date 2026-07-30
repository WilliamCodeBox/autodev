# autodev 离线安装

## 安装（二选一）

### A. 全局安装（所有项目可用）
```bash
mkdir -p ~/.omp/agent
tar -xzf autodev-v7-offline.tar.gz -C ~/.omp/agent/
```

验证：
```bash
ls ~/.omp/agent/tools/autodev/index.ts
ls ~/.omp/agent/tools/autodev/lib/
```

### B. 项目级安装（仅当前仓库）
```bash
cd <项目根>
mkdir -p .omp
tar -xzf autodev-v7-offline.tar.gz -C .omp/
```

验证：
```bash
ls .omp/tools/autodev/index.ts
ls .omp/tools/autodev/lib/
```

## 启用
重启 omp 或重载扩展。

验证：
- `autodev` tool 可调用
- `/autodev` slash command 已注册

## 运行时数据
首次运行后自动创建 `.omp/autodev/`，包含：
```
autodev.yaml          # 主状态文件
slices/<id>.yaml      # 各 slice 任务与验收标准
artifacts/            # 持久化产物
handoffs/             # slice 交接记录
run.json              # 事件日志
```

## 卸载
```bash
rm -rf ~/.omp/agent/tools/autodev \
       ~/.omp/agent/commands/autodev.md \
       ~/.omp/agent/skills/autodev
```
（项目级替换 `~/.omp/agent` 为 `<项目>/.omp`）
