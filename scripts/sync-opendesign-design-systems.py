#!/usr/bin/env python3
"""
从钉住版本的 OpenDesign 镜像里抽出全部设计系统的元数据与 tokens.css，
生成 prd-api 内嵌的风格目录快照：

    prd-api/src/PrdAgent.Api/Resources/DesignSystems/opendesign-design-systems.json

为什么是快照而不是运行时去读镜像：MAP 的 API 容器里没有 OpenDesign，风格选择与样张
又要秒开；而 OpenDesign 的版本本来就是钉死的（cds/open-design-runtime/Dockerfile 的
FROM 行），所以「这个版本的设计系统长什么样」是一份可以提交进仓库、可以 diff 的事实。

只收 manifest 里的 id / name / category / description、DESIGN.md 开头的一句话摘要，
以及去掉注释后的 tokens.css；kit.html、components.html、preview/ 这类大文件一概不收。

用法：
    python3 scripts/sync-opendesign-design-systems.py            # 从镜像读取
    python3 scripts/sync-opendesign-design-systems.py --from-dir /path/to/design-systems

可重跑：设计系统按 id 排序；内容与现有快照一致时沿用原来的生成时间，文件逐字节不变。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

# 与 cds/open-design-runtime/Dockerfile 的 FROM 行必须是同一个版本；脚本启动时会核对。
OPENDESIGN_VERSION = "0.21.1"
OPENDESIGN_IMAGE = f"ghcr.io/nexu-io/od:{OPENDESIGN_VERSION}"
IMAGE_DESIGN_SYSTEMS_DIR = "/app/design-systems"

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DOCKERFILE = os.path.join(REPO_ROOT, "cds", "open-design-runtime", "Dockerfile")
OUTPUT = os.path.join(
    REPO_ROOT, "prd-api", "src", "PrdAgent.Api", "Resources", "DesignSystems", "opendesign-design-systems.json"
)
SCHEMA_VERSION = "map-design-system-catalog/v1"

# 样张模板与目录接口依赖的语义令牌。任何一个设计系统缺了其中一个，就拒绝生成快照，
# 而不是让样张在某个风格上悄悄退化成浏览器默认样式。
REQUIRED_TOKENS = (
    "--bg", "--surface", "--surface-warm", "--fg", "--fg-2", "--muted", "--meta",
    "--border", "--border-soft", "--accent", "--accent-on",
    "--font-display", "--font-body", "--font-mono",
    "--text-xs", "--text-sm", "--text-base", "--text-lg", "--text-xl", "--text-2xl", "--text-3xl", "--text-4xl",
    "--leading-body", "--leading-tight", "--tracking-display",
    "--space-2", "--space-3", "--space-4", "--space-6", "--space-8", "--space-12",
    "--radius-sm", "--radius-md", "--radius-lg", "--radius-pill",
    "--elev-ring", "--elev-raised",
)


def fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"[sync-opendesign-design-systems] {message}", file=sys.stderr)
    sys.exit(1)


def check_pinned_version() -> None:
    try:
        with open(DOCKERFILE, encoding="utf-8") as handle:
            first_from = next(line for line in handle if line.strip().upper().startswith("FROM "))
    except (OSError, StopIteration):
        fail(f"读不到 {DOCKERFILE} 的 FROM 行，无法确认 OpenDesign 版本")
    image = first_from.split()[1]
    if image != OPENDESIGN_IMAGE:
        fail(
            f"版本不一致：脚本钉的是 {OPENDESIGN_IMAGE}，{os.path.relpath(DOCKERFILE, REPO_ROOT)} 用的是 {image}。"
            "先把脚本里的 OPENDESIGN_VERSION 改成同一个版本再跑。"
        )


def run(args: list[str]) -> str:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        fail(f"命令失败：{' '.join(args)}\n{result.stderr.strip()}")
    return result.stdout.strip()


def extract_from_image(target: str) -> str:
    """docker create + docker cp，不启动容器、不执行镜像里的任何程序。"""
    if shutil.which("docker") is None:
        fail("本机没有 docker；也可以用 --from-dir 指向已经取出来的 design-systems 目录")
    image_id = run(["docker", "image", "inspect", "--format", "{{.Id}}", OPENDESIGN_IMAGE])
    name = f"map-od-design-systems-{uuid.uuid4().hex[:8]}"
    run(["docker", "create", "--name", name, OPENDESIGN_IMAGE])
    try:
        run(["docker", "cp", f"{name}:{IMAGE_DESIGN_SYSTEMS_DIR}", target])
    finally:
        subprocess.run(["docker", "rm", name], capture_output=True)
    return image_id


def strip_css_comments(css: str) -> str:
    without = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    lines = [line.rstrip() for line in without.splitlines()]
    compact: list[str] = []
    for line in lines:
        if not line.strip() and (not compact or not compact[-1].strip()):
            continue
        compact.append(line)
    return "\n".join(compact).strip() + "\n"


def design_summary(design_md: str) -> str | None:
    """DESIGN.md 开头 `> Category: ...` 之后紧跟的那段引用（可能折成两行），遇到 `> **` 元数据行即止。"""
    lines = design_md.splitlines()[:40]
    for index, line in enumerate(lines):
        if not line.startswith("> Category"):
            continue
        parts: list[str] = []
        for follow in lines[index + 1:]:
            if not follow.startswith(">"):
                break
            text = follow[1:].strip()
            if not text or text.startswith("**"):
                break
            parts.append(text)
        summary = " ".join(parts).strip().rstrip("—").strip()
        return summary or None
    return None


def read_design_systems(root: str) -> list[dict]:
    systems = []
    for entry in sorted(os.listdir(root)):
        folder = os.path.join(root, entry)
        manifest_path = os.path.join(folder, "manifest.json")
        if not os.path.isdir(folder) or not os.path.exists(manifest_path):
            continue  # README.md、_schema 这类不是设计系统
        with open(manifest_path, encoding="utf-8") as handle:
            manifest = json.load(handle)
        system_id = manifest.get("id")
        if system_id != entry:
            fail(f"{entry}/manifest.json 的 id 是 {system_id!r}，与目录名不一致")
        tokens_path = os.path.join(folder, "tokens.css")
        if not os.path.exists(tokens_path):
            fail(f"{entry} 没有 tokens.css")
        with open(tokens_path, encoding="utf-8") as handle:
            tokens_css = strip_css_comments(handle.read())
        missing = [name for name in REQUIRED_TOKENS if not re.search(r"(^|[\s;{])" + re.escape(name) + r"\s*:", tokens_css)]
        if missing:
            fail(f"{entry} 的 tokens.css 缺少语义令牌：{', '.join(missing)}")
        design_md_path = os.path.join(folder, "DESIGN.md")
        summary = None
        if os.path.exists(design_md_path):
            with open(design_md_path, encoding="utf-8") as handle:
                summary = design_summary(handle.read())
        description = (manifest.get("description") or "").strip()
        systems.append({
            "id": system_id,
            "name": (manifest.get("name") or system_id).strip(),
            "category": (manifest.get("category") or "Uncategorized").strip(),
            "description": description,
            "summary": summary or description,
            "summarySource": "design-md" if summary else "manifest-description",
            "tokensCss": tokens_css,
        })
    if not systems:
        fail(f"{root} 下一个设计系统都没找到")
    return systems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-dir", help="已经取出来的 design-systems 目录（跳过 docker）")
    args = parser.parse_args()

    check_pinned_version()
    with tempfile.TemporaryDirectory(prefix="od-design-systems-") as temp:
        if args.from_dir:
            root = os.path.abspath(args.from_dir)
            image_id = None
        else:
            root = os.path.join(temp, "design-systems")
            image_id = extract_from_image(root)
        systems = read_design_systems(root)

    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "engine": {
            "name": "open-design",
            "version": OPENDESIGN_VERSION,
            "image": OPENDESIGN_IMAGE,
            "sourceDir": IMAGE_DESIGN_SYSTEMS_DIR,
        },
        "generatedAt": None,
        "count": len(systems),
        "designSystems": systems,
    }

    previous = None
    if os.path.exists(OUTPUT):
        with open(OUTPUT, encoding="utf-8") as handle:
            try:
                previous = json.load(handle)
            except json.JSONDecodeError:
                previous = None
    if image_id is None and previous:
        image_id = (previous.get("engine") or {}).get("imageId")
    snapshot["engine"]["imageId"] = image_id

    def comparable(doc: dict | None) -> str:
        if not doc:
            return ""
        return json.dumps({k: v for k, v in doc.items() if k != "generatedAt"}, ensure_ascii=False, sort_keys=True)

    if previous and comparable(previous) == comparable(snapshot):
        snapshot["generatedAt"] = previous.get("generatedAt")
        changed = False
    else:
        snapshot["generatedAt"] = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        changed = True

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(snapshot, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    size_kb = os.path.getsize(OUTPUT) / 1024
    status = "已更新" if changed else "内容未变，沿用原生成时间"
    print(
        f"{status}：{len(systems)} 套设计系统（OpenDesign {OPENDESIGN_VERSION}），"
        f"{os.path.relpath(OUTPUT, REPO_ROOT)} {size_kb:.0f} KB"
    )


if __name__ == "__main__":
    main()
