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
import json
import logging
import os
from typing import AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .agent_loop import run_agent
from .schemas import SidecarEvent, SidecarRunRequest


logging.basicConfig(
    level=os.environ.get("SIDECAR_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("sidecar")

app = FastAPI(title="Claude Agent SDK Sidecar", version="0.1.0")

SIDECAR_TOKEN = os.environ.get("SIDECAR_TOKEN", "").strip()
SIDECAR_VERSION = os.environ.get("SIDECAR_VERSION", "0.1.0")

_active_runs: dict[str, asyncio.Event] = {}


def _check_token(authorization: str | None) -> None:
    if not SIDECAR_TOKEN:
        raise HTTPException(status_code=500, detail="SIDECAR_TOKEN env not configured")
    if SIDECAR_TOKEN == "dev-skip":
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    presented = authorization[len("Bearer ") :].strip()
    if presented != SIDECAR_TOKEN:
        raise HTTPException(status_code=401, detail="invalid bearer token")


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": SIDECAR_VERSION})


@app.get("/readyz")
async def readyz() -> JSONResponse:
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    has_token = bool(SIDECAR_TOKEN)
    ready = has_key and has_token
    return JSONResponse(
        {
            "ready": ready,
            "anthropicKey": has_key,
            "sidecarToken": has_token,
            "activeRuns": len(_active_runs),
        },
        status_code=200 if ready else 503,
    )


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
            async for ev in run_agent(req):
                if cancel_event.is_set():
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
