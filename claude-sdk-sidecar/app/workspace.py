import asyncio
import hashlib
import os
import re
import shutil
from pathlib import Path
from typing import Any

from .schemas import SidecarRunRequest

_REPO_SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_GITHUB_URL_RE = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:\.git)?/?$")
_GIT_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
_WORKSPACE_LOCKS: dict[str, asyncio.Lock] = {}


def parse_github_repository(value: str | None) -> tuple[str, str] | None:
    raw = (value or "").strip()
    if not raw:
        return None
    if _REPO_SLUG_RE.match(raw):
        slug = raw
    else:
        match = _GITHUB_URL_RE.match(raw)
        if not match:
            raise ValueError("gitRepository must be owner/repo or https://github.com/owner/repo")
        slug = match.group(1)
    return slug, f"https://github.com/{slug}.git"


def normalize_git_ref(value: str | None) -> str | None:
    ref = (value or "").strip()
    if not ref:
        return None
    if not _GIT_REF_RE.match(ref) or ".." in ref or ref.endswith(".lock") or "/." in ref:
        raise ValueError("gitRef contains unsupported characters")
    return ref


def workspace_diagnostics() -> dict[str, Any]:
    root = Path(os.environ.get("SIDECAR_WORKSPACES_ROOT", "/tmp/cds-agent-workspaces")).expanduser()
    return {
        "autoGitWorkspace": True,
        "workspacesRoot": str(root),
        "workspacesRootExists": root.exists(),
        "gitInstalled": shutil.which("git") is not None,
        "supportedRepositoryHosts": ["github.com"],
        "supportedRepositoryFormats": ["owner/repo", "https://github.com/owner/repo"],
        "privateRepositoryAuthConfigured": github_token() is not None,
        "privateRepositoryAuthSources": ["SIDECAR_GITHUB_TOKEN", "GITHUB_TOKEN"],
        "workspaceLock": "in-process",
    }


def workspace_error_diagnostics(ex: Exception, req: SidecarRunRequest) -> dict[str, Any]:
    raw = str(ex)
    lower = raw.lower()
    auth_configured = github_token() is not None
    code = "workspace_prepare_failed"
    actions: list[str] = ["check sidecar logs for the failing git clone/fetch command"]

    if isinstance(ex, ValueError):
        if "gitrepository" in lower:
            code = "unsupported_git_repository"
            actions = ["set gitRepository to owner/repo or https://github.com/owner/repo"]
        elif "gitref" in lower:
            code = "unsupported_git_ref"
            actions = ["set gitRef to a branch, tag, or commit ref without shell/path traversal characters"]
    elif "repository not found" in lower or "authentication failed" in lower or "could not read username" in lower:
        code = "github_repository_auth_or_not_found"
        actions = [
            "verify gitRepository owner/repo and that the branch service can reach github.com",
            "set SIDECAR_GITHUB_TOKEN or GITHUB_TOKEN when the repository is private",
        ]
    elif "remote branch" in lower and "not found" in lower:
        code = "git_ref_not_found"
        actions = ["verify gitRef exists on the target repository"]
    elif "not a git repository" in lower:
        code = "workspace_target_conflict"
        actions = ["remove or change the existing workspace directory before retrying"]

    return {
        "workspaceErrorCode": code,
        "privateRepositoryAuthConfigured": auth_configured,
        "nextActions": actions,
        "gitRepository": req.git_repository,
        "gitRef": req.git_ref,
    }


async def prepare_git_workspace(req: SidecarRunRequest) -> tuple[str | None, dict[str, Any] | None]:
    parsed = parse_github_repository(req.git_repository)
    if parsed is None:
        return None, None

    repo_slug, clone_url = parsed
    git_ref = normalize_git_ref(req.git_ref)
    root = Path(os.environ.get("SIDECAR_WORKSPACES_ROOT", "/tmp/cds-agent-workspaces")).expanduser()
    target = root / workspace_slug(repo_slug, git_ref)
    git_env = git_auth_env()
    metadata: dict[str, Any] = {
        "workspacePrepared": True,
        "workspaceSource": "git",
        "gitRepository": repo_slug,
        "gitRef": git_ref,
        "workspaceRoot": str(target),
        "workspaceLock": "in-process",
        "privateRepositoryAuthConfigured": git_env is not None,
    }

    root.mkdir(parents=True, exist_ok=True)
    async with workspace_lock(target):
        if (target / ".git").exists():
            metadata["workspaceAction"] = "fetch"
            if git_ref:
                await run_git(["fetch", "--depth", "1", "origin", git_ref], cwd=target, env=git_env)
                await run_git(["checkout", "--force", "FETCH_HEAD"], cwd=target)
            else:
                await run_git(["fetch", "--all", "--prune"], cwd=target, env=git_env)
        else:
            metadata["workspaceAction"] = "clone"
            if target.exists() and any(target.iterdir()):
                raise RuntimeError(f"workspace target exists and is not a git repository: {target}")
            clone_args = ["clone", "--depth", "1"]
            if git_ref:
                clone_args.extend(["--branch", git_ref])
            clone_args.extend([clone_url, str(target)])
            await run_git(clone_args, env=git_env)

        commit = await run_git(["rev-parse", "--short", "HEAD"], cwd=target)
    metadata["gitCommit"] = commit
    return str(target), metadata


def workspace_slug(repo_slug: str, git_ref: str | None) -> str:
    digest = hashlib.sha1(f"{repo_slug}@{git_ref or ''}".encode("utf-8")).hexdigest()[:10]
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", f"{repo_slug}-{git_ref or 'default'}").strip("-")
    return f"{safe}-{digest}"


def github_token() -> str | None:
    for name in ("SIDECAR_GITHUB_TOKEN", "GITHUB_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def git_auth_env() -> dict[str, str] | None:
    token = github_token()
    if not token:
        return None

    env = os.environ.copy()
    try:
        config_count = int(env.get("GIT_CONFIG_COUNT", "0"))
    except ValueError:
        config_count = 0
    env["GIT_CONFIG_COUNT"] = str(config_count + 1)
    env[f"GIT_CONFIG_KEY_{config_count}"] = "http.https://github.com/.extraheader"
    env[f"GIT_CONFIG_VALUE_{config_count}"] = f"AUTHORIZATION: bearer {token}"
    return env


def workspace_lock(target: Path) -> asyncio.Lock:
    key = str(target)
    lock = _WORKSPACE_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _WORKSPACE_LOCKS[key] = lock
    return lock


async def run_git(args: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    out = stdout.decode("utf-8", errors="replace").strip()
    err = stderr.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0:
        detail = err or out or f"git exited with {proc.returncode}"
        raise RuntimeError(detail[-800:])
    return out
