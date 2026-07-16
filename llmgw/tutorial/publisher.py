#!/usr/bin/env python3
"""校验并受控发布《模型网关权威教程》。仅使用 Python 标准库。"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Protocol


ROOT = Path(__file__).resolve().parent
DEFAULT_MANIFEST = ROOT / "manifest.json"
PUBLISHER_PATH = "/api/open/document-store/publisher"
REQUIRED_SECTIONS = (
    "你在做什么",
    "为什么要做",
    "开始前检查",
    "跟我做",
    "看到什么算成功",
    "失败怎么办",
    "本章小结",
    "下一章",
)
IMAGE_PLACEHOLDERS = (
    re.compile(r"\{\{\s*IMG\s*:", re.IGNORECASE),
    re.compile(r"(?:TODO_IMAGE|IMAGE_PLACEHOLDER|待补图|图片待补)", re.IGNORECASE),
    re.compile(r"data:image/", re.IGNORECASE),
)
EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF]")
SUSPECT_SECRET_RE = re.compile(r"(?:gwk|sk-ak|sk)-[A-Za-z0-9_-]{16,}")
SELF_REPORTED_TENANT_RE = re.compile(r"(?:[?&]tenantId=|[\"']tenantId[\"']\s*:)", re.IGNORECASE)


class TutorialError(RuntimeError):
    pass


class ApiConflict(TutorialError):
    pass


@dataclasses.dataclass(frozen=True)
class SourceNode:
    source_id: str
    kind: str
    title: str
    source_path: str
    content: str
    source_sha256: str
    parent_source_id: str | None
    summary: str | None
    sort_order: float | None
    tags: list[str]
    metadata: dict[str, str]


@dataclasses.dataclass(frozen=True)
class TutorialSource:
    manifest_path: Path
    publisher: str
    title: str
    primary_source_id: str
    manifest_sha256: str
    nodes: list[SourceNode]


@dataclasses.dataclass(frozen=True)
class PlanItem:
    node: SourceNode
    action: str
    expected_updated_at: str | None
    last_applied_sha256: str | None
    reason: str


class PublisherGateway(Protocol):
    def snapshot(self, store_id: str, publisher: str) -> dict[str, Any]: ...
    def put_node(self, store_id: str, source_id: str, body: dict[str, Any]) -> dict[str, Any]: ...
    def set_primary(self, store_id: str, body: dict[str, Any]) -> dict[str, Any]: ...
    def delete_created_node(self, store_id: str, source_id: str, query: dict[str, str]) -> dict[str, Any]: ...


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalized_text(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise TutorialError(f"{path}: 不是 UTF-8 文本") from exc
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _safe_source_path(root: Path, value: str) -> Path:
    target = (root / value).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as exc:
        raise TutorialError(f"sourcePath 越出教程目录: {value}") from exc
    return target


def _section_positions(content: str, source_path: str) -> list[int]:
    positions: list[int] = []
    for section in REQUIRED_SECTIONS:
        match = re.search(rf"^##\s+{re.escape(section)}\s*$", content, re.MULTILINE)
        if not match:
            raise TutorialError(f"{source_path}: 缺少二级标题“{section}”")
        positions.append(match.start())
    if positions != sorted(positions):
        raise TutorialError(f"{source_path}: 教程段落顺序不正确")
    return positions


def _validate_chapter(node: SourceNode, number: int, next_title: str | None) -> None:
    content = node.content
    if len(content) < 900:
        raise TutorialError(f"{node.source_path}: 正文过短，至少需要 900 个字符")
    if len(re.findall(r"^#\s+", content, re.MULTILINE)) != 1:
        raise TutorialError(f"{node.source_path}: 必须且只能有一个一级标题")
    _section_positions(content, node.source_path)
    steps = re.findall(r"^\d+\.\s+", content, re.MULTILINE)
    if len(steps) < 4:
        raise TutorialError(f"{node.source_path}: “跟我做”至少需要 4 个编号步骤")
    failure_start = content.index("## 失败怎么办")
    failure_end = content.index("## 本章小结")
    failure_section = content[failure_start:failure_end]
    failures = re.findall(r"^(?:###\s+|[-*]\s+)", failure_section, re.MULTILINE)
    if len(failures) < 3:
        raise TutorialError(f"{node.source_path}: “失败怎么办”至少需要 3 个具体分支")
    next_section = content[content.rfind("## 下一章") :]
    if next_title and next_title not in next_section:
        raise TutorialError(f"{node.source_path}: 下一章没有指向“{next_title}”")
    if next_title is None and not re.search(r"(?:全书|本书|教程).*(?:完成|结束)", next_section):
        raise TutorialError(f"{node.source_path}: 最后一章必须明确全书完成")
    for pattern in IMAGE_PLACEHOLDERS:
        if pattern.search(content):
            raise TutorialError(f"{node.source_path}: 存在未解析图片占位符或内嵌图片")
    if EMOJI_RE.search(content):
        raise TutorialError(f"{node.source_path}: 包含禁止的 emoji 字符")
    if SUSPECT_SECRET_RE.search(content):
        raise TutorialError(f"{node.source_path}: 包含疑似真实密钥")
    if SELF_REPORTED_TENANT_RE.search(content):
        raise TutorialError(f"{node.source_path}: 出现请求自报 tenantId 的示例")


def load_and_validate(manifest_path: Path = DEFAULT_MANIFEST) -> TutorialSource:
    manifest_path = manifest_path.resolve()
    try:
        raw = normalized_text(manifest_path)
        manifest = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise TutorialError(f"无法读取 manifest: {exc}") from exc
    if manifest.get("schemaVersion") != 1:
        raise TutorialError("manifest.schemaVersion 必须为 1")
    publisher = manifest.get("publisher")
    if not isinstance(publisher, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,127}", publisher):
        raise TutorialError("manifest.publisher 不合法")
    root = manifest_path.parent
    raw_nodes = manifest.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise TutorialError("manifest.nodes 不能为空")
    nodes: list[SourceNode] = []
    source_ids: set[str] = set()
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
            path = _safe_source_path(root, source_path)
            if not path.is_file():
                raise TutorialError(f"{source_path}: 源文件不存在")
            content = normalized_text(path)
            if not content.strip():
                raise TutorialError(f"{source_path}: 正文为空")
        metadata = raw_node.get("metadata") or {}
        if not isinstance(metadata, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in metadata.items()):
            raise TutorialError(f"{source_id}: metadata 必须是字符串字典")
        tags = raw_node.get("tags") or []
        if not isinstance(tags, list) or not all(isinstance(item, str) for item in tags):
            raise TutorialError(f"{source_id}: tags 必须是字符串数组")
        nodes.append(SourceNode(
            source_id=source_id,
            kind=kind,
            title=title.strip(),
            source_path=source_path,
            content=content,
            source_sha256=sha256_text(content),
            parent_source_id=raw_node.get("parentSourceId"),
            summary=raw_node.get("summary"),
            sort_order=raw_node.get("sortOrder"),
            tags=tags,
            metadata=metadata,
        ))
    for node in nodes:
        if node.parent_source_id is not None:
            parent = next((candidate for candidate in nodes if candidate.source_id == node.parent_source_id), None)
            if parent is None or parent.kind != "folder":
                raise TutorialError(f"{node.source_id}: parentSourceId 不存在或不是目录")
    expected_chapters = [f"chapter-{number:02d}" for number in range(33)]
    actual_chapters = [node.source_id for node in nodes if node.source_id.startswith("chapter-")]
    if actual_chapters != expected_chapters:
        raise TutorialError("第 0 至 32 章必须按顺序且各出现一次")
    chapter_nodes = [next(node for node in nodes if node.source_id == source_id) for source_id in expected_chapters]
    for number, node in enumerate(chapter_nodes):
        next_title = chapter_nodes[number + 1].title.split("：", 1)[-1] if number < 32 else None
        _validate_chapter(node, number, next_title)
    primary = manifest.get("primarySourceId")
    if primary not in source_ids or next(node for node in nodes if node.source_id == primary).kind != "document":
        raise TutorialError("primarySourceId 必须指向一个受管文档")
    index_node = next(node for node in nodes if node.source_id == primary)
    if EMOJI_RE.search(index_node.content) or any(pattern.search(index_node.content) for pattern in IMAGE_PLACEHOLDERS):
        raise TutorialError("总目录包含 emoji 或未解析图片占位符")
    return TutorialSource(
        manifest_path=manifest_path,
        publisher=publisher,
        title=str(manifest.get("title") or "模型网关权威教程"),
        primary_source_id=primary,
        manifest_sha256=sha256_text(raw),
        nodes=nodes,
    )


class HttpPublisherGateway:
    def __init__(self, base_url: str, key: str, timeout: int = 45):
        if not key:
            raise TutorialError("缺少最小权限发布 key")
        self.base_url = base_url.rstrip("/")
        self.key = key
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.base_url + path, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.key}")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", "llmgw-authoritative-tutorial-publisher/1")
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
        data_payload = payload.get("data")
        if not isinstance(data_payload, dict):
            raise TutorialError(f"{method} {path} 返回格式不正确")
        return data_payload

    def snapshot(self, store_id: str, publisher: str) -> dict[str, Any]:
        query = urllib.parse.urlencode({"publisher": publisher})
        return self._request("GET", f"{PUBLISHER_PATH}/stores/{urllib.parse.quote(store_id)}/snapshot?{query}")

    def put_node(self, store_id: str, source_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"{PUBLISHER_PATH}/stores/{urllib.parse.quote(store_id)}/nodes/{urllib.parse.quote(source_id)}", body)

    def set_primary(self, store_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"{PUBLISHER_PATH}/stores/{urllib.parse.quote(store_id)}/primary", body)

    def delete_created_node(self, store_id: str, source_id: str, query: dict[str, str]) -> dict[str, Any]:
        encoded = urllib.parse.urlencode(query)
        return self._request("DELETE", f"{PUBLISHER_PATH}/stores/{urllib.parse.quote(store_id)}/nodes/{urllib.parse.quote(source_id)}?{encoded}")


def build_plan(source: TutorialSource, snapshot: dict[str, Any]) -> list[PlanItem]:
    if not snapshot.get("applyAllowed"):
        raise ApiConflict(f"远端快照不允许发布: {snapshot.get('conflicts')}")
    remote_nodes = snapshot.get("nodes")
    if not isinstance(remote_nodes, list):
        raise TutorialError("远端快照缺少 nodes")
    managed = {node.get("sourceId"): node for node in remote_nodes if node.get("managed")}
    expected_ids = {node.source_id for node in source.nodes}
    unexpected = sorted(str(source_id) for source_id in managed if source_id not in expected_ids)
    if unexpected:
        raise ApiConflict(f"远端存在 manifest 未声明的受管节点: {', '.join(unexpected)}")
    plan: list[PlanItem] = []
    for node in source.nodes:
        remote = managed.get(node.source_id)
        if remote is None:
            plan.append(PlanItem(node, "create", None, None, "远端不存在"))
            continue
        remote_kind = "folder" if remote.get("isFolder") else "document"
        if remote_kind != node.kind:
            plan.append(PlanItem(node, "conflict", remote.get("updatedAt"), None, "节点类型不同"))
            continue
        current = remote.get("contentSha256")
        metadata = remote.get("metadata") if isinstance(remote.get("metadata"), dict) else {}
        last_applied = metadata.get("lastAppliedSha256")
        if current != node.source_sha256 and current != last_applied:
            plan.append(PlanItem(node, "conflict", remote.get("updatedAt"), last_applied, "远端正文被人工修改"))
        elif current == node.source_sha256:
            plan.append(PlanItem(node, "verify-noop", remote.get("updatedAt"), last_applied, "正文一致，由服务端核对标题和元数据"))
        else:
            plan.append(PlanItem(node, "update", remote.get("updatedAt"), last_applied, "远端仍是上次发布版本"))
    return plan


def _source_revision() -> str:
    explicit = os.environ.get("TUTORIAL_SOURCE_REVISION")
    if explicit:
        return explicit[:128]
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL, timeout=5
        ).strip()[:128]
    except (OSError, subprocess.SubprocessError):
        return "working-tree"


def _request_body(source: TutorialSource, item: PlanItem, run_id: str, revision: str) -> dict[str, Any]:
    node = item.node
    return {
        "publisher": source.publisher,
        "runId": run_id,
        "kind": node.kind,
        "title": node.title,
        "summary": node.summary,
        "parentSourceId": node.parent_source_id,
        "sourcePath": node.source_path,
        "sourceSha256": node.source_sha256,
        "manifestSha256": source.manifest_sha256,
        "sourceRevision": revision,
        "lastAppliedSha256": item.last_applied_sha256,
        "expectedUpdatedAt": item.expected_updated_at,
        "contentType": "text/markdown",
        "content": node.content,
        "tags": node.tags,
        "category": "模型网关权威教程",
        "sortOrder": node.sort_order,
        "metadata": node.metadata,
    }


def _rollback_created(gateway: PublisherGateway, store_id: str, source: TutorialSource, run_id: str) -> list[str]:
    snapshot = gateway.snapshot(store_id, source.publisher)
    managed = {node.get("sourceId"): node for node in snapshot.get("nodes", []) if node.get("managed")}
    rolled_back: list[str] = []
    errors: list[str] = []
    for node in reversed(source.nodes):
        remote = managed.get(node.source_id)
        metadata = remote.get("metadata", {}) if isinstance(remote, dict) else {}
        if not remote or metadata.get("createdByRunId") != run_id or metadata.get("lastAppliedRunId") != run_id:
            continue
        try:
            gateway.delete_created_node(store_id, node.source_id, {
                "publisher": source.publisher,
                "runId": run_id,
                "expectedUpdatedAt": str(remote["updatedAt"]),
                "expectedSha256": str(remote["contentSha256"]),
                "expectedMetadataSha256": str(remote["metadataSha256"]),
            })
            rolled_back.append(node.source_id)
        except TutorialError as exc:
            errors.append(f"{node.source_id}: {exc}")
    if errors:
        raise TutorialError("发布失败，且安全回滚未完全结束: " + "; ".join(errors))
    return rolled_back


def apply_plan(gateway: PublisherGateway, store_id: str, source: TutorialSource, plan: list[PlanItem]) -> dict[str, Any]:
    conflicts = [item for item in plan if item.action == "conflict"]
    if conflicts:
        details = ", ".join(f"{item.node.source_id}({item.reason})" for item in conflicts)
        raise ApiConflict(f"发布计划包含冲突: {details}")
    run_id = f"run-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
    revision = _source_revision()
    actions: list[dict[str, str]] = []
    try:
        for item in plan:
            result = gateway.put_node(store_id, item.node.source_id, _request_body(source, item, run_id, revision))
            action = str(result.get("action") or "unknown")
            actions.append({"sourceId": item.node.source_id, "action": action})
            if action not in ("created", "updated", "noop"):
                raise TutorialError(f"{item.node.source_id}: 服务端返回未知 action {action}")
        final_snapshot = gateway.snapshot(store_id, source.publisher)
        primary_remote = next(
            (node for node in final_snapshot.get("nodes", []) if node.get("sourceId") == source.primary_source_id and node.get("managed")),
            None,
        )
        if primary_remote is None:
            raise TutorialError("发布后找不到主文档")
        primary_changed = final_snapshot.get("store", {}).get("primaryEntryId") != primary_remote.get("id")
        if primary_changed:
            gateway.set_primary(store_id, {
                "publisher": source.publisher,
                "sourceId": source.primary_source_id,
                "expectedStoreUpdatedAt": final_snapshot["store"]["updatedAt"],
            })
        verified = gateway.snapshot(store_id, source.publisher)
        expected = {node.source_id: node.source_sha256 for node in source.nodes}
        actual = {
            node.get("sourceId"): node.get("contentSha256")
            for node in verified.get("nodes", [])
            if node.get("managed")
        }
        mismatches = sorted(source_id for source_id, value in expected.items() if actual.get(source_id) != value)
        if mismatches:
            raise TutorialError(f"发布后 SHA256 不一致: {', '.join(mismatches)}")
        return {
            "runId": run_id,
            "actions": actions,
            "counts": {name: sum(1 for item in actions if item["action"] == name) for name in ("created", "updated", "noop")},
            "primaryChanged": primary_changed,
            "snapshotSha256": verified.get("snapshotSha256"),
        }
    except Exception:
        _rollback_created(gateway, store_id, source, run_id)
        raise


def plan_as_dict(plan: list[PlanItem]) -> list[dict[str, Any]]:
    return [
        {
            "sourceId": item.node.source_id,
            "title": item.node.title,
            "action": item.action,
            "reason": item.reason,
            "sourceSha256": item.node.source_sha256,
        }
        for item in plan
    ]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="校验并发布模型网关权威教程")
    parser.add_argument("command", choices=("check", "plan", "apply"))
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--base-url", default=os.environ.get("MAP_BASE_URL", "https://map.ebcone.net"))
    parser.add_argument("--store-id", default=os.environ.get("MAP_TUTORIAL_STORE_ID"))
    parser.add_argument("--key-env", default="MAP_DOC_STORE_KEY")
    parser.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        source = load_and_validate(args.manifest)
        if args.command == "check":
            result: dict[str, Any] = {
                "status": "ok",
                "title": source.title,
                "publisher": source.publisher,
                "chapterCount": 33,
                "nodeCount": len(source.nodes),
                "manifestSha256": source.manifest_sha256,
                "unresolvedImagePlaceholders": 0,
            }
        else:
            if not args.store_id:
                raise TutorialError("plan/apply 必须提供 --store-id 或 MAP_TUTORIAL_STORE_ID")
            gateway = HttpPublisherGateway(args.base_url, os.environ.get(args.key_env, ""))
            snapshot = gateway.snapshot(args.store_id, source.publisher)
            plan = build_plan(source, snapshot)
            result = {"status": "ok", "storeId": args.store_id, "plan": plan_as_dict(plan)}
            if args.command == "apply":
                result["apply"] = apply_plan(gateway, args.store_id, source, plan)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        elif args.command == "check":
            print(f"检查通过: {result['chapterCount']} 章, {result['nodeCount']} 个受管节点, 图片占位符 0")
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
