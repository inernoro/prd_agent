from dataclasses import dataclass, field
from typing import Any

from .schemas import SidecarEvent


@dataclass
class SdkEventAccumulator:
    final_text: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    result_error: str | None = None
    result_metadata: dict[str, Any] = field(default_factory=dict)


def handle_sdk_message(message: Any, result_message_type: type, state: SdkEventAccumulator, *, cancelled: bool) -> list[SidecarEvent]:
    if isinstance(message, result_message_type):
        state.result_metadata = safe_result_metadata(message)
        result = getattr(message, "result", None)
        if isinstance(result, str) and result and not cancelled:
            state.final_text = result
        usage = getattr(message, "usage", None)
        state.input_tokens = usage_value(usage, "input_tokens", state.input_tokens)
        state.output_tokens = usage_value(usage, "output_tokens", state.output_tokens)
        subtype = getattr(message, "subtype", None)
        if not cancelled and isinstance(subtype, str) and subtype.startswith("error"):
            state.result_error = subtype
        return []

    events: list[SidecarEvent] = []
    for block in getattr(message, "content", []) or []:
        btype = block_type(block)
        if btype in ("text", "textblock"):
            text = block_text(block)
            if text:
                state.final_text += text
                events.append(SidecarEvent(type="text_delta", text=text))
        elif btype in ("tooluse", "tool_use", "tooluseblock"):
            events.append(SidecarEvent(
                type="tool_use",
                tool_name=block_tool_name(block),
                tool_input=block_tool_input(block),
                tool_use_id=block_tool_id(block),
            ))
        elif btype in ("toolresult", "tool_result", "toolresultblock"):
            events.append(SidecarEvent(
                type="tool_result",
                tool_use_id=block_tool_id(block),
                content=block_tool_result_content(block),
            ))
    return events


def block_type(block: Any) -> str:
    value = getattr(block, "type", None)
    if isinstance(value, str):
        return value
    name = type(block).__name__
    if name.endswith("Block"):
        return name[:-5].lower()
    return name.lower()


def block_text(block: Any) -> str:
    value = getattr(block, "text", None)
    if isinstance(value, str):
        return value
    if isinstance(block, dict):
        text = block.get("text")
        return text if isinstance(text, str) else ""
    return ""


def block_tool_name(block: Any) -> str:
    value = getattr(block, "name", None)
    if isinstance(value, str):
        return value
    if isinstance(block, dict):
        name = block.get("name")
        return name if isinstance(name, str) else ""
    return ""


def block_tool_id(block: Any) -> str:
    value = getattr(block, "id", None) or getattr(block, "tool_use_id", None)
    if isinstance(value, str):
        return value
    if isinstance(block, dict):
        for key in ("id", "tool_use_id", "toolUseId"):
            item = block.get(key)
            if isinstance(item, str):
                return item
    return ""


def block_tool_input(block: Any) -> dict[str, Any]:
    value = getattr(block, "input", None) or getattr(block, "tool_input", None)
    if isinstance(value, dict):
        return value
    if isinstance(block, dict):
        for key in ("input", "tool_input", "toolInput"):
            item = block.get(key)
            if isinstance(item, dict):
                return item
    return {}


def block_tool_result_content(block: Any) -> Any:
    for name in ("content", "result"):
        value = getattr(block, name, None)
        if value is not None:
            return value
    if isinstance(block, dict):
        return block.get("content") or block.get("result")
    return None


def usage_value(usage: Any, name: str, fallback: int = 0) -> int:
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


def safe_result_metadata(message: Any) -> dict[str, Any]:
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
