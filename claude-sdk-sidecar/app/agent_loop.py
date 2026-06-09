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
import json
import logging
import os
from typing import AsyncIterator

import httpx
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


def _normalize_protocol(protocol: str | None) -> str:
    value = (protocol or "anthropic").strip().lower()
    if value in ("openai", "openai-compatible", "openai_compatible"):
        return "openai-compatible"
    return "anthropic"


def _combine_endpoint(base_url: str, endpoint: str) -> str:
    root = base_url.rstrip("/")
    if root.lower().endswith("/v1") and endpoint.startswith("/v1/"):
        return root + endpoint[3:]
    return root + endpoint


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
        "agent_loop start run=%s model=%s upstream=%s base=%s protocol=%s",
        req.run_id, req.model, source, upstream_base or "(default)", _normalize_protocol(req.protocol),
    )

    if _normalize_protocol(req.protocol) == "openai-compatible":
        async for event in _run_openai_compatible(req, upstream_base, upstream_key):
            yield event
        return

    client = _build_client(api_key=upstream_key, base_url=upstream_base)
    # AsyncAnthropic 内部持有 httpx.AsyncClient 连接池，若不显式 close()，每次
    # run_agent 调用都会泄一份 fd / connection（GC 不能 await）。把整段循环包到
    # try/finally，覆盖所有 yield/return 退出路径 —— 包括 async generator 被
    # 调用方 aclose() 提前关闭的场景。（PR #529 Bugbot MEDIUM）
    try:
        bridge = ToolBridge(
            callback_base_url=req.callback_base_url,
            agent_api_key=req.agent_api_key,
            run_id=req.run_id,
            app_caller_code=req.app_caller_code,
            timeout_seconds=req.timeout_seconds,
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
                        # 文本增量：anthropic SDK 暴露两种等价事件，都识别一下：
                        #   - RawContentBlockDeltaEvent.delta.text （type=='text_delta' 时）
                        #   - TextEvent.text （SDK 累积版，更友好）
                        if et == "RawContentBlockDeltaEvent":
                            delta = getattr(event, "delta", None)
                            dtype = getattr(delta, "type", "") if delta is not None else ""
                            if dtype == "text_delta":
                                chunk = getattr(delta, "text", "") or ""
                                if chunk:
                                    current_text += chunk
                                    yield SidecarEvent(type="text_delta", text=chunk, turn=turn)
                            elif dtype == "thinking_delta":
                                # 推理模型（extended thinking / anthropic-compatible 上游）
                                # 的思考增量。透传给上层，UI 在等待期展示思考过程，
                                # 消除「40 秒空白」（CLAUDE.md §6 + llm-gateway.md §2/§3）。
                                think = getattr(delta, "thinking", "") or ""
                                if think:
                                    yield SidecarEvent(type="thinking", text=think, turn=turn)
                        elif et in ("RawMessageDeltaEvent", "MessageDeltaEvent"):
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
                    bridge_input = dict(tool_input)
                    bridge_input["__approval_id"] = tool_use_id
                    current_tool_uses.append(
                        {"id": tool_use_id, "name": tool_name, "input": bridge_input}
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
    finally:
        try:
            await client.close()
        except Exception:
            logger.exception("AsyncAnthropic close failed")


async def _run_openai_compatible(
    req: SidecarRunRequest,
    upstream_base: str | None,
    upstream_key: str | None,
) -> AsyncIterator[SidecarEvent]:
    api_key = (upstream_key or os.environ.get("OPENAI_API_KEY", "")).strip()
    base_url = (upstream_base or os.environ.get("OPENAI_BASE_URL", "")).strip()
    if not api_key:
        yield SidecarEvent(type="error", error_code="openai_api_key_required", message="OPENAI_API_KEY env var is required (or per-request apiKey/profile)")
        return
    if not base_url:
        yield SidecarEvent(type="error", error_code="openai_base_url_required", message="OPENAI_BASE_URL env var is required (or per-request baseUrl/profile)")
        return

    bridge = ToolBridge(
        callback_base_url=req.callback_base_url,
        agent_api_key=req.agent_api_key,
        run_id=req.run_id,
        app_caller_code=req.app_caller_code,
        timeout_seconds=req.timeout_seconds,
    )
    history: list[dict] = [
        {"role": m.role, "content": m.content}
        for m in req.messages
    ]
    if req.system_prompt:
        history.insert(0, {"role": "system", "content": req.system_prompt})

    tools_payload = [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            },
        }
        for t in req.tools
    ]
    url = _combine_endpoint(base_url, "/v1/chat/completions")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    timeout = httpx.Timeout(req.timeout_seconds, connect=30.0)

    final_text = ""
    async with httpx.AsyncClient(timeout=timeout) as client:
        for turn in range(1, req.max_turns + 1):
            body: dict = {
                "model": req.model,
                "messages": history,
                "max_tokens": req.max_tokens,
                "stream": True,
                # OpenRouter 默认不向客户端转发 reasoning，会把 reasoning hold 到
                # 推理结束才 flush content，表现为「等 40 秒才出第一个字」。显式要求
                # 转发推理（两个字段名都给，OpenRouter 不同模型/时期支持不一致）。
                # 见 .claude/rules/llm-gateway.md §2/§3。
                "include_reasoning": True,
                "reasoning": {"exclude": False},
            }
            if tools_payload:
                body["tools"] = tools_payload
                body["tool_choice"] = "auto"

            try:
                async with client.stream("POST", url, headers=headers, json=body) as resp:
                    if resp.status_code >= 400:
                        text = await resp.aread()
                        yield SidecarEvent(
                            type="error",
                            error_code=f"openai_http_{resp.status_code}",
                            message=text.decode("utf-8", errors="replace")[:1000],
                        )
                        return

                    current_text = ""
                    tool_acc: dict[int, dict] = {}
                    finish_reason = None
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data or data == "[DONE]":
                            continue
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        # 推理增量：OpenRouter 归一为 `reasoning`，DeepSeek/硅基流动等
                        # 原生为 `reasoning_content`。两个都读，透传为 thinking 事件，
                        # 让 UI 在等待期逐字展示思考，消除 40 秒空白。
                        reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                        if reasoning:
                            yield SidecarEvent(type="thinking", text=reasoning, turn=turn)
                        content = delta.get("content")
                        if content:
                            current_text += content
                            yield SidecarEvent(type="text_delta", text=content, turn=turn)
                        for tool_delta in delta.get("tool_calls") or []:
                            idx = int(tool_delta.get("index") or 0)
                            acc = tool_acc.setdefault(
                                idx,
                                {
                                    "id": tool_delta.get("id") or f"tool-{turn}-{idx}",
                                    "name": "",
                                    "arguments": "",
                                },
                            )
                            if tool_delta.get("id"):
                                acc["id"] = tool_delta["id"]
                            fn = tool_delta.get("function") or {}
                            if fn.get("name"):
                                acc["name"] += fn["name"]
                            if fn.get("arguments"):
                                acc["arguments"] += fn["arguments"]
            except httpx.HTTPError as ex:
                yield SidecarEvent(type="error", error_code="openai_stream_error", message=str(ex))
                return

            if not tool_acc:
                final_text = current_text
                break

            tool_calls = []
            tool_results = []
            for acc in tool_acc.values():
                tool_name = acc["name"]
                try:
                    tool_input = json.loads(acc["arguments"] or "{}")
                    if not isinstance(tool_input, dict):
                        tool_input = {}
                except json.JSONDecodeError:
                    tool_input = {}
                tool_input["__approval_id"] = acc["id"]
                tool_calls.append(
                    {
                        "id": acc["id"],
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(tool_input, ensure_ascii=False),
                        },
                    }
                )
                yield SidecarEvent(
                    type="tool_use",
                    tool_name=tool_name,
                    tool_input={k: v for k, v in tool_input.items() if k != "__approval_id"},
                    tool_use_id=acc["id"],
                    turn=turn,
                )
                ok, content = await bridge.invoke(tool_name, tool_input)
                tool_results.append(
                    {
                        "role": "tool",
                        "tool_call_id": acc["id"],
                        "content": content,
                    }
                )
                yield SidecarEvent(
                    type="tool_result",
                    tool_use_id=acc["id"],
                    tool_name=tool_name,
                    content=content,
                    turn=turn,
                )

            history.append({"role": "assistant", "content": current_text or "", "tool_calls": tool_calls})
            history.extend(tool_results)
            await asyncio.sleep(0)
        else:
            yield SidecarEvent(
                type="error",
                error_code="max_turns_exceeded",
                message=f"reached maxTurns={req.max_turns} without final text",
            )
            return

    yield SidecarEvent(type="done", final_text=final_text)
