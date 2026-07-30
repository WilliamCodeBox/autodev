# autodev Offline Installation

Version: see [VERSION](../VERSION). Tarball: `autodev-v{VERSION}-offline.tar.gz`.

## Install (Choose One)

### A. Global Install (Available to All Projects)
```bash
mkdir -p ~/.omp/agent
tar -xzf autodev-v{VERSION}-offline.tar.gz -C ~/.omp/agent/
```

Verify:
```bash
ls ~/.omp/agent/tools/autodev/index.ts
ls ~/.omp/agent/tools/autodev/lib/
```

### B. Project-Level Install (Current Repository Only)
```bash
cd <project-root>
mkdir -p .omp
tar -xzf autodev-v{VERSION}-offline.tar.gz -C .omp/
```

Verify:
```bash
ls .omp/tools/autodev/index.ts
ls .omp/tools/autodev/lib/
```

## Enable
Restart omp or reload extensions.

Verify:
- `autodev` tool is callable
- `/autodev` slash command is registered

## Runtime Data
On first run, `.omp/autodev/` is created automatically:
```
autodev.yaml          # Main state file
slices/<id>.yaml      # Per-slice tasks and acceptance criteria
artifacts/            # Persistent artifacts
handoffs/             # Slice handoff records
run.json              # Event log
```

## Uninstall
```bash
rm -rf ~/.omp/agent/tools/autodev \
       ~/.omp/agent/commands/autodev.md \
       ~/.omp/agent/skills/autodev
```
(For project-level install, replace `~/.omp/agent` with `<project>/.omp`)
