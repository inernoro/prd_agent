from dataclasses import dataclass
from typing import Any, Callable
import asyncio
import uuid

from .authorization import check_tool_path
from .schemas import SidecarRunRequest
from .tool_bridge import ToolBridge


@dataclass(frozen=True)
class SdkTooling:
    mcp_servers: dict[str, Any]
    map_tool_names: list[str]
    can_use_tool: Callable[[str, dict[str, Any], Any], Any]
    pre_tool_use: Callable[..., Any]


def build_sdk_tooling(req: SidecarRunRequest, bridge: ToolBridge, *,
    create_sdk_mcp_server: Callable[..., Any], sdk_tool: Callable[..., Any],
    permission_result_allow: type, permission_result_deny: type,
) -> SdkTooling:
    def live() -> bool:
        return (req._authorization is not None and req._authorization.live()
            and not (req._cancel_event and req._cancel_event.is_set()))

    sdk_tools = []
    for tool_def in req.tools:
        async def handler(args: dict[str, Any], tool_name: str = tool_def.name) -> dict[str, Any]:
            ok, content = (await bridge.invoke(tool_name, dict(args or {})) if live()
                else (False, "runtime authorization expired or cancelled"))
            return {"content": [{"type": "text", "text": content}], "is_error": not ok}
        sdk_tools.append(sdk_tool(tool_def.name, tool_def.description, tool_def.input_schema)(handler))
    mcp_servers = {}
    map_tool_names = [f"mcp__map__{t.name}" for t in req.tools]
    if sdk_tools:
        mcp_servers["map"] = create_sdk_mcp_server(name="map-agent-tools", version="1.0.0", tools=sdk_tools)

    async def can_use_tool(tool_name: str, tool_input: dict[str, Any], context: Any) -> Any:
        def deny(message: str) -> Any:
            return permission_result_deny(message=message, interrupt=False)
        if not live():
            return deny("runtime authorization expired or cancelled")
        if tool_name in map_tool_names:
            return permission_result_allow()  # Handler and callback enforce the same grant.
        if tool_name not in (req.builtin_tools or []):
            return deny("tool not authorized")
        try:
            check_tool_path(req.workspace_root, tool_name, tool_input)
        except (OSError, ValueError, RuntimeError) as ex:
            return deny(str(ex))
        if tool_name in {"Read", "Glob", "Grep"}:
            return permission_result_allow()
        approval_id = f"{req.run_id}:{uuid.uuid4().hex}"
        try:
            async with asyncio.timeout(min(req.timeout_seconds, 900)):
                requested, message = await bridge.request_permission(tool_name, dict(tool_input), approval_id,
                    f"Claude Code built-in tool {tool_name}")
                if not requested:
                    return deny(f"MAP approval request failed: {message}")
                approved, message = await bridge.wait_for_approval(tool_name, approval_id)
        except (TimeoutError, OSError):
            return deny("MAP approval timed out or unavailable")
        if not approved or not live():
            return deny(f"MAP approval denied: {message}")
        # Approval can take minutes: repeat containment checks immediately before release.
        try:
            check_tool_path(req.workspace_root, tool_name, tool_input)
        except (OSError, ValueError, RuntimeError) as ex:
            return deny(str(ex))
        return permission_result_allow()

    async def pre_tool_use(data: dict, tool_use_id: str | None, context: Any) -> dict:
        result = await can_use_tool(data.get("tool_name", ""), data.get("tool_input", {}), context)
        allowed = isinstance(result, permission_result_allow)
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": "allow" if allowed else "deny",
            "permissionDecisionReason": "runtime authorization" if allowed else getattr(result, "message", "denied")}}

    return SdkTooling(mcp_servers, map_tool_names, can_use_tool, pre_tool_use)
