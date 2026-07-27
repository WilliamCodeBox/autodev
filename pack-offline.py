#!/usr/bin/env python3
# pack-offline.py
# 在 Windows 上把 autodev 扩展打包成离线可用的 tar.gz。
# 用 Python 标准库 tarfile，避免 git-bash 的 sed/tar 在 Windows 上的行尾/权限/路径怪癖。
# 生成的 PAX 格式 tar.gz 在 Linux 上原生兼容，且脚本内做完整性校验。
import os
import sys
import shutil
import tarfile
import subprocess
import tempfile

ROOT = r"D:\WorkBuddy\pi-autodev"
SRC = os.path.join(ROOT, "autodev-extension")
DIST = os.path.join(SRC, "dist")
OUT = os.path.join(DIST, "autodev-v7-offline.tar.gz")
BUN = r"C:\Users\luroy\.bun\bin\bun.exe"

# 源文件 -> 包内相对路径(posix)（自包含布局：lib 内联进 tools/autodev/lib/）
FILES = [
    (os.path.join(SRC, "tools/autodev/index.ts"), "tools/autodev/index.ts"),
    (os.path.join(SRC, "tools/autodev/lib/autodev-state.mjs"), "tools/autodev/lib/autodev-state.mjs"),
    (os.path.join(SRC, "tools/autodev/lib/recon-score.mjs"), "tools/autodev/lib/recon-score.mjs"),
    (os.path.join(SRC, "tools/autodev/lib/yaml-lite.mjs"), "tools/autodev/lib/yaml-lite.mjs"),
    (os.path.join(SRC, "commands/autodev.md"), "commands/autodev.md"),
    (os.path.join(SRC, "skills/autodev/SKILL.md"), "skills/autodev/SKILL.md"),
    (os.path.join(SRC, "INSTALL.md"), "INSTALL.md"),
]

# 用系统临时目录下的唯一 stage（避免 Windows 沙箱对 rmtree 的拦截，且每次干净）
STAGE = tempfile.mkdtemp(prefix="autodev-pack-")


def to_lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


# 复制 + 统一 LF + 行尾校验
for src, arc in FILES:
    if not os.path.isfile(src):
        print(f"MISSING: {src}")
        sys.exit(1)
    with open(src, "rb") as f:
        data = to_lf(f.read())
    if b"\r" in data:
        print(f"CRLF STILL PRESENT after normalize: {arc}")
        sys.exit(1)
    target = os.path.join(STAGE, arc)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as f:
        f.write(data)
    print(f"staged: {arc} ({len(data)} bytes, LF)")

# 打包（PAX 格式，Linux 兼容，不写 Windows 权限怪癖）
with tarfile.open(OUT, "w:gz", format=tarfile.PAX_FORMAT) as tar:
    for src, arc in FILES:
        tar.add(os.path.join(STAGE, arc), arcname=arc)
print(f"\nPACKED: {OUT}")
print(f"SIZE: {os.path.getsize(OUT)} bytes")

# 校验：重新读取归档，核对成员 + 无 CRLF + 必备结构
with tarfile.open(OUT, "r:gz") as tar:
    names = tar.getnames()
    print("\n=== tar members ===")
    for n in names:
        print("  ", n)
    for m in tar.getmembers():
        if m.isfile():
            d = tar.extractfile(m).read()
            if b"\r" in d:
                print(f"CRLF in archive member {m.name}!")
                sys.exit(1)
    required = [
        "tools/autodev/index.ts",
        "tools/autodev/lib/autodev-state.mjs",
        "tools/autodev/lib/recon-score.mjs",
        "tools/autodev/lib/yaml-lite.mjs",
        "commands/autodev.md",
        "skills/autodev/SKILL.md",
        "INSTALL.md",
    ]
    missing = [r for r in required if r not in names]
    if missing:
        print("MISSING members:", missing)
        sys.exit(1)
print("structure + LF check: OK")

# bun 加载图校验（解析 tools/autodev/index.ts 的 ./lib 导入）
if os.path.isfile(BUN):
    r = subprocess.run(
        [BUN, "build", os.path.join(STAGE, "tools/autodev/index.ts"),
         "--external", "node:fs", "--external", "node:path",
         "--external", "node:child_process", "--external", "node:util"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    print("\n=== bun build (import graph) ===")
    print("rc =", r.returncode)
    if r.returncode != 0:
        print(r.stderr)
        sys.exit(1)
    print("bun build OK — ./lib import graph resolves")
else:
    print(f"\n[skip] bun not found at {BUN}, 跳过加载图校验")

print("\nDONE")
