"""
Optional Claude Agent SDK adapter.

This module is intentionally isolated from ``agent_loop.py``. The legacy loop remains
the default fallback while MAP/CDS migrates toward the official SDK boundary.
"""
import logging
import os
import asyncio
from pathlib import Path
from typing import Any, AsyncIterator

from .schemas import SidecarEvent, SidecarRunRequest
from .tool_bridge import ToolBridge
from .profiles import resolve_profile

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


def _block_type(block: Any) -> str:
    value = getattr(block, "type", None)
    if isinstance(value, str):
        return value
    name = type(block).__name__
    if name.endswith("Block"):
        return name[:-5].lower()
    return name.lower()


def _block_text(block: Any) -> str:
    value = getattr(block, "text", None)
    if isinstance(value, str):
        return value
    if isinstance(block, dict):
        text = block.get("text")
        return text if isinstance(text, str) else ""
    return ""


def _block_tool_name(block: Any) -> str:
    value = getattr(block, "name", None)
    if isinstance(value, str):
        return value
    if isinstance(block, dict):
        name = block.get("name")
        return name if isinstance(name, str) else ""
    return ""


def _block_tool_id(block: Any) -> str:
    value = getattr(block, "id", None) or getattr(block, "tool_use_id", None)
    if isinstance(value, str):
        return value
    if isinstance(block, dict):
        for key in ("id", "tool_use_id", "toolUseId"):
            item = block.get(key)
            if isinstance(item, str):
                return item
    return ""


def _block_tool_input(block: Any) -> dict[str, Any]:
    value = getattr(block, "input", None) or getattr(block, "tool_input", None)
    if isinstance(value, dict):
        return value
    if isinstance(block, dict):
        for key in ("input", "tool_input", "toolInput"):
            item = block.get(key)
            if isinstance(item, dict):
                return item
    return {}


def _block_tool_result_content(block: Any) -> Any:
    for name in ("content", "result"):
        value = getattr(block, name, None)
        if value is not None:
            return value
    if isinstance(block, dict):
        return block.get("content") or block.get("result")
    return None


def _usage_value(usage: Any, name: str, fallback: int = 0) -> int:
    if usage is None:
        return fallback
    if isinstance(usage, dict):
        value = usage.get(name)
    else:
        value = getattr(usage, name, None)
    try:
        return int(value or fallback)
    except (TypeError, ValueError):
        return fallback


def _safe_result_metadata(message: Any) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    fields = (
        "subtype",
        "session_id",
        "sessionId",
        "model",
        "stop_reason",
        "stopReason",
        "total_cost_usd",
        "totalCostUsd",
        "duration_ms",
        "durationMs",
        "num_turns",
        "numTurns",
    )
    for name in fields:
        value = getattr(message, name, None)
        if isinstance(value, (str, int, float, bool)):
            metadata[name] = value
    return metadata


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
    cwd = os.environ.get("AGENT_WORKSPACE_ROOT", "").strip() or None
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

    env: dict[str, str] = {
        "API_TIMEOUT_MS": str(max(1, req.timeout_seconds) * 1000),
        "CLAUDE_CODE_MAX_RETRIES": os.environ.get("CLAUDE_CODE_MAX_RETRIES", "2"),
    }
    if upstream_key:
        env["ANTHROPIC_API_KEY"] = upstream_key
    if upstream_base:
        env["ANTHROPIC_BASE_URL"] = upstream_base

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
            "allowedTools": [*builtin_allowed, *map_tool_names],
            "permissionMode": permission_mode,
            "cwd": cwd,
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
            "baseUrlConfigured": bool(upstream_base),
            "apiKeyConfigured": bool(upstream_key or os.environ.get("ANTHROPIC_API_KEY", "").strip()),
            "protocol": req.protocol or "anthropic",
        },
    )

    final_text = ""
    total_in = 0
    total_out = 0
    cancelled = False
    result_metadata: dict[str, Any] = {}
    interrupt_task: asyncio.Task | None = None
    try:
        async with ClaudeSDKClient(options=options) as client:
            if cancel_event is not None:
                interrupt_task = asyncio.create_task(_interrupt_on_cancel(client, cancel_event))
            await client.query(_prompt_from_messages(req))

            async for message in client.receive_response():
                if cancel_event is not None and cancel_event.is_set():
                    cancelled = True

                if isinstance(message, ResultMessage):
                    result_metadata = _safe_result_metadata(message)
                    result = getattr(message, "result", None)
                    if isinstance(result, str) and result and not cancelled:
                        final_text = result
                    usage = getattr(message, "usage", None)
                    total_in = _usage_value(usage, "input_tokens", total_in)
                    total_out = _usage_value(usage, "output_tokens", total_out)
                    subtype = getattr(message, "subtype", None)
                    if cancelled or subtype == "error_during_execution":
                        cancelled = True
                    continue

                for block in getattr(message, "content", []) or []:
                    btype = _block_type(block)
                    if btype in ("text", "textblock"):
                        text = _block_text(block)
                        if text:
                            final_text += text
                            yield SidecarEvent(type="text_delta", text=text)
                    elif btype in ("tooluse", "tool_use", "tooluseblock"):
                        yield SidecarEvent(
                            type="tool_use",
                            tool_name=_block_tool_name(block),
                            tool_input=_block_tool_input(block),
                            tool_use_id=_block_tool_id(block),
                        )
                    elif btype in ("toolresult", "tool_result", "toolresultblock"):
                        yield SidecarEvent(
                            type="tool_result",
                            tool_use_id=_block_tool_id(block),
                            content=_block_tool_result_content(block),
                        )
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

    if total_in or total_out:
        yield SidecarEvent(
            type="usage",
            input_tokens=total_in,
            output_tokens=total_out,
            content={"sdkResult": result_metadata} if result_metadata else None,
        )
    if cancelled:
        yield SidecarEvent(type="error", error_code="cancelled", message="run cancelled")
        return
    yield SidecarEvent(
        type="done",
        final_text=final_text,
        input_tokens=total_in,
        output_tokens=total_out,
        content={"sdkResult": result_metadata} if result_metadata else None,
    )
