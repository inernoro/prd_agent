"""Run authority comes only from the configured control plane, never from request URLs."""
import hashlib
import os
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

from .schemas import SidecarRunRequest


@dataclass(frozen=True)
class RunAuthorization:
    subject: str
    run_id: str
    expires_at: int
    credential_hash: str

    def live(self) -> bool:
        return time.time() < self.expires_at


def authority_url() -> str:
    url = os.environ.get("SIDECAR_AUTHORITY_URL", "").strip().rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc or parsed.username or parsed.query or parsed.fragment:
        raise HTTPException(503, "SIDECAR_AUTHORITY_URL not configured")
    return url


async def authorize(token: str | None, run_id: str, purpose: str) -> tuple[RunAuthorization, dict]:
    if not token or not token.startswith("Bearer map-task-v2."):
        raise HTTPException(401, "scoped runtime credential required")
    credential = token[7:]
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
            response = await client.post(authority_url() + "/api/agent-tools/authorize",
                headers={"X-Sidecar-Token": credential}, json={"runId": run_id, "purpose": purpose})
        if response.status_code != 200:
            raise HTTPException(403, "runtime authorization denied")
        data = response.json()
        if (data.get("runId") != run_id or data.get("purpose") != purpose
                or not data.get("subject") or type(data.get("expiresAt")) is not int
                or data["expiresAt"] <= time.time()):
            raise HTTPException(403, "invalid runtime authorization")
        return RunAuthorization(data["subject"], run_id, data["expiresAt"],
            hashlib.sha256(credential.encode()).hexdigest()), data
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "runtime authority unavailable") from None


def narrow_request(req: SidecarRunRequest, data: dict, credential: str) -> None:
    scope = data["runtime"]
    for field in ("workspaceRoot", "gitRepository", "gitRef", "profile", "baseUrl", "apiKey", "protocol", "runtimeAdapter", "model", "appCallerCode"):
        actual = req.model_dump(by_alias=True).get(field)
        if (actual or None) != (scope.get(field) or None):
            raise HTTPException(403, f"{field} outside runtime authorization")
    if req.callback_base_url and req.callback_base_url.rstrip("/") != authority_url():
        raise HTTPException(403, "callback authority cannot be selected by caller")
    if req.agent_api_key and req.agent_api_key != credential:
        raise HTTPException(403, "callback credential mismatch")
    authorized_tools = {t["name"]: t for t in scope.get("tools", [])}
    if any(t.name not in authorized_tools for t in req.tools):
        raise HTTPException(403, "tool outside runtime authorization")
    # The request selects names; definitions come from the authority.
    from .schemas import SidecarToolDef
    req.tools = [SidecarToolDef(name=t.name, description=authorized_tools[t.name]["description"],
        input_schema=authorized_tools[t.name]["inputSchema"]) for t in req.tools]
    server_builtin = set(scope.get("builtinTools") if scope.get("builtinTools") is not None else ["Read", "Grep", "Glob"])
    process_builtin = set(os.environ.get("CLAUDE_AGENT_SDK_ALLOWED_TOOLS", "Read,Grep,Glob").split(","))
    # A missing assignment never grants the process cwd or another tenant's default root.
    has_workspace = bool(req.workspace_root or req.git_repository)
    chosen = set(req.builtin_tools if req.builtin_tools is not None else (server_builtin if has_workspace else []))
    if chosen and not has_workspace:
        raise HTTPException(403, "builtin tools require an assigned workspace")
    if not chosen <= server_builtin or not chosen <= process_builtin:
        raise HTTPException(403, "builtin tool outside runtime authorization")
    req.builtin_tools = sorted(chosen)
    for field in ("timeout_seconds", "max_turns", "max_tokens"):
        key = {"timeout_seconds":"timeoutSeconds", "max_turns":"maxTurns", "max_tokens":"maxTokens"}[field]
        if not 0 < getattr(req, field) <= scope[key]:
            raise HTTPException(403, f"{key} outside runtime authorization")
    if req.workspace_root:
        base = Path(os.environ.get("AGENT_WORKSPACE_ROOT") or os.environ.get("SIDECAR_WORKSPACES_ROOT", "/tmp/cds-agent-workspaces")).resolve(strict=True)
        workspace = Path(req.workspace_root)
        if not workspace.is_absolute() or not workspace.resolve(strict=True).is_relative_to(base):
            raise HTTPException(403, "workspace outside deployment root")
        if any(path.is_symlink() for path in [workspace, *workspace.parents]):
            raise HTTPException(403, "workspace contains symbolic links")
    req.callback_base_url = authority_url()
    req.agent_api_key = credential


def check_tool_path(root: str | None, tool: str, args: dict) -> None:
    """Reject escaping paths and links, including links below recursive search roots."""
    if tool not in {"Read", "Grep", "Glob", "Edit", "Write"}:
        raise ValueError("unsupported built-in tool; isolated executor required")
    if not root:
        raise ValueError("workspace required")
    workspace = Path(root)
    if any(path.is_symlink() for path in [workspace, *workspace.parents]):
        raise ValueError("workspace contains symbolic links")
    base = workspace.resolve(strict=True)
    raw = args.get("file_path") if tool in {"Read", "Edit", "Write"} else args.get("path", ".")
    if not isinstance(raw, str) or not raw or ".." in Path(raw).parts:
        raise ValueError("invalid workspace path")
    candidate = Path(raw)
    candidate = candidate if candidate.is_absolute() else base / candidate
    resolved = candidate.resolve(strict=tool != "Write")
    if not resolved.is_relative_to(base):
        raise ValueError("path outside workspace")
    # Reject symlinks even when they currently point inside; do not follow mutable links.
    current = candidate
    while current != base:
        if current.is_symlink():
            raise ValueError("symbolic links are not allowed")
        if current.parent == current:
            raise ValueError("path outside workspace")
        current = current.parent
    if tool in {"Glob", "Grep"}:
        pattern = args.get("pattern", "") if tool == "Glob" else args.get("glob", "")
        if not isinstance(pattern, str) or Path(pattern).is_absolute() or ".." in Path(pattern).parts:
            raise ValueError("search pattern outside workspace")
        if resolved.is_dir():
            for directory, dirs, files in os.walk(resolved, followlinks=False):
                if any((Path(directory) / name).is_symlink() for name in dirs + files):
                    raise ValueError("search tree contains symbolic links")
