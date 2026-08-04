# autodev Installation

Version: see [VERSION](../VERSION). Package: `@williamcodebox/autodev`.

## Install

```bash
omp plugin install @williamcodebox/autodev
```

The package provides three named agents (`autodev-scout`, `autodev-gatekeeper`, `autodev-implementer`), the `/autodev` slash command, and the `autodev` tool.

## Verify

```bash
omp plugin list
# Should show @williamcodebox/autodev as enabled

# Verify agents are discoverable (see them in agent suggestions when spawning subagents)
```

## Migration from Tarball (v1.0.0 and earlier)

If you previously installed autodev by extracting a tarball to `~/.omp/agent/` or `<project>/.omp/`, you **must** remove the old files before installing the npm package. The old files use the builtin discovery provider (priority 100), which **shadows** the npm plugin provider (priority 90).

```bash
# Global old install
rm -rf ~/.omp/agent/tools/autodev \
       ~/.omp/agent/commands/autodev.md \
       ~/.omp/agent/skills/autodev

# Project-level old install
rm -rf <project>/.omp/tools/autodev \
       <project>/.omp/commands/autodev.md \
       <project>/.omp/skills/autodev
```

Then install via `omp plugin install @williamcodebox/autodev` as above.

## Runtime Data
On first run, `.omp/autodev/` is created automatically:
```
autodev.yaml          # Main state file
slices/<id>.yaml      # Per-slice tasks and acceptance criteria
artifacts/            # Persistent artifacts
handoffs/             # Slice handoff records
run.json              # Event log
```

## Handoff / Resume Prerequisite
Slice boundary handoff only carries `handoff.md` + slice YAML — **agent definitions are not transferred**. A session resuming from handoff must have `@williamcodebox/autodev` installed, or the parent agent will fail-loud when trying to spawn named agents.

## Uninstall
```bash
omp plugin uninstall @williamcodebox/autodev
```
