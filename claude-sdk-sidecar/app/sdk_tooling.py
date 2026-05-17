from dataclasses import dataclass
from typing import Any, Callable

from .schemas import SidecarRunRequest
from .tool_bridge import ToolBridge


@dataclass(frozen=True)
class SdkTooling:
    mcp_servers: dict[str, Any]
    map_tool_names: list[str]
    can_use_tool: Callable[[str, dict[str, Any], Any], Any]


def build_sdk_tooling(
    req: SidecarRunRequest,
    bridge: ToolBridge,
    *,
    create_sdk_mcp_server: Callable[..., Any],
    sdk_tool: Callable[..., Any],
    permission_result_allow: type,
    permission_result_deny: type,
) -> SdkTooling:
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
            sdk_tool(tool_def.name, tool_def.description, tool_def.input_schema)(handler)
        )

    mcp_servers: dict[str, Any] = {}
    map_tool_names: list[str] = []
    if sdk_tools:
        mcp_servers["map"] = create_sdk_mcp_server(
            name="map-agent-tools",
            version="1.0.0",
            tools=sdk_tools,
        )
        map_tool_names = [f"mcp__map__{tool_def.name}" for tool_def in req.tools]

    async def can_use_tool(tool_name: str, tool_input: dict[str, Any], context: Any) -> Any:
        normalized = tool_name.strip()
        if normalized.lower() not in {"bash", "edit", "write"}:
            return permission_result_allow()

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
            return permission_result_deny(
                message=f"MAP approval request failed: {request_message}",
                interrupt=False,
            )

        approved, approval_message = await bridge.wait_for_approval(normalized, approval_id)
        if approved:
            return permission_result_allow()
        return permission_result_deny(
            message=f"MAP approval denied: {approval_message}",
            interrupt=False,
        )

    return SdkTooling(
        mcp_servers=mcp_servers,
        map_tool_names=map_tool_names,
        can_use_tool=can_use_tool,
    )
