#!/usr/bin/env python3
"""Run the two existing SSOT guards in temporary copies, break one consumer, restore."""
import argparse
import ast
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run_case(out, name, copy_paths, test_path, mutate, copy_guard_sources=False):
    sandbox = out / name
    sandbox.mkdir(parents=True, exist_ok=False)
    for relative in copy_paths:
        src, dst = ROOT / relative, sandbox / relative
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("node_modules", "__pycache__"))
        else:
            shutil.copy2(src, dst)
    copied_sources = 0
    if copy_guard_sources:
        # Read extensions from the existing guard, so its scan policy has one source.
        guard = (ROOT / "cds/tests/services/preview-url-skill-drift.test.ts").read_text()
        extensions = ast.literal_eval(re.search(r"const SCAN_EXTENSIONS = (\[.*?\]);", guard, re.S).group(1))
        paths = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT)
        for relative in paths.decode().split("\0"):
            source = ROOT / relative
            if not relative or source.suffix not in extensions or not source.is_file():
                continue
            target = sandbox / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied_sources += 1
        if copied_sources < 100:
            raise RuntimeError("真实来源复制范围不足，拒绝将空目录上的绿灯当作基线")
    module = "cds" if name == "cds-address" else "prd-admin"
    module_dir = sandbox / module
    (module_dir / "node_modules").symlink_to(ROOT / module / "node_modules", target_is_directory=True)
    (module_dir / "package.json").write_text('{"type":"module"}\n')
    config = module_dir / "vitest.config.mjs"
    config.write_text("import {defineConfig} from 'vitest/config';\nexport default defineConfig({resolve:{alias:{'@':new URL('./src',import.meta.url).pathname}},test:{include:['" + test_path + "']}});\n")
    cmd = ["node", str(ROOT / module / "node_modules/vitest/vitest.mjs"), "run", "--config", str(config)]
    results = []
    def execute(phase):
        result = subprocess.run(cmd, cwd=module_dir, capture_output=True, text=True, timeout=90)
        log = out / (name + "-" + phase + ".log")
        log.write_text(result.stdout + result.stderr)
        results.append({"phase": phase, "exit_code": result.returncode, "log": log.name,
                        "sha256": hashlib.sha256(log.read_bytes()).hexdigest()})
        return result
    before = execute("baseline")
    if before.returncode:
        raise RuntimeError(f"{name} 基线未通过，详见日志，不能算红绿演练")
    restore, failure_marker = mutate(sandbox)
    try:
        broken = execute("broken")
    finally:
        restore()
    if broken.returncode != 1 or failure_marker not in broken.stdout + broken.stderr:
        raise RuntimeError(f"{name} 没有出现预期断言失败")
    restored = execute("restored")
    if restored.returncode:
        raise RuntimeError(f"{name} 恢复后未通过")
    return {"name": name, "scope": "仅仓库外隔离副本；使用仓库已有测试；未修改工作区或线上系统",
            "copied_guard_source_files": copied_sources, "results": results}


def address_mutation(sandbox):
    target = sandbox / ".claude/skills/tutorial-drift-demo/SKILL.md"
    target.parent.mkdir(parents=True)
    # Deliberately recreate an obsolete producer only in the teaching sandbox.
    target.write_text("# isolated teaching mutation\n" + "https://" + "${BRANCH_ID}" + ".miduo.org\n")
    return lambda: target.unlink(), "tutorial-drift-demo"


def film_mutation(sandbox):
    target = sandbox / "prd-admin/src/pages/home/i18n/landing.ts"
    original = target.read_text()
    old = "title: '{duration} 秒，看它怎么干活'"
    if old not in original:
        raise RuntimeError("片花标题已变化，请重新选择演练点")
    target.write_text(original.replace(old, "title: '52 秒，看它怎么干活'", 1))
    return lambda: target.write_text(original), "中英文标题都用 {duration} 占位"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if out.is_relative_to(ROOT):
        parser.error("演练产物必须在仓库外")
    out.mkdir(parents=True, exist_ok=True)
    address = run_case(out, "cds-address", ["cds/tests/services/preview-url-skill-drift.test.ts"],
                       "tests/services/preview-url-skill-drift.test.ts", address_mutation, copy_guard_sources=True)
    film = run_case(out, "homepage-film", ["prd-admin/public/film/landing-score.mp3", "prd-admin/scripts/film/build-score.py",
                    "prd-admin/src/pages/home/film", "prd-admin/src/pages/home/i18n",
                    "prd-admin/src/lib/docGalaxy", "prd-admin/src/lib/__tests__/landingFilm.test.ts"],
                    "src/lib/__tests__/landingFilm.test.ts", film_mutation)
    (out / "rehearsal.json").write_text(json.dumps({"cases": [address, film]}, ensure_ascii=False, indent=2) + "\n")
    print("两例均完成：基线通过 → 单处消费者故意破坏后出现预期失败 → 恢复后通过。")


if __name__ == "__main__":
    main()
