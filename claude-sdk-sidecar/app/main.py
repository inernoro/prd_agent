"""
Sidecar HTTP 入口。

- POST /v1/agent/run         SSE 流式，主服务（prd-api）发起
- POST /v1/agent/cancel/{id} 主服务请求中止某个 run
- GET  /healthz              存活探针
- GET  /readyz               就绪探针（含 Anthropic 凭据探测）

鉴权：所有 /v1/* 请求必须带短期任务凭据，由固定的 SIDECAR_AUTHORITY_URL 核验。
"""
import asyncio
import importlib
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

from .official_agent_sdk import run_official_agent, workspace_diagnostics
from .authorization import authorize, narrow_request, authority_url
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
DEFAULT_AGENT_ADAPTER = os.environ.get("SIDECAR_AGENT_ADAPTER", "claude-agent-sdk").strip()
OFFICIAL_AGENT_ADAPTER_ALIASES = {"official", "official-claude", "claude-agent-sdk", "agent-sdk"}
LEGACY_AGENT_ADAPTER_ALIASES = {"legacy", "legacy-sidecar"}

_active_runs: dict[str, tuple[object, asyncio.Event]] = {}
_used_runs: dict[str, int] = {}


def _legacy_agent_stream(req: SidecarRunRequest) -> AsyncIterator[SidecarEvent]:
    module = importlib.import_module(".agent_loop", package=__package__)
    return module.run_agent(req)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": SIDECAR_VERSION})


@app.get("/readyz")
async def readyz() -> JSONResponse:
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    try:
        authority_url()
        has_token = True
    except HTTPException:
        has_token = False
    provider_key_mode = os.environ.get("SIDECAR_PROVIDER_KEY_MODE", "runtime-profile-or-env").strip().lower()
    provider_key_required = provider_key_mode in ("env", "environment", "env-required")
    ready = has_token and (has_key or not provider_key_required)
    adapter = DEFAULT_AGENT_ADAPTER or "claude-agent-sdk"
    diagnostics = _adapter_diagnostics(adapter)
    if adapter.strip().lower() in OFFICIAL_AGENT_ADAPTER_ALIASES:
        ready = ready and bool(diagnostics.get("ready"))
    else:
        ready = ready and bool(diagnostics.get("ready", True))
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
            "sidecarToken": False,
            "runtimeAuthorityConfigured": has_token,
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
        blockers.append("missing SIDECAR_AUTHORITY_URL")
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

    if "missing SIDECAR_AUTHORITY_URL" in blockers:
        actions.append("set SIDECAR_AUTHORITY_URL to the trusted MAP control plane and restart the sidecar")
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
        if "unsupported_runtime_adapter" in missing:
            actions.append("set runtimeAdapter=claude-agent-sdk, or explicitly set runtimeAdapter=legacy-sidecar only for legacy fallback")

    return list(dict.fromkeys(actions))


def _adapter_diagnostics(adapter: str) -> dict[str, object]:
    requested = (adapter or "claude-agent-sdk").strip()
    normalized = requested.lower()
    if normalized in LEGACY_AGENT_ADAPTER_ALIASES:
        return {
            "adapter": "legacy-sidecar",
            "ready": True,
            "reason": "legacy-sidecar uses the anthropic Python SDK path",
            "loopOwner": "sidecar-legacy-loop",
            "sdkLoopEnabled": False,
            "legacyLoopImport": "lazy-explicit-fallback",
            "mapRole": "control-plane",
            "cdsRole": "sandbox-runtime",
        }
    if normalized not in OFFICIAL_AGENT_ADAPTER_ALIASES:
        return {
            "adapter": requested,
            "ready": False,
            "missing": ["unsupported_runtime_adapter"],
            "reason": "unsupported runtimeAdapter; legacy fallback requires an explicit legacy-sidecar adapter value",
            "loopOwner": "unsupported",
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
    permission_mode = "default"
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
        "legacyLoopImport": "lazy-explicit-fallback",
        "mapRole": "control-plane",
        "cdsRole": "sandbox-runtime",
    }


def _adapter_for(req: SidecarRunRequest) -> str:
    requested = req.runtime_adapter or DEFAULT_AGENT_ADAPTER or "claude-agent-sdk"
    value = requested.strip().lower()
    if value in OFFICIAL_AGENT_ADAPTER_ALIASES:
        return "claude-agent-sdk"
    if value in LEGACY_AGENT_ADAPTER_ALIASES:
        return "legacy-sidecar"
    raise ValueError(f"unsupported runtimeAdapter: {requested}")


def _format_sse(event: SidecarEvent) -> bytes:
    payload = event.model_dump(exclude_none=True)
    line = f"event: {event.type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
    return line.encode("utf-8")


def _legacy_runtime_init_event(req: SidecarRunRequest) -> SidecarEvent:
    return SidecarEvent(
        type="runtime_init",
        message="legacy sidecar loop started",
        content={
            "adapter": "legacy-sidecar",
            "runtimeAdapter": "legacy-sidecar",
            "mapSessionId": req.map_session_id,
            "traceId": req.trace_id,
            "client": "AsyncAnthropic",
            "loopOwner": "sidecar-legacy-loop",
            "sdkLoopEnabled": False,
            "mapRole": "control-plane",
            "cdsRole": "sandbox-runtime",
            "fallback": "explicit",
        },
    )


