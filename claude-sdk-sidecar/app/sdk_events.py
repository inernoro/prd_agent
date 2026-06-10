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
    # include_partial_messages 开启后收到过 token 级增量：完整消息里的 text/thinking
    # 块必须跳过（内容已逐 token 发过，再发一遍 = 正文双倍）
    partial_streaming: bool = False


def handle_sdk_message(message: Any, result_message_type: type, state: SdkEventAccumulator, *, cancelled: bool) -> list[SidecarEvent]:
    # StreamEvent（include_partial_messages=True 时 SDK 产生）：token 级增量。
    # 这是真流式的唯一来源——没有它，整条 assistant 消息要等全部生成完才一次性
    # 到达（2026-06-10 MD转PPT 实测：88s 生成的 deck 正文全部在结尾爆发，
    # 等待期的实况渲染/思考流全程无内容可画）。
    event_payload = getattr(message, "event", None)
    if isinstance(event_payload, dict) and not isinstance(message, result_message_type):
        if event_payload.get("type") == "content_block_delta":
            delta = event_payload.get("delta") or {}
            dtype = delta.get("type")
            if dtype == "text_delta":
                text = delta.get("text") or ""
                if text:
                    state.partial_streaming = True
                    state.final_text += text
                    return [SidecarEvent(type="text_delta", text=text)]
            elif dtype == "thinking_delta":
                thinking = delta.get("thinking") or ""
                if thinking:
                    state.partial_streaming = True
                    return [SidecarEvent(type="thinking", text=thinking)]
        return []

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
        if btype in ("thinking", "thinkingblock", "redacted_thinking", "reasoning", "reasoningblock"):
            # 推理模型的思考块。官方 SDK 会给出 thinking 内容；过去这里没映射，导致用户在
            # 推理期间(可能数十秒)看到空白("首字太慢/思考不显示")。透出为 thinking 事件。
            # token 级增量已经流过的内容不再整块重发。
            if state.partial_streaming:
                continue
            thinking = block_thinking(block)
            if thinking:
                events.append(SidecarEvent(type="thinking", text=thinking))
        elif btype in ("text", "textblock"):
            if state.partial_streaming:
                continue
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
    if isinstance(block, dict):
        value = block.get("type")
        return value.lower() if isinstance(value, str) else "dict"
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


def block_thinking(block: Any) -> str:
    # 思考块的内容在 .thinking（Anthropic thinking block）；redacted 的退回 .text。
    for attr in ("thinking", "text"):
        value = getattr(block, attr, None)
        if isinstance(value, str) and value:
            return value
    if isinstance(block, dict):
        for key in ("thinking", "text"):
            value = block.get(key)
            if isinstance(value, str) and value:
                return value
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
