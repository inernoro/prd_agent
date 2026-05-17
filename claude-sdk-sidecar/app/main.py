"""
Sidecar HTTP 入口。

- POST /v1/agent/run         SSE 流式，主服务（prd-api）发起
- POST /v1/agent/cancel/{id} 主服务请求中止某个 run
- GET  /healthz              存活探针
- GET  /readyz               就绪探针（含 Anthropic 凭据探测）

鉴权：所有 /v1/* 请求必须带 Authorization: Bearer <SIDECAR_TOKEN>，避免裸暴露。
本地开发可设 SIDECAR_TOKEN=dev-skip 让所有请求放行。
"""
import asyncio
import hmac
import importlib.metadata
import importlib.util
import json
import logging
import os
import shutil
import warnings
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic.warnings import UnsupportedFieldAttributeWarning

from .agent_loop import run_agent
from .official_agent_sdk import run_official_agent, workspace_diagnostics
from .schemas import SidecarEvent, SidecarRunRequest


warnings.filterwarnings(
    "ignore",
    message=r"The 'alias' attribute with value .* has no effect",
    category=UnsupportedFieldAttributeWarning,
)

logging.basicConfig(
    level=os.environ.get("SIDECAR_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("sidecar")

app = FastAPI(title="Claude Agent SDK Sidecar", version="0.1.0")

SIDECAR_TOKEN = os.environ.get("SIDECAR_TOKEN", "").strip()
SIDECAR_VERSION = os.environ.get("SIDECAR_VERSION", "0.1.0")
DEFAULT_AGENT_ADAPTER = os.environ.get("SIDECAR_AGENT_ADAPTER", "legacy-sidecar").strip()

_active_runs: dict[str, asyncio.Event] = {}


def _check_token(authorization: str | None) -> None:
    if not SIDECAR_TOKEN:
        raise HTTPException(status_code=500, detail="SIDECAR_TOKEN env not configured")
    if SIDECAR_TOKEN == "dev-skip":
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    presented = authorization[len("Bearer ") :].strip()
    # constant-time compare 防止 timing side-channel 让攻击者按字节猜出 token
    # （PR #529 Bugbot LOW）。compare_digest 要求两边等长，先用 utf-8 编码后比对。
    if not hmac.compare_digest(presented.encode("utf-8"), SIDECAR_TOKEN.encode("utf-8")):
        raise HTTPException(status_code=401, detail="invalid bearer token")


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": SIDECAR_VERSION})


@app.get("/readyz")
async def readyz() -> JSONResponse:
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    has_token = bool(SIDECAR_TOKEN)
    provider_key_mode = os.environ.get("SIDECAR_PROVIDER_KEY_MODE", "runtime-profile-or-env").strip().lower()
    provider_key_required = provider_key_mode in ("env", "environment", "env-required")
    ready = has_token and (has_key or not provider_key_required)
    adapter = DEFAULT_AGENT_ADAPTER or "legacy-sidecar"
    diagnostics = _adapter_diagnostics(adapter)
    if adapter.strip().lower() in ("official", "official-claude", "claude-agent-sdk", "agent-sdk"):
        ready = ready and bool(diagnostics.get("ready"))
    blockers = _readyz_blockers(
        has_key=has_key,
        has_token=has_token,
        provider_key_required=provider_key_required,
        diagnostics=diagnostics,
    )
    next_actions = _readyz_next_actions(
        blockers=blockers,
        provider_key_required=provider_key_required,
        diagnostics=diagnostics,
    )
    return JSONResponse(
        {
            "ready": ready,
            "anthropicKey": has_key,
            "providerKeyMode": provider_key_mode,
            "providerKeyRequiredForReady": provider_key_required,
            "sidecarToken": has_token,
            "activeRuns": len(_active_runs),
            "agentAdapter": adapter,
            "adapterDiagnostics": diagnostics,
            "blockers": blockers,
            "nextActions": next_actions,
        },
        status_code=200 if ready else 503,
    )


def _readyz_blockers(
    *,
    has_key: bool,
    has_token: bool,
    provider_key_required: bool,
    diagnostics: dict[str, object],
) -> list[str]:
    blockers: list[str] = []
    if not has_token:
        blockers.append("missing SIDECAR_TOKEN")
    if provider_key_required and not has_key:
        blockers.append("missing ANTHROPIC_API_KEY")

    missing = diagnostics.get("missing")
    if isinstance(missing, list):
        for item in missing:
            if isinstance(item, str) and item:
                blockers.append(f"missing {item}")

    return list(dict.fromkeys(blockers))


def _readyz_next_actions(
    *,
    blockers: list[str],
    provider_key_required: bool,
    diagnostics: dict[str, object],
) -> list[str]:
    actions: list[str] = []
    if not blockers:
        actions.append("ready: start or attach a MAP/CDS Agent run")
        return actions

    if "missing SIDECAR_TOKEN" in blockers:
        actions.append("set SIDECAR_TOKEN and restart the sidecar")
    if "missing ANTHROPIC_API_KEY" in blockers:
        actions.append("set ANTHROPIC_API_KEY or use SIDECAR_PROVIDER_KEY_MODE=runtime-profile-or-env when MAP provides provider keys per request")
    elif not provider_key_required:
        actions.append("provider key may be supplied by MAP runtime profile or per-request override")

    missing = diagnostics.get("missing")
    if isinstance(missing, list):
        if "claude_agent_sdk" in missing:
            actions.append("install the official SDK: pip install claude-agent-sdk")
        if "workspace_root" in missing:
            actions.append("set AGENT_WORKSPACE_ROOT to an existing readable workspace")

    return list(dict.fromkeys(actions))


def _adapter_diagnostics(adapter: str) -> dict[str, object]:
    normalized = (adapter or "legacy-sidecar").strip().lower()
    if normalized not in ("official", "official-claude", "claude-agent-sdk", "agent-sdk"):
        return {
            "adapter": "legacy-sidecar",
            "ready": True,
            "reason": "legacy-sidecar uses the anthropic Python SDK path",
            "loopOwner": "sidecar-legacy-loop",
            "sdkLoopEnabled": False,
            "mapRole": "control-plane",
            "cdsRole": "sandbox-runtime",
        }

    try:
        sdk_spec = importlib.util.find_spec("claude_agent_sdk")
    except ValueError:
        sdk_spec = None
    sdk_version = None
    if sdk_spec is not None:
        try:
            sdk_version = importlib.metadata.version("claude-agent-sdk")
        except importlib.metadata.PackageNotFoundError:
            sdk_version = "unknown"

    cli_path = shutil.which("claude")
    cwd = os.environ.get("AGENT_WORKSPACE_ROOT", "").strip()
    cwd_exists = bool(cwd) and Path(cwd).exists()
    allowed_tools = [
        item.strip()
        for item in os.environ.get("CLAUDE_AGENT_SDK_ALLOWED_TOOLS", "Read,Grep,Glob").split(",")
        if item.strip()
    ]
    write_tools = sorted({name for name in allowed_tools if name.lower() in {"bash", "edit", "write"}})
    permission_mode = os.environ.get("CLAUDE_AGENT_SDK_PERMISSION_MODE", "default")
    missing = []
    if sdk_spec is None:
        missing.append("claude_agent_sdk")
    if cwd and not cwd_exists:
        missing.append("workspace_root")

    return {
        "adapter": "claude-agent-sdk",
        "ready": len(missing) == 0,
        "missing": missing,
        "sdkInstalled": sdk_spec is not None,
        "sdkVersion": sdk_version,
        "claudeCliPath": cli_path,
        "claudeCliBundled": sdk_spec is not None,
        "workspaceRoot": cwd or None,
        "workspaceRootExists": cwd_exists if cwd else None,
        "providerKeyMode": os.environ.get("SIDECAR_PROVIDER_KEY_MODE", "runtime-profile-or-env").strip().lower(),
        "allowedTools": allowed_tools,
        "permissionMode": permission_mode,
        "builtinWriteToolsEnabled": bool(write_tools),
        "builtinWriteTools": write_tools,
        "approvalBridge": "sdk-can-use-tool",
        "workspacePreparation": workspace_diagnostics(),
        "loopOwner": "claude-agent-sdk",
        "sdkLoopEnabled": True,
        "mapRole": "control-plane",
        "cdsRole": "sandbox-runtime",
    }


def _adapter_for(req: SidecarRunRequest) -> str:
    value = (req.runtime_adapter or DEFAULT_AGENT_ADAPTER or "legacy-sidecar").strip().lower()
    if value in ("official", "official-claude", "claude-agent-sdk", "agent-sdk"):
        return "claude-agent-sdk"
    return "legacy-sidecar"


def _format_sse(event: SidecarEvent) -> bytes:
    payload = event.model_dump(exclude_none=True)
    line = f"event: {event.type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
    return line.encode("utf-8")


async def _run_stream(req: SidecarRunRequest, request: Request) -> AsyncIterator[bytes]:
    cancel_event = asyncio.Event()
    _active_runs[req.run_id] = cancel_event
    keepalive_task: asyncio.Task | None = None
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=64)

    async def keepalive() -> None:
        while not cancel_event.is_set():
            await asyncio.sleep(15)
            await queue.put(b": keepalive\n\n")

    async def producer() -> None:
        try:
            official_adapter = _adapter_for(req) == "claude-agent-sdk"
            stream = run_official_agent(req, cancel_event=cancel_event) if official_adapter else run_agent(req)
            async for ev in stream:
                if cancel_event.is_set() and not official_adapter:
                    await queue.put(_format_sse(SidecarEvent(
                        type="error", error_code="cancelled", message="run cancelled"
                    )))
                    return
                await queue.put(_format_sse(ev))
        except Exception as ex:
            logger.exception("agent loop crashed run_id=%s", req.run_id)
            await queue.put(_format_sse(SidecarEvent(
                type="error", error_code="sidecar_internal_error", message=str(ex)
            )))
        finally:
            await queue.put(None)

    keepalive_task = asyncio.create_task(keepalive())
    producer_task = asyncio.create_task(producer())

    try:
        while True:
            if await request.is_disconnected():
                cancel_event.set()
                break
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=20)
            except asyncio.TimeoutError:
                yield b": idle\n\n"
                continue
            if chunk is None:
                break
            yield chunk
    finally:
        cancel_event.set()
        for t in (keepalive_task, producer_task):
            if t and not t.done():
                t.cancel()
        _active_runs.pop(req.run_id, None)


@app.post("/v1/agent/run")
async def run(
    req: SidecarRunRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    _check_token(authorization)
    if req.run_id in _active_runs:
        raise HTTPException(status_code=409, detail=f"runId {req.run_id} already active")
    return StreamingResponse(
        _run_stream(req, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/agent/cancel/{run_id}")
async def cancel(run_id: str, authorization: str | None = Header(default=None)) -> JSONResponse:
    _check_token(authorization)
    ev = _active_runs.get(run_id)
    if ev is None:
        return JSONResponse({"cancelled": False, "reason": "not found"}, status_code=404)
    ev.set()
    return JSONResponse({"cancelled": True, "runId": run_id})
