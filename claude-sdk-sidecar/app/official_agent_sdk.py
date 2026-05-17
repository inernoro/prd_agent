"""
Official Claude Agent SDK adapter.

This module is intentionally isolated from ``agent_loop.py``. The legacy loop is
kept only for explicit fallback while MAP/CDS keeps the default path on the
official SDK boundary.
"""
import logging
import os
import asyncio
from pathlib import Path
from typing import Any, AsyncIterator

from .schemas import SidecarEvent, SidecarRunRequest
from .tool_bridge import ToolBridge
from .profiles import resolve_profile
from .workspace import prepare_git_workspace, workspace_diagnostics, workspace_error_diagnostics
from .sdk_events import SdkEventAccumulator, handle_sdk_message

logger = logging.getLogger("sidecar.official_agent_sdk")


def _prompt_from_messages(req: SidecarRunRequest) -> str:
    parts: list[str] = []
    for msg in req.messages:
        role = (msg.role or "user").strip()
        content = (msg.content or "").strip()
        if not content:
            continue
        parts.append(f"{role}:\n{content}")
    return "\n\n".join(parts) or "Continue."


def _csv_env(name: str, default: str) -> list[str]:
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def _runtime_preflight(cwd: str | None) -> list[str]:
    missing: list[str] = []
    if cwd and not Path(cwd).exists():
        missing.append("workspace_root")
    return missing


def _resolve_upstream(req: SidecarRunRequest) -> tuple[str | None, str | None, str]:
    if req.profile:
        prof = resolve_profile(req.profile)
        if prof is None:
            raise RuntimeError(f"profile not found: {req.profile}")
        return prof.base_url, prof.api_key, f"profile:{req.profile}"

    if req.base_url or req.api_key:
        return req.base_url, req.api_key, "request-override"

    return None, None, "env-default"


async def _interrupt_on_cancel(client: Any, cancel_event: asyncio.Event) -> None:
    await cancel_event.wait()
    try:
        await client.interrupt()
    except Exception:
        logger.exception("official Claude Agent SDK interrupt failed")


