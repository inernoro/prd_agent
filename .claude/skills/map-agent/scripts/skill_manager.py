#!/usr/bin/env python3
"""Install/check/update the public MAP skill without credentials or local edits loss."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile


KEY = "map-agent"
STATE = ".map-agent-install.json"
HOSTS = (".claude", ".agents")
MAX_PACKAGE = 8 * 1024 * 1024
MAX_EXPANDED = 16 * 1024 * 1024


class InstallError(Exception):
    pass


def digest(content):
    return hashlib.sha256(content).hexdigest()


def origin(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.fragment:
        raise InstallError("下载地址不能包含凭据或片段")
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
    ):
        raise InstallError("下载地址必须使用 HTTPS；HTTP 仅允许本机测试")
    return parsed.scheme, parsed.hostname, parsed.port


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if origin(newurl) != origin(req.full_url):
            raise InstallError("技能下载发生跨站跳转，已停止")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, expected_origin, limit):
    if origin(url) != expected_origin:
        raise InstallError("技能包与清单必须来自同一个站点")
    request = urllib.request.Request(url, headers={
        "Accept": "application/json, application/zip",
        "User-Agent": "Mozilla/5.0 (compatible; MAPSkillManager/1.0)",
    })
    with urllib.request.build_opener(SameOriginRedirect()).open(request, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise InstallError("技能下载超过容量限制")
    return data


def safe_path(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise InstallError("技能包包含无效路径")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in (".", "..") for part in value.split("/")):
        raise InstallError("技能包包含越界路径")
    if ":" in value or value != path.as_posix() or value == STATE:
        raise InstallError("技能包包含不受支持的路径")
    return value


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise InstallError("技能版本必须使用 major.minor.patch 格式")
    return tuple(int(part) for part in value.split("."))


def read_manifest(url):
    base = origin(url)
    envelope = json.loads(fetch(url, base, 1024 * 1024))
    manifest = envelope.get("data") if envelope.get("success") else None
    if not isinstance(manifest, dict) or manifest.get("key") != KEY:
        raise InstallError("没有取得有效的 MAP 技能清单")
    version_tuple(manifest.get("version"))
    if not valid_hash(manifest.get("sha256")):
        raise InstallError("技能包摘要无效")
    files = {}
    for item in manifest.get("files", []):
        path = safe_path(item.get("path"))
        if path in files or not valid_hash(item.get("sha256")):
            raise InstallError("技能文件清单重复或摘要无效")
        files[path] = item["sha256"]
    if "SKILL.md" not in files or "scripts/skill_manager.py" not in files:
        raise InstallError("技能包缺少入口或更新器")
    manifest["fileHashes"] = files
    manifest["manifestUrl"] = url
    if origin(manifest.get("downloadUrl", "")) != base:
        raise InstallError("技能下载地址与清单来源不同")
    return manifest


def destinations(project, client=None):
    if not project.is_dir():
        raise InstallError("项目目录不存在")
    selected = [project / host / "skills" / KEY for host in HOSTS if (project / host).is_dir()]
    requested_host = {"codex": ".agents", "claude": ".claude"}.get(client)
    if requested_host:
        requested = project / requested_host / "skills" / KEY
        if requested not in selected:
            selected.append(requested)
    selected = selected or [project / ".agents" / "skills" / KEY]
    for target in selected:
        if not target.resolve().is_relative_to(project):
            raise InstallError("技能目录指向项目外，已停止安装")
        if any(part.is_symlink() for part in (target, target.parent, target.parent.parent)):
            raise InstallError("技能目录包含符号链接，已停止安装")
    return selected


def read_state(target):
    path = target / STATE
    if not path.is_file() or path.is_symlink():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("key") != KEY or not isinstance(data.get("files"), dict):
            return None
        version_tuple(data.get("version"))
        for name, sha in data["files"].items():
            safe_path(name)
            if not valid_hash(sha):
                return None
        return data
    except (ValueError, OSError, InstallError):
        return None


def local_changes(target, state):
    if not target.exists():
        return []
    if not state:
        return ["未受安装器管理的同名目录"]
    actual = {}
    for path in target.rglob("*"):
        name = path.relative_to(target).as_posix()
        if path.is_symlink():
            actual[name] = "symlink"
        elif path.is_file() and name != STATE:
            actual[name] = digest(path.read_bytes())
    return sorted(name for name in set(actual) | set(state["files"])
                  if actual.get(name) != state["files"].get(name))


def inspect(target, manifest):
    state = read_state(target)
    changes = local_changes(target, state)
    status = "not-installed" if not target.exists() else "unmanaged" if state is None else (
        "local-modifications" if changes else "current" if (
            state.get("version") == manifest["version"] and state["files"] == manifest["fileHashes"]
        )
        else "update-available"
    )
    return {"path": str(target), "installedVersion": state.get("version") if state else None,
            "latestVersion": manifest["version"], "status": status, "localChanges": changes}


def unpack(manifest):
    data = fetch(manifest["downloadUrl"], origin(manifest["manifestUrl"]), MAX_PACKAGE)
    if digest(data) != manifest["sha256"]:
        raise InstallError("技能包校验失败，未修改已安装文件；请重新检查版本后重试")
    files = {}
    total = 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for item in archive.infolist():
            if item.is_dir():
                continue
            prefix = KEY + "/"
            if not item.filename.startswith(prefix) or ((item.external_attr >> 16) & 0o170000) == 0o120000:
                raise InstallError("技能包包含越界或符号链接文件")
            name = safe_path(item.filename[len(prefix):])
            if name in files or name not in manifest["fileHashes"]:
                raise InstallError("技能包包含清单以外或重复的文件")
            total += item.file_size
            if total > MAX_EXPANDED:
                raise InstallError("技能包解压后超过容量限制")
            content = archive.read(item)
            if digest(content) != manifest["fileHashes"][name]:
                raise InstallError("技能文件校验失败，未修改已安装文件")
            files[name] = content
    if set(files) != set(manifest["fileHashes"]):
        raise InstallError("技能包缺少清单中的文件")
    return files


def replace_all(targets, manifest, files, expected_states):
    prepared = []
    completed = []
    succeeded = False
    state = {"key": KEY, "version": manifest["version"], "sha256": manifest["sha256"],
             "manifestUrl": manifest["manifestUrl"], "files": manifest["fileHashes"]}
    try:
        for target in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            stage = Path(tempfile.mkdtemp(prefix=".map-agent-stage-", dir=target.parent))
            backup = stage.with_name(stage.name + "-previous")
            prepared.append((target, stage, backup))
            for name, content in files.items():
                path = stage / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            (stage / STATE).write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # 下载期间编辑器仍可能修改技能；替换前再核对，不能用下载前的检查覆盖新改动。
        for target in targets:
            current_state = read_state(target)
            if current_state != expected_states[str(target)] or local_changes(target, current_state):
                raise InstallError("下载期间本地技能发生变化，已保留全部文件；请重新检查后更新")
        for target, stage, backup in prepared:
            existed = target.exists()
            if existed:
                os.replace(target, backup)
            completed.append((target, backup, existed))
            os.replace(stage, target)
        succeeded = True
    except BaseException:
        for target, backup, existed in reversed(completed):
            if target.exists():
                shutil.rmtree(target)
            if existed and backup.exists():
                os.replace(backup, target)
        raise
    finally:
        for _, stage, backup in prepared:
            if stage.exists():
                shutil.rmtree(stage)
            if succeeded and backup.exists():
                shutil.rmtree(backup)


def run(command, project, manifest_url=None, client=None):
    project = Path(project).expanduser().resolve()
    targets = destinations(project, client)
    if not manifest_url:
        sources = {state["manifestUrl"] for target in targets if (state := read_state(target))
                   and state.get("manifestUrl")}
        if len(sources) != 1:
            raise InstallError("请使用接入台提供的 --manifest-url；项目尚未安装或来源不一致")
        manifest_url = sources.pop()
    manifest = read_manifest(manifest_url)
    statuses = [inspect(target, manifest) for target in targets]
    if command == "check":
        return {"key": KEY, "version": manifest["version"], "action": command, "installations": statuses}
    for target, status in zip(targets, statuses):
        if status["localChanges"]:
            raise InstallError("本地技能有修改或同名目录，已保留全部文件；请先备份并处理后再更新：" + str(target))
        if status["installedVersion"] and version_tuple(status["installedVersion"]) > version_tuple(manifest["version"]):
            raise InstallError("线上版本较旧，已阻止降级")
        if status["installedVersion"] == manifest["version"] and status["status"] == "update-available":
            raise InstallError("同一版本的内容摘要变化，已停止更新；请发布新的版本号")
    pending = [target for target, status in zip(targets, statuses) if status["status"] != "current"]
    if pending:
        expected_states = {str(target): read_state(target) for target in pending}
        replace_all(pending, manifest, unpack(manifest), expected_states)
    return {"key": KEY, "version": manifest["version"], "action": command,
            "changed": bool(pending), "installations": [inspect(target, manifest) for target in targets],
            "nextStep": "请重载宿主技能或新开对话，再实际调用一次 MAP 工具；WorkBuddy 需导入技能 ZIP"}


def main():
    parser = argparse.ArgumentParser(description="MAP 项目技能安装、检查与安全更新；公开下载无需密钥")
    parser.add_argument("command", choices=("install", "check", "update"))
    parser.add_argument("--manifest-url")
    parser.add_argument("--project", default=".")
    parser.add_argument("--client", choices=("codex", "claude"), help="确保所选客户端的项目宿主目录存在，同时维护已有宿主")
    args = parser.parse_args()
    try:
        result = run(args.command, args.project, args.manifest_url, args.client)
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False, indent=2))
        return 0
    except (InstallError, OSError, ValueError, zipfile.BadZipFile) as error:
        # 网络异常字符串可能带完整 URL；只输出不含凭据的恢复说明。
        message = str(error) if isinstance(error, InstallError) else "无法完成技能操作；请检查网络、清单和项目目录权限后重试"
        print(json.dumps({"success": False, "error": {"message": message}}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
