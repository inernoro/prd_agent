#!/usr/bin/env python3
"""校验并受控发布《CDS 权威教程》。仅使用 Python 标准库。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


TUTORIAL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TUTORIAL_ROOT.parents[1]
DEFAULT_MANIFEST = TUTORIAL_ROOT / "manifest.json"
CORE_PATH = REPO_ROOT / "llmgw" / "tutorial" / "publisher.py"
MIN_CHAPTER_CHARACTERS = 400
MIN_BOOK_CHARACTERS = 100_000
ALLOWED_SOURCE_PREFIXES = ("cds/tutorial/", "doc/")
CDS_SUSPECT_SECRET_RE = re.compile(r"(?:gwk|sk-ak|sk-ant)-([A-Za-z0-9_-]{16,})")
LEGACY_SYMBOL_TEXT = {
    0x2705: "[通过]",
    0x274C: "[失败]",
    0x26A0: "[警告]",
    0x2605: "[推荐]",
    0x2713: "[通过]",
    0x2717: "[不通过]",
    0x1F7E0: "[必选]",
    0x1F7E1: "[可选]",
    0x1F7E2: "[自动]",
    0x1F511: "[密钥]",
    0x1F4E6: "[项目]",
    0x2699: "[设置]",
    0x1F504: "[刷新]",
    0x270F: "[编辑]",
}


def _load_core():
    spec = importlib.util.spec_from_file_location("llmgw_tutorial_publisher_core", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载受控发布核心: {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


core = _load_core()
TutorialError = core.TutorialError
ApiConflict = core.ApiConflict


def _safe_repo_source(value: str) -> Path:
    if not value.startswith(ALLOWED_SOURCE_PREFIXES):
        raise TutorialError(f"sourcePath 只允许 cds/tutorial/ 或 doc/: {value}")
    target = (REPO_ROOT / value).resolve()
    try:
        target.relative_to(REPO_ROOT.resolve())
    except ValueError as exc:
        raise TutorialError(f"sourcePath 越出仓库: {value}") from exc
    return target


def _text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    except (OSError, UnicodeDecodeError) as exc:
        raise TutorialError(f"无法读取 UTF-8 源文件 {path}: {exc}") from exc


def _sanitize_legacy_symbols(content: str) -> str:
    return core.EMOJI_RE.sub(lambda match: LEGACY_SYMBOL_TEXT.get(ord(match.group(0)), ""), content)


def _contains_suspect_secret(content: str) -> bool:
    for match in CDS_SUSPECT_SECRET_RE.finditer(content):
        suffix = match.group(1)
        if set(suffix.lower()) <= {"x"}:
            continue
        return True
    return False


def load_and_validate(manifest_path: Path = DEFAULT_MANIFEST):
    manifest_path = manifest_path.resolve()
    try:
        manifest_raw = _text(manifest_path)
        manifest = json.loads(manifest_raw)
    except json.JSONDecodeError as exc:
        raise TutorialError(f"manifest JSON 无效: {exc}") from exc
    if manifest.get("schemaVersion") != 1:
        raise TutorialError("manifest.schemaVersion 必须为 1")
    publisher = manifest.get("publisher")
    if not isinstance(publisher, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,127}", publisher):
        raise TutorialError("manifest.publisher 不合法")
    raw_nodes = manifest.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise TutorialError("manifest.nodes 不能为空")

    nodes = []
    source_ids: set[str] = set()
    total_characters = 0
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            raise TutorialError("manifest.nodes 每项必须是对象")
        source_id = raw_node.get("sourceId")
        kind = raw_node.get("kind")
        source_path = raw_node.get("sourcePath")
        title = raw_node.get("title")
        if not isinstance(source_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,127}", source_id):
            raise TutorialError(f"sourceId 不合法: {source_id!r}")
        if source_id in source_ids:
            raise TutorialError(f"sourceId 重复: {source_id}")
        source_ids.add(source_id)
        if kind not in ("folder", "document"):
            raise TutorialError(f"{source_id}: kind 必须是 folder 或 document")
        if not isinstance(title, str) or not title.strip():
            raise TutorialError(f"{source_id}: title 不能为空")
        if not isinstance(source_path, str) or not source_path:
            raise TutorialError(f"{source_id}: sourcePath 不能为空")
        content = ""
        if kind == "document":
            source_file = _safe_repo_source(source_path)
            if not source_file.is_file():
                raise TutorialError(f"{source_path}: 源文件不存在")
            content = _text(source_file)
            if len(content) < MIN_CHAPTER_CHARACTERS:
                raise TutorialError(f"{source_path}: 正文过短，至少 {MIN_CHAPTER_CHARACTERS} 个字符")
            if core.EMOJI_RE.search(content):
                if source_path.startswith("cds/tutorial/"):
                    raise TutorialError(f"{source_path}: 包含禁止的 emoji 字符")
                content = _sanitize_legacy_symbols(content)
            if _contains_suspect_secret(content):
                raise TutorialError(f"{source_path}: 包含疑似真实密钥")
            for pattern in core.IMAGE_PLACEHOLDERS:
                if pattern.search(content):
                    raise TutorialError(f"{source_path}: 存在未解析图片占位符或内嵌图片")
            total_characters += len(content)
        metadata = raw_node.get("metadata") or {}
        tags = raw_node.get("tags") or []
        if not isinstance(metadata, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in metadata.items()):
            raise TutorialError(f"{source_id}: metadata 必须是字符串字典")
        if not isinstance(tags, list) or not all(isinstance(item, str) for item in tags):
            raise TutorialError(f"{source_id}: tags 必须是字符串数组")
        nodes.append(core.SourceNode(
            source_id=source_id,
            kind=kind,
            title=title.strip(),
            source_path=source_path,
            content=content,
            source_sha256=core.sha256_text(content),
            parent_source_id=raw_node.get("parentSourceId"),
            summary=raw_node.get("summary"),
            sort_order=raw_node.get("sortOrder"),
            tags=tags,
            metadata=metadata,
        ))

    by_id = {node.source_id: node for node in nodes}
    for node in nodes:
        if node.parent_source_id is None:
            continue
        parent = by_id.get(node.parent_source_id)
        if parent is None or parent.kind != "folder":
            raise TutorialError(f"{node.source_id}: parentSourceId 不存在或不是目录")
    chapter_ids = [node.source_id for node in nodes if node.source_id.startswith("chapter-")]
    expected = [f"chapter-{number:02d}" for number in range(len(chapter_ids))]
    if chapter_ids != expected:
        raise TutorialError("章节 sourceId 必须从 chapter-00 开始连续递增")
    if len(chapter_ids) < 20:
        raise TutorialError("CDS 权威教程至少需要 20 个连续章节")
    if total_characters < MIN_BOOK_CHARACTERS:
        raise TutorialError(f"全书正文过短，至少 {MIN_BOOK_CHARACTERS} 个字符，当前 {total_characters}")
    primary = manifest.get("primarySourceId")
    if primary not in by_id or by_id[primary].kind != "document":
        raise TutorialError("primarySourceId 必须指向受管文档")
    return core.TutorialSource(
        manifest_path=manifest_path,
        publisher=publisher,
        title=str(manifest.get("title") or "CDS 权威教程"),
        primary_source_id=primary,
        manifest_sha256=core.sha256_text(manifest_raw),
        nodes=nodes,
        category=str(manifest.get("category") or "CDS 权威教程"),
    )


class AiHeaderPublisherGateway(core.HttpPublisherGateway):
    def __init__(self, base_url: str, key: str, impersonate: str, timeout: int = 45):
        super().__init__(base_url, key, timeout)
        self.impersonate = impersonate

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        request.add_header("X-AI-Access-Key", self.key)
        request.add_header("X-AI-Impersonate", self.impersonate)
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", "cds-authoritative-tutorial-publisher/1")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            message = exc.read().decode("utf-8", "replace")[:1000]
            if exc.code == 409:
                raise ApiConflict(f"{method} {path} 返回 409: {message}") from exc
            raise TutorialError(f"{method} {path} 返回 HTTP {exc.code}: {message}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise TutorialError(f"{method} {path} 请求失败: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise TutorialError(f"{method} {path} 业务失败: {payload}")
        result = payload.get("data")
        if not isinstance(result, dict):
            raise TutorialError(f"{method} {path} 返回格式不正确")
        return result


def _gateway(base_url: str):
    scoped = os.environ.get("MAP_DOC_STORE_KEY", "").strip()
    if scoped:
        return core.HttpPublisherGateway(base_url, scoped)
    key = os.environ.get("AI_ACCESS_KEY", "").strip()
    impersonate = os.environ.get("MAP_AI_USER", "").strip()
    if not key or not impersonate:
        raise TutorialError("缺少 MAP_DOC_STORE_KEY，且 AI_ACCESS_KEY + MAP_AI_USER 回退不完整")
    return AiHeaderPublisherGateway(base_url, key, impersonate)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="校验并发布 CDS 权威教程")
    parser.add_argument("command", choices=("check", "plan", "apply"))
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--base-url", default=os.environ.get("MAP_BASE_URL", "https://map.ebcone.net"))
    parser.add_argument("--store-id", default=os.environ.get("CDS_TUTORIAL_STORE_ID"))
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        source = load_and_validate(args.manifest)
        chapters = [node for node in source.nodes if node.source_id.startswith("chapter-")]
        total_characters = sum(len(node.content) for node in source.nodes if node.kind == "document")
        if args.command == "check":
            result: dict[str, Any] = {
                "status": "ok",
                "title": source.title,
                "publisher": source.publisher,
                "chapterCount": len(chapters),
                "nodeCount": len(source.nodes),
                "totalCharacters": total_characters,
                "manifestSha256": source.manifest_sha256,
            }
        else:
            if not args.store_id:
                raise TutorialError("plan/apply 必须提供 --store-id 或 CDS_TUTORIAL_STORE_ID")
            gateway = _gateway(args.base_url)
            snapshot = gateway.snapshot(args.store_id, source.publisher)
            plan = core.build_plan(source, snapshot)
            result = {"status": "ok", "storeId": args.store_id, "plan": core.plan_as_dict(plan)}
            if args.command == "apply":
                result["apply"] = core.apply_plan(gateway, args.store_id, source, plan)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        elif args.command == "check":
            print(f"检查通过: {result['chapterCount']} 章, {result['nodeCount']} 个受管节点, {result['totalCharacters']} 个正文字符")
        elif args.command == "plan":
            counts = {name: sum(1 for item in result["plan"] if item["action"] == name) for name in ("create", "update", "verify-noop", "conflict")}
            print("发布计划: " + ", ".join(f"{name}={count}" for name, count in counts.items()))
        else:
            counts = result["apply"]["counts"]
            print("发布完成: " + ", ".join(f"{name}={counts[name]}" for name in ("created", "updated", "noop")))
        return 0
    except TutorialError as exc:
        print(f"失败: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
