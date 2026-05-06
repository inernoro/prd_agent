"""
Agent 多轮工具调用循环。每个 yield 一个 SidecarEvent，由 main.py 转成 SSE。

事件流（与 prd-api 端 ToolboxRunEventType 协议兼容）：
  text_delta   -> 流式文本增量
  tool_use     -> Claude 决定调用工具
  tool_result  -> 工具返回结果
  usage        -> token 用量（每轮一次）
  done         -> 终态，含最终文本
  error        -> 异常终态

上游切换（cc-switch / DeepSeek / Kimi / GLM / OpenRouter / 自建网关）：
  - 全局：ANTHROPIC_BASE_URL env 或 ANTHROPIC_API_KEY env
  - 命名 profile：通过 PROFILES_PATH yaml 文件登记，request 里写 profile 名
  - per-request 直接覆盖：request 里同时给 base_url + api_key
"""
import asyncio
import logging
import os
from typing import AsyncIterator

from anthropic import AsyncAnthropic, APIError

from .profiles import resolve_profile
from .schemas import SidecarEvent, SidecarRunRequest
from .tool_bridge import ToolBridge


logger = logging.getLogger("sidecar.loop")


def _build_client(api_key: str | None = None, base_url: str | None = None) -> AsyncAnthropic:
    final_key = (api_key or os.environ.get("ANTHROPIC_API_KEY", "")).strip()
    final_url = (base_url or os.environ.get("ANTHROPIC_BASE_URL", "")).strip() or None
    if not final_key:
        raise RuntimeError("ANTHROPIC_API_KEY env var is required (or per-request apiKey/profile)")
    return AsyncAnthropic(api_key=final_key, base_url=final_url)


def _resolve_upstream(req: SidecarRunRequest) -> tuple[str | None, str | None, str]:
    """返回 (base_url, api_key, source) — source 用于日志和事件标注上游来源。"""
    # 优先级 1: 命名 profile
    if req.profile:
        prof = resolve_profile(req.profile)
        if prof is None:
            raise RuntimeError(f"profile not found: {req.profile}")
        return prof.base_url, prof.api_key, f"profile:{req.profile}"

    # 优先级 2: per-request 直接覆盖
    if req.base_url or req.api_key:
        return req.base_url, req.api_key, "request-override"

    # 优先级 3: env 默认
    return None, None, "env-default"


async def run_agent(req: SidecarRunRequest) -> AsyncIterator[SidecarEvent]:
    try:
        upstream_base, upstream_key, source = _resolve_upstream(req)
    except RuntimeError as ex:
        yield SidecarEvent(type="error", error_code="upstream_resolve_failed", message=str(ex))
        return

    logger.info(
        "agent_loop start run=%s model=%s upstream=%s base=%s",
        req.run_id, req.model, source, upstream_base or "(default)",
    )

    client = _build_client(api_key=upstream_key, base_url=upstream_base)
    bridge = ToolBridge(
        callback_base_url=req.callback_base_url,
        agent_api_key=req.agent_api_key,
        run_id=req.run_id,
        app_caller_code=req.app_caller_code,
    )

    history: list[dict] = [m.model_dump() for m in req.messages]
    tools_payload = [
        {"name": t.name, "description": t.description, "input_schema": t.input_schema}
        for t in req.tools
    ]

    final_text = ""
    total_in = 0
    total_out = 0

    for turn in range(1, req.max_turns + 1):
        kwargs = {
            "model": req.model,
            "max_tokens": req.max_tokens,
            "system": req.system_prompt or "You are a helpful assistant.",
            "messages": history,
        }
        if tools_payload:
            kwargs["tools"] = tools_payload

        try:
            stream = client.messages.stream(**kwargs)
        except APIError as ex:
            yield SidecarEvent(type="error", error_code="anthropic_api_error", message=str(ex))
            return

        assistant_blocks: list[dict] = []
        current_text = ""
        current_tool_uses: list[dict] = []
        usage_in = 0
        usage_out = 0

        try:
            async with stream as s:
                async for event in s:
                    et = type(event).__name__
                    if et == "ContentBlockDeltaEvent":
                        delta = getattr(event, "delta", None)
                        if delta is not None and getattr(delta, "type", "") == "text_delta":
                            chunk = getattr(delta, "text", "") or ""
                            if chunk:
                                current_text += chunk
                                yield SidecarEvent(type="text_delta", text=chunk, turn=turn)
                    elif et == "MessageDeltaEvent":
                        usage = getattr(event, "usage", None)
                        if usage is not None:
                            usage_out = int(getattr(usage, "output_tokens", 0) or 0)

                final_msg = await s.get_final_message()
        except APIError as ex:
            yield SidecarEvent(type="error", error_code="anthropic_stream_error", message=str(ex))
            return
        except Exception as ex:
            logger.exception("stream consume error")
            yield SidecarEvent(type="error", error_code="sidecar_stream_error", message=str(ex))
            return

        if final_msg.usage:
            usage_in = int(getattr(final_msg.usage, "input_tokens", 0) or 0)
            usage_out = int(getattr(final_msg.usage, "output_tokens", 0) or usage_out)
        total_in += usage_in
        total_out += usage_out

        for block in final_msg.content:
            btype = getattr(block, "type", None)
            if btype == "text":
                assistant_blocks.append({"type": "text", "text": block.text})
            elif btype == "tool_use":
                tool_name = block.name
                tool_input = dict(block.input or {})
                tool_use_id = block.id
                current_tool_uses.append(
                    {"id": tool_use_id, "name": tool_name, "input": tool_input}
                )
                assistant_blocks.append(
                    {
                        "type": "tool_use",
                        "id": tool_use_id,
                        "name": tool_name,
                        "input": tool_input,
                    }
                )
                yield SidecarEvent(
                    type="tool_use",
                    tool_name=tool_name,
                    tool_input=tool_input,
                    tool_use_id=tool_use_id,
                    turn=turn,
                )

        yield SidecarEvent(
            type="usage", input_tokens=usage_in, output_tokens=usage_out, turn=turn
        )

        history.append({"role": "assistant", "content": assistant_blocks})

        if final_msg.stop_reason != "tool_use" or not current_tool_uses:
            final_text = current_text
            break

        tool_results: list[dict] = []
        for use in current_tool_uses:
            ok, content = await bridge.invoke(use["name"], use["input"])
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": use["id"],
                    "content": content,
                    "is_error": not ok,
                }
            )
            yield SidecarEvent(
                type="tool_result",
                tool_use_id=use["id"],
                tool_name=use["name"],
                content=content,
                turn=turn,
            )

        history.append({"role": "user", "content": tool_results})
        await asyncio.sleep(0)
    else:
        yield SidecarEvent(
            type="error",
            error_code="max_turns_exceeded",
            message=f"reached maxTurns={req.max_turns} without final text",
        )
        return

    yield SidecarEvent(
        type="done",
        final_text=final_text,
        input_tokens=total_in,
        output_tokens=total_out,
    )