async def _run_stream(req: SidecarRunRequest, request: Request) -> AsyncIterator[bytes]:
    cancel_event = req._cancel_event
    keepalive_task: asyncio.Task | None = None
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=64)
    settling = asyncio.Event()
    stream_closed = asyncio.Event()

    async def keepalive() -> None:
        while not cancel_event.is_set():
            await asyncio.sleep(15)
            await queue.put(b": keepalive\n\n")

    async def expire() -> None:
        import time
        await asyncio.sleep(max(0, min(req.timeout_seconds, req._authorization.expires_at - time.time())))
        cancel_event.set()

    expiry_task = asyncio.create_task(expire())

    async def control(operation: str) -> str:
        _, state = await authorize("Bearer " + req.agent_api_key, req.run_id, operation)
        value = state.get("state")
        if value not in {"running", "cancel_requested", "cancelled", "completed", "failed", "expired"}:
            raise HTTPException(503, "invalid run state")
        return value

    async def watch() -> None:
        try:
            while not cancel_event.is_set():
                if await control("status") != "running":
                    cancel_event.set()
                    break
                await asyncio.sleep(0.5)
        except Exception:
            cancel_event.set()  # Loss of authority never grants continued execution.
        finally:
            if cancel_event.is_set() and not settling.is_set() and not producer_task.done():
                producer_task.cancel()


    async def producer() -> None:
        stream = None
        terminal = SidecarEvent(type="error", error_code="runtime_incomplete", message="run did not complete")
        try:
            if await control("status") != "running":
                cancel_event.set()
                return
            try:
                selected_adapter = _adapter_for(req)
            except ValueError as ex:
                terminal = SidecarEvent(
                    type="error",
                    error_code="unsupported_runtime_adapter",
                    message=str(ex),
                    content={
                        "runtimeAdapter": req.runtime_adapter,
                        "defaultAdapter": DEFAULT_AGENT_ADAPTER,
                        "allowedRuntimeAdapters": sorted(OFFICIAL_AGENT_ADAPTER_ALIASES | LEGACY_AGENT_ADAPTER_ALIASES),
                        "nextActions": [
                            "Use runtimeAdapter=claude-agent-sdk for the default official SDK path.",
                            "Use runtimeAdapter=legacy-sidecar only for explicit legacy fallback."
                        ],
                    },
                )
                return
            official_adapter = selected_adapter == "claude-agent-sdk"
            stream = run_official_agent(req, cancel_event=cancel_event) if official_adapter else _legacy_agent_stream(req)
            if not official_adapter:
                await queue.put(_format_sse(_legacy_runtime_init_event(req)))
            async for ev in stream:
                if cancel_event.is_set() and not official_adapter:
                    terminal = SidecarEvent(type="error", error_code="cancelled", message="run cancelled")
                    return
                if ev.type in {"done", "error"}:
                    terminal = ev
                    break
                await queue.put(_format_sse(ev))
        except asyncio.CancelledError:
            terminal = SidecarEvent(type="error", error_code="cancelled", message="run stopped")
        except Exception as ex:
            logger.exception("agent loop crashed run_id=%s", req.run_id)
            terminal = SidecarEvent(type="error", error_code="sidecar_internal_error", message="run failed")
        finally:
            settling.set()
            try:
                if stream is not None:
                    await asyncio.wait_for(stream.aclose(), timeout=5)
                state = await control("complete" if terminal.type == "done" and not cancel_event.is_set() else "fail")
                if state != "completed":
                    terminal = SidecarEvent(type="error", error_code=state, message="run stopped")
            except Exception:
                terminal = SidecarEvent(type="error", error_code="run_state_unconfirmed", message="run stopped; terminal state not confirmed")
            if not stream_closed.is_set():
                await queue.put(_format_sse(terminal))
                await queue.put(None)

    keepalive_task = asyncio.create_task(keepalive())
    producer_task = asyncio.create_task(producer())
    watcher_task = asyncio.create_task(watch())

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
        stream_closed.set()
        cancel_event.set()
        for t in (keepalive_task, producer_task, expiry_task, watcher_task):
            if t and not t.done():
                t.cancel()
        await asyncio.gather(keepalive_task, producer_task, expiry_task, watcher_task, return_exceptions=True)
        _active_runs.pop(req.run_id, None)


@app.post("/v1/agent/run")
async def run(
    req: SidecarRunRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    auth, scope = await authorize(authorization, req.run_id, "run")
    narrow_request(req, scope, authorization[7:])
    import time
    for key, expires in list(_used_runs.items()):
        if expires <= time.time() and key not in _active_runs:
            del _used_runs[key]
    if req.run_id in _used_runs or req.run_id in _active_runs:
        raise HTTPException(status_code=409, detail=f"runId {req.run_id} already active")
    # Reserve before returning the lazy stream: no await between check and insert.
    req._authorization = auth
    req._cancel_event = asyncio.Event()
    _active_runs[req.run_id] = (auth, req._cancel_event)
    _used_runs[req.run_id] = auth.expires_at
    return StreamingResponse(
        _run_stream(req, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/agent/cancel/{run_id}")
async def cancel(run_id: str, authorization: str | None = Header(default=None)) -> JSONResponse:
    auth, state = await authorize(authorization, run_id, "cancel")
    active = _active_runs.get(run_id)
    if active is not None:
        owner, ev = active
        if owner.subject != auth.subject or owner.credential_hash != auth.credential_hash:
            raise HTTPException(403, "run belongs to another credential")
        if state.get("state") in {"cancel_requested", "cancelled"}:
            ev.set()
    value = state.get("state")
    return JSONResponse({"cancelled": value == "cancelled", "accepted": value in {"cancel_requested", "cancelled"},
        "state": value, "runId": run_id}, status_code=202 if value == "cancel_requested" else 200)
