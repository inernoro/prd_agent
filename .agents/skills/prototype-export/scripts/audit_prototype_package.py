#!/usr/bin/env python3
"""只读审计产品原型 ZIP，不解压、不执行包内文件。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import stat
import sys
import zipfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


DEFAULT_ENTRY_LIMIT = 5000
DEFAULT_EXTRACTED_LIMIT = 500 * 1024 * 1024
DEFAULT_MANIFEST_LIMIT = 12 * 1024 * 1024
MAX_INSPECT_BYTES = 2 * 1024 * 1024

DEV_DIRS = {
    ".git", ".cache", ".parcel-cache", ".turbo", ".vite", "coverage",
    "node_modules", "screenshots", "test-results", "tests",
}
DEV_FILES = {
    ".ds_store", "eslint.config.js", "package-lock.json", "pnpm-lock.yaml",
    "tsconfig.json", "vite.config.js", "vite.config.ts", "yarn.lock",
}
HTML_REFERENCE_ATTRS = {"src", "href", "poster", "data"}
CSS_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+)", re.IGNORECASE)
CSS_IMPORT_RE = re.compile(r"@import\s+(?:url\(\s*)?['\"]([^'\"]+)", re.IGNORECASE)
JS_REFERENCE_RE = re.compile(
    r"(?:import\s+(?:[^'\"]*?\s+from\s+)?|export\s+[^'\"]*?\s+from\s+|"
    r"import\s*\(\s*|require\s*\(\s*|fetch\s*\(\s*|new\s+(?:Shared)?Worker\s*\(\s*|"
    r"navigator\.serviceWorker\.register\s*\(\s*|importScripts\s*\(\s*)['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)
DYNAMIC_RUNTIME_LOADER_RE = re.compile(
    r"(?:fetch|import|require|importScripts)\s*\(|new\s+(?:Shared)?Worker\s*\(|"
    r"navigator\.serviceWorker\.register\s*\(",
    re.IGNORECASE,
)
STATIC_RUNTIME_LOADER_RE = re.compile(
    r"(?:fetch|import|require|importScripts)\s*\(\s*['\"][^'\"]+['\"]|"
    r"new\s+(?:Shared)?Worker\s*\(\s*['\"][^'\"]+['\"]|"
    r"navigator\.serviceWorker\.register\s*\(\s*['\"][^'\"]+['\"]",
    re.IGNORECASE,
)
INLINE_SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)
INLINE_STYLE_RE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.IGNORECASE | re.DOTALL)
RUNTIME_TEXT_SUFFIXES = {".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"}


class ReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[str] = []
        self.inline_styles: list[str] = []
        self.base_href: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() == "base":
            if self.base_href is None:
                self.base_href = next(
                    (
                        value.strip()
                        for key, value in attrs
                        if key.casefold() == "href" and value and value.strip()
                    ),
                    None,
                )
            return
        for key, value in attrs:
            if key.lower() in HTML_REFERENCE_ATTRS and value:
                self.references.append(value.strip())
            elif key.lower() == "srcset" and value:
                self.references.extend(part.strip().split(" ", 1)[0] for part in value.split(","))
            elif key.lower() == "style" and value:
                self.inline_styles.append(value)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_name(raw_name: str) -> str:
    return raw_name.replace("\\", "/")


def is_unsafe_path(name: str) -> bool:
    if not name or "\x00" in name:
        return True
    if name.startswith("/") or re.match(r"^[A-Za-z]:/", name):
        return True
    return any(part == ".." for part in PurePosixPath(name).parts)


def is_external_reference(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith(("http://", "https://", "//"))


def resolve_local_reference(owner: str, value: str, base_href: str | None = None) -> str | None:
    value = value.strip()
    if not value or value.startswith(("#", "data:", "mailto:", "tel:", "javascript:")):
        return None
    if is_external_reference(value):
        return None
    path = unquote(urlsplit(value).path)
    if not path or path.endswith("/"):
        return None
    if path.startswith("/"):
        return path.lstrip("/")
    effective_owner = owner
    if base_href:
        if is_external_reference(base_href):
            return None
        base_path = unquote(urlsplit(base_href).path).replace("\\", "/")
        if base_path:
            if base_path.endswith("/"):
                base_path += "__base__.html"
            effective_owner = (
                base_path.lstrip("/")
                if base_path.startswith("/")
                else posixpath.normpath(posixpath.join(posixpath.dirname(owner), base_path))
            )
    return posixpath.normpath(posixpath.join(posixpath.dirname(effective_owner), path))


def html_base_href(text: str) -> str | None:
    parser = ReferenceParser()
    parser.feed(text)
    return parser.base_href


def common_root_prefix(names: list[str]) -> str | None:
    useful = [name.strip("/") for name in names if name.strip("/")]
    if not useful:
        return None
    first_parts = {name.split("/", 1)[0] for name in useful}
    if len(first_parts) != 1:
        return None
    first = next(iter(first_parts))
    nested = [name for name in useful if "/" in name]
    bare = [name for name in useful if "/" not in name]
    if not nested or any(name != first for name in bare):
        return None
    return first + "/"


def runtime_references(text: str, name: str) -> list[str]:
    suffix = PurePosixPath(name).suffix.casefold()
    if suffix in {".html", ".htm"}:
        parser = ReferenceParser()
        parser.feed(text)
        references = list(parser.references)
        for body in parser.inline_styles:
            references.extend(CSS_URL_RE.findall(body) + CSS_IMPORT_RE.findall(body))
        for body in INLINE_STYLE_RE.findall(text):
            references.extend(CSS_URL_RE.findall(body) + CSS_IMPORT_RE.findall(body))
        for body in INLINE_SCRIPT_RE.findall(text):
            references.extend(JS_REFERENCE_RE.findall(body))
        return references
    if suffix == ".css":
        return CSS_URL_RE.findall(text) + CSS_IMPORT_RE.findall(text)
    if suffix in {".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"}:
        return JS_REFERENCE_RE.findall(text)
    return []


def has_unresolved_dynamic_runtime_loading(text: str, name: str) -> bool:
    suffix = PurePosixPath(name).suffix.casefold()
    if suffix in {".html", ".htm"}:
        scripts = INLINE_SCRIPT_RE.findall(text)
    elif suffix in {".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"}:
        scripts = [text]
    else:
        return False
    return any(
        len(DYNAMIC_RUNTIME_LOADER_RE.findall(script))
        > len(STATIC_RUNTIME_LOADER_RE.findall(script))
        for script in scripts
    )


def audit_zip(
    source: Path,
    entry_limit: int = DEFAULT_ENTRY_LIMIT,
    extracted_limit: int = DEFAULT_EXTRACTED_LIMIT,
    manifest_limit: int = DEFAULT_MANIFEST_LIMIT,
) -> dict[str, object]:
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        names = [normalized_name(info.filename) for info in infos]
        files = [(info, name) for info, name in zip(infos, names) if not info.is_dir()]
        file_names = {name for _, name in files}
        info_by_name = {name: info for info, name in files}
        file_names_folded = Counter(name.casefold() for name in file_names)
        exact_counts = Counter(names)
        unsafe_paths = sorted({name for name in names if is_unsafe_path(name)})
        symlinks = sorted({
            name for info, name in zip(infos, names)
            if stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF)
        })
        duplicate_paths = sorted(name for name, count in exact_counts.items() if count > 1)
        case_collisions = sorted(name for name, count in file_names_folded.items() if count > 1)
        root_prefix = common_root_prefix(names)

        total_uncompressed = sum(info.file_size for info, _ in files)
        total_compressed = sum(info.compress_size for info, _ in files)
        max_ratio = max((info.file_size / max(1, info.compress_size) for info, _ in files), default=0.0)
        suspicious_compression_paths = sorted(
            name for info, name in files
            if info.file_size > 1024 * 1024
            and info.file_size / max(1, info.compress_size) > 1000
        )
        longest_path_bytes = max((len(name.encode("utf-8")) for name in names), default=0)
        manifest_estimate = sum(len(name.encode("utf-8")) * 2 + 160 for _, name in files)

        node_modules_entries = 0
        dev_entries = 0
        source_map_entries = 0
        for _, name in files:
            parts = {part.casefold() for part in PurePosixPath(name).parts}
            base = PurePosixPath(name).name.casefold()
            if "node_modules" in parts:
                node_modules_entries += 1
            elif parts & DEV_DIRS or base in DEV_FILES:
                dev_entries += 1
            if name.casefold().endswith(".map"):
                source_map_entries += 1

        entry_candidates = [
            name for _, name in files
            if PurePosixPath(name).suffix.casefold() in {".html", ".htm"}
        ]
        logical_entries = [
            (name, name[len(root_prefix):] if root_prefix and name.startswith(root_prefix) else name)
            for name in entry_candidates
        ]
        preferred_entry = next(
            (name for name, logical in logical_entries if logical.casefold() == "index.html"),
            None,
        )
        if preferred_entry is None:
            preferred_entry = next(
                (name for name, logical in logical_entries if logical.casefold() == "index.htm"),
                None,
            )
        if preferred_entry is None and entry_candidates:
            preferred_entry = entry_candidates[0]

        external_references = 0
        local_references = 0
        missing_local_references: set[str] = set()
        unscanned_runtime_paths: set[str] = set()
        if preferred_entry:
            pending = [preferred_entry]
            inspected: set[str] = set()
            while pending:
                owner = pending.pop()
                if owner in inspected:
                    continue
                inspected.add(owner)
                info = info_by_name.get(owner)
                if info is None:
                    continue
                suffix = PurePosixPath(owner).suffix.casefold()
                if suffix not in RUNTIME_TEXT_SUFFIXES:
                    continue
                if info.file_size > MAX_INSPECT_BYTES:
                    unscanned_runtime_paths.add(owner)
                    continue
                try:
                    text = archive.read(info).decode("utf-8")
                except UnicodeDecodeError:
                    unscanned_runtime_paths.add(owner)
                    continue
                if has_unresolved_dynamic_runtime_loading(text, owner):
                    unscanned_runtime_paths.add(owner)
                base_href = (
                    html_base_href(text)
                    if suffix in {".html", ".htm"}
                    else None
                )
                for reference in runtime_references(text, owner):
                    if is_external_reference(reference) or (
                        base_href and is_external_reference(base_href)
                    ):
                        external_references += 1
                        continue
                    resolved = resolve_local_reference(owner, reference, base_href)
                    if not resolved:
                        continue
                    local_references += 1
                    reference_path = unquote(urlsplit(reference).path)
                    base_path = unquote(urlsplit(base_href).path) if base_href else ""
                    packaged_path = (
                        root_prefix + resolved
                        if root_prefix and (
                            reference_path.startswith("/")
                            or (base_path.startswith("/") and not reference_path.startswith("/"))
                        )
                        else resolved
                    )
                    if packaged_path not in file_names:
                        missing_local_references.add(packaged_path)
                        continue
                    if packaged_path not in inspected:
                        pending.append(packaged_path)

        blockers: list[str] = []
        if unsafe_paths:
            blockers.append("包含不安全路径")
        if symlinks:
            blockers.append("包含符号链接")
        if duplicate_paths:
            blockers.append("包含重复路径")
        if case_collisions:
            blockers.append("包含大小写冲突路径")
        if not preferred_entry:
            blockers.append("缺少 HTML 入口文件")
        if missing_local_references:
            blockers.append("入口引用的本地资源缺失")
        if unscanned_runtime_paths:
            blockers.append("运行文本超过安全扫描上限")
        if suspicious_compression_paths:
            blockers.append("包含异常压缩比文件")
        if len(infos) > entry_limit:
            blockers.append(f"条目数超过 {entry_limit}")
        if total_uncompressed > extracted_limit:
            blockers.append("解压总量超过限制")
        if manifest_estimate > manifest_limit:
            blockers.append("网页托管清单估算超过安全余量")

        recommendations: list[str] = []
        if node_modules_entries:
            recommendations.append("先计算运行依赖闭包，再排除未被入口引用的 node_modules")
        if dev_entries:
            recommendations.append("审阅并排除不参与运行的测试、缓存、锁文件和开发配置")
        if source_map_entries:
            recommendations.append("确认生产包不需要源码映射，避免暴露源码并减少体积")
        if external_references:
            recommendations.append("评估把外部 CDN 依赖固定为本地 vendor 资源并保留许可证")
        if len(infos) > entry_limit:
            recommendations.append("生成新的单站点发布包，不要拆成多个无法互相引用的 ZIP")

        return {
            "source": str(source.resolve()),
            "sha256": sha256_file(source),
            "archiveBytes": source.stat().st_size,
            "entries": len(infos),
            "files": len(files),
            "directories": len(infos) - len(files),
            "rootPrefix": root_prefix,
            "preferredEntry": preferred_entry,
            "entryCandidates": entry_candidates,
            "nodeModulesEntries": node_modules_entries,
            "developmentEntries": dev_entries,
            "sourceMapEntries": source_map_entries,
            "uncompressedBytes": total_uncompressed,
            "compressedPayloadBytes": total_compressed,
            "maxCompressionRatio": round(max_ratio, 2),
            "suspiciousCompressionPaths": suspicious_compression_paths,
            "longestPathBytes": longest_path_bytes,
            "manifestEstimateBytes": manifest_estimate,
            "externalReferenceCount": external_references,
            "localReferenceCount": local_references,
            "missingLocalReferences": sorted(missing_local_references),
            "unscannedRuntimePaths": sorted(unscanned_runtime_paths),
            "unsafePaths": unsafe_paths,
            "symlinks": symlinks,
            "duplicatePaths": duplicate_paths,
            "caseCollisions": case_collisions,
            "blockers": blockers,
            "recommendations": recommendations,
            "optimizationRecommended": bool(recommendations),
            "strictReady": (
                not blockers
                and node_modules_entries == 0
                and dev_entries == 0
                and source_map_entries == 0
            ),
        }


def human_report(report: dict[str, object]) -> str:
    lines = [
        "原型发布包审计",
        f"源文件：{report['source']}",
        f"SHA-256：{report['sha256']}",
        f"条目：{report['entries']}（文件 {report['files']}，目录 {report['directories']}）",
        f"体积：压缩包 {report['archiveBytes']} 字节，解压后 {report['uncompressedBytes']} 字节",
        f"入口：{report['preferredEntry'] or '未找到'}",
        f"开发依赖：node_modules {report['nodeModulesEntries']} 项，其他开发项 {report['developmentEntries']} 项",
        f"引用：外部 {report['externalReferenceCount']} 项，本地缺失 {len(report['missingLocalReferences'])} 项",
        f"清单估算：{report['manifestEstimateBytes']} 字节",
        f"严格发布就绪：{'是' if report['strictReady'] else '否'}",
    ]
    blockers = report["blockers"]
    recommendations = report["recommendations"]
    if blockers:
        lines.append("阻断项：")
        lines.extend(f"- {item}" for item in blockers)
    if recommendations:
        lines.append("建议：")
        lines.extend(f"- {item}" for item in recommendations)
    return "\n".join(lines)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="只读审计产品原型 ZIP")
    parser.add_argument("input", type=Path, help="待审计 ZIP")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--strict", action="store_true", help="未达到发布包标准时返回非零")
    parser.add_argument("--entry-limit", type=int, default=DEFAULT_ENTRY_LIMIT)
    parser.add_argument("--extracted-limit", type=int, default=DEFAULT_EXTRACTED_LIMIT)
    parser.add_argument("--manifest-limit", type=int, default=DEFAULT_MANIFEST_LIMIT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if not args.input.is_file():
        print(f"输入文件不存在：{args.input}", file=sys.stderr)
        return 1
    try:
        report = audit_zip(args.input, args.entry_limit, args.extracted_limit, args.manifest_limit)
    except (OSError, zipfile.BadZipFile, KeyError) as error:
        print(f"无法审计 ZIP：{error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else human_report(report))
    if args.strict and not report["strictReady"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