async def run_official_agent(
    req: SidecarRunRequest,
    cancel_event: asyncio.Event | None = None,
) -> AsyncIterator[SidecarEvent]:
    try:
        from claude_agent_sdk import (  # type: ignore
            ClaudeSDKClient,
            ClaudeAgentOptions,
            PermissionResultAllow,
            PermissionResultDeny,
            ResultMessage,
            create_sdk_mcp_server,
            tool,
        )
    except Exception as ex:
        yield SidecarEvent(
            type="error",
            error_code="claude_agent_sdk_not_available",
            message=(
                "claude-agent-sdk is not installed or cannot be imported. "
                "Install the official SDK with `pip install claude-agent-sdk`. "
                f"import_error={ex}"
            ),
        )
        return

    bridge = ToolBridge(
        callback_base_url=req.callback_base_url,
        agent_api_key=req.agent_api_key,
        run_id=req.run_id,
        app_caller_code=req.app_caller_code,
        timeout_seconds=req.timeout_seconds,
    )

    sdk_tools = []
    for tool_def in req.tools:
        async def handler(args: dict[str, Any], tool_name: str = tool_def.name) -> dict[str, Any]:
            payload = dict(args or {})
            ok, content = await bridge.invoke(tool_name, payload)
            return {
                "content": [{"type": "text", "text": content}],
                "is_error": not ok,
            }

        sdk_tools.append(
            tool(tool_def.name, tool_def.description, tool_def.input_schema)(handler)
        )

    mcp_servers = {}
    map_tool_names: list[str] = []
    if sdk_tools:
        mcp_servers["map"] = create_sdk_mcp_server(
            name="map-agent-tools",
            version="1.0.0",
            tools=sdk_tools,
        )
        map_tool_names = [f"mcp__map__{tool_def.name}" for tool_def in req.tools]

    builtin_allowed = _csv_env(
        "CLAUDE_AGENT_SDK_ALLOWED_TOOLS",
        "Read,Grep,Glob",
    )
    unsafe_builtin_tools = sorted(
        {name for name in builtin_allowed if name.lower() in {"bash", "edit", "write"}}
    )
    permission_mode = os.environ.get("CLAUDE_AGENT_SDK_PERMISSION_MODE", "default")
    request_cwd = (req.workspace_root or "").strip() or None
    env_cwd = os.environ.get("AGENT_WORKSPACE_ROOT", "").strip() or None
    git_workspace_metadata: dict[str, Any] | None = None
    try:
        git_cwd, git_workspace_metadata = await prepare_git_workspace(req) if not request_cwd else (None, None)
    except Exception as ex:
        yield SidecarEvent(
            type="error",
            error_code="workspace_prepare_failed",
            message=str(ex),
            content={
                "adapter": "claude-agent-sdk",
                **workspace_error_diagnostics(ex, req),
            },
        )
        return
    cwd = request_cwd or git_cwd or env_cwd
    workspace_source = "request" if request_cwd else ("git" if git_cwd else ("env" if env_cwd else "unset"))
    missing_runtime = _runtime_preflight(cwd)
    if missing_runtime:
        yield SidecarEvent(
            type="error",
            error_code="claude_agent_sdk_runtime_not_ready",
            message=(
                "Official Claude Agent SDK runtime is not ready. "
                f"missing={','.join(missing_runtime)}"
            ),
            content={
                "adapter": "claude-agent-sdk",
                "missing": missing_runtime,
                "cwd": cwd,
            },
        )
        return

    try:
        upstream_base, upstream_key, upstream_source = _resolve_upstream(req)
    except RuntimeError as ex:
        yield SidecarEvent(
            type="error",
            error_code="upstream_resolve_failed",
            message=str(ex),
            content={
                "adapter": "claude-agent-sdk",
                "profile": req.profile,
            },
        )
        return

    env_base_url = os.environ.get("ANTHROPIC_BASE_URL", "").strip() or None
    effective_base_url = upstream_base or env_base_url
    env_api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or None
    effective_api_key = upstream_key or env_api_key
    if not effective_api_key:
        provider_key_mode = os.environ.get(
            "SIDECAR_PROVIDER_KEY_MODE",
            "runtime-profile-or-env",
        ).strip().lower()
        yield SidecarEvent(
            type="error",
            error_code="provider_key_missing",
            message=(
                "ANTHROPIC_API_KEY is required, or MAP must provide a runtime "
                "profile/request apiKey for the official Claude Agent SDK adapter."
            ),
            content={
                "adapter": "claude-agent-sdk",
                "upstreamSource": upstream_source,
                "baseUrlConfigured": bool(effective_base_url),
                "apiKeyConfigured": False,
                "providerKeyMode": provider_key_mode,
                "nextActions": [
                    "set ANTHROPIC_API_KEY on the sidecar environment for standalone use",
                    "select or create a MAP runtime profile with a valid provider apiKey",
                    "verify the CDS Agent session request includes the intended runtime profile",
                ],
            },
        )
        return

    env: dict[str, str] = {
        "API_TIMEOUT_MS": str(max(1, req.timeout_seconds) * 1000),
        "CLAUDE_CODE_MAX_RETRIES": os.environ.get("CLAUDE_CODE_MAX_RETRIES", "2"),
        "ANTHROPIC_API_KEY": effective_api_key,
    }
    if effective_base_url:
        env["ANTHROPIC_BASE_URL"] = effective_base_url

    async def can_use_tool(tool_name: str, tool_input: dict[str, Any], context: Any) -> Any:
        normalized = tool_name.strip()
        if normalized.lower() not in {"bash", "edit", "write"}:
            return PermissionResultAllow()

        approval_id = (
            getattr(context, "tool_use_id", None)
            or f"{normalized.lower()}-{req.run_id}"
        )
        description = (
            getattr(context, "description", None)
            or getattr(context, "title", None)
            or f"Claude Code built-in tool {normalized}"
        )
        requested, request_message = await bridge.request_permission(
            normalized,
            dict(tool_input or {}),
            approval_id,
            description,
        )
        if not requested:
            return PermissionResultDeny(
                message=f"MAP approval request failed: {request_message}",
                interrupt=False,
            )

        approved, approval_message = await bridge.wait_for_approval(normalized, approval_id)
        if approved:
            return PermissionResultAllow()
        return PermissionResultDeny(
            message=f"MAP approval denied: {approval_message}",
            interrupt=False,
        )

    options = ClaudeAgentOptions(
        tools={"type": "preset", "preset": "claude_code"},
        allowed_tools=[*builtin_allowed, *map_tool_names],
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": req.system_prompt or "",
        },
        mcp_servers=mcp_servers,
        strict_mcp_config=bool(mcp_servers),
        permission_mode=permission_mode,
        max_turns=req.max_turns,
        model=req.model,
        cwd=cwd,
        env=env,
        can_use_tool=can_use_tool,
        setting_sources=["project"],
    )

    yield SidecarEvent(
        type="runtime_init",
        message="claude-agent-sdk adapter started",
        content={
            "adapter": "claude-agent-sdk",
            "mapSessionId": req.map_session_id,
            "traceId": req.trace_id,
            "allowedTools": [*builtin_allowed, *map_tool_names],
            "permissionMode": permission_mode,
            "cwd": cwd,
            "workspaceSource": workspace_source,
            "gitRepository": req.git_repository,
            "gitRef": req.git_ref,
            "workspace": git_workspace_metadata,
            "client": "ClaudeSDKClient",
            "loopOwner": "claude-agent-sdk",
            "sdkLoopEnabled": True,
            "mapRole": "control-plane",
            "cdsRole": "sandbox-runtime",
            "interrupt": cancel_event is not None,
            "builtinWriteToolsEnabled": bool(unsafe_builtin_tools),
            "builtinWriteTools": unsafe_builtin_tools,
            "approvalBridge": "sdk-can-use-tool",
            "upstreamSource": upstream_source,
            "baseUrlConfigured": bool(effective_base_url),
            "apiKeyConfigured": True,
            "protocol": req.protocol or "anthropic",
        },
    )

    sdk_state = SdkEventAccumulator()
    cancelled = False
    interrupt_task: asyncio.Task | None = None
    try:
        async with ClaudeSDKClient(options=options) as client:
            if cancel_event is not None:
                interrupt_task = asyncio.create_task(_interrupt_on_cancel(client, cancel_event))
            await client.query(_prompt_from_messages(req))

            async for message in client.receive_response():
                if cancel_event is not None and cancel_event.is_set():
                    cancelled = True

                for event in handle_sdk_message(message, ResultMessage, sdk_state, cancelled=cancelled):
                    yield event
    except Exception as ex:
        logger.exception("official Claude Agent SDK adapter failed run_id=%s", req.run_id)
        yield SidecarEvent(
            type="error",
            error_code="claude_agent_sdk_error",
            message=str(ex),
        )
        return
    finally:
        if interrupt_task is not None:
            interrupt_task.cancel()

    if sdk_state.input_tokens or sdk_state.output_tokens:
        yield SidecarEvent(
            type="usage",
            input_tokens=sdk_state.input_tokens,
            output_tokens=sdk_state.output_tokens,
            content={"sdkResult": sdk_state.result_metadata} if sdk_state.result_metadata else None,
        )
    if cancelled:
        yield SidecarEvent(type="error", error_code="cancelled", message="run cancelled")
        return
    if sdk_state.result_error:
        yield SidecarEvent(
            type="error",
            error_code="claude_agent_sdk_result_error",
            message=sdk_state.result_error,
            content={"sdkResult": sdk_state.result_metadata} if sdk_state.result_metadata else None,
        )
        return
    yield SidecarEvent(
        type="done",
        final_text=sdk_state.final_text,
        input_tokens=sdk_state.input_tokens,
        output_tokens=sdk_state.output_tokens,
        content={"sdkResult": sdk_state.result_metadata} if sdk_state.result_metadata else None,
    )
