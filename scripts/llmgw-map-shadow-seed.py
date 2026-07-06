#!/usr/bin/env python3
"""
Seed LLM Gateway shadow evidence through real MAP API entry points.

This script intentionally drives MAP endpoints, not /gw/v1 directly. In
LlmGateway:Mode=shadow, MAP writes the shadow comparison rows that later gate
canary/http rollout. Defaults are text-only and low cost; raw/image/video/ASR
paths must be added explicitly by future flags.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


DEFAULT_BASE = "http://127.0.0.1:5500"


@dataclass(frozen=True)
class ApiResult:
    status: int
    body: str
    headers: dict[str, str]


class HttpError(RuntimeError):
    def __init__(self, method: str, url: str, status: int, body: str):
        super().__init__(f"{method} {url} failed: HTTP {status}: {body[:500]}")
        self.method = method
        self.url = url
        self.status = status
        self.body = body


def request_json(
    method: str,
    url: str,
    payload: Any | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 60,
    allow_error: bool = False,
) -> ApiResult:
    data: bytes | None = None
    req_headers = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")
    req_headers.setdefault("User-Agent", "llmgw-map-shadow-seed/1.0")
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return ApiResult(resp.status, body, dict(resp.headers.items()))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if allow_error:
            return ApiResult(exc.code, body, dict(exc.headers.items()))
        raise HttpError(method, url, exc.code, body) from exc


def parse_json_object(text: str, context: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{context} returned non-json: {text[:500]}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"{context} returned non-object json: {text[:500]}")
    return value


def api_data(result: ApiResult, context: str) -> Any:
    doc = parse_json_object(result.body, context)
    if doc.get("success") is not True:
        raise RuntimeError(f"{context} failed: {json.dumps(doc, ensure_ascii=False)[:500]}")
    return doc.get("data")


def accept_json_or_sse(result: ApiResult, context: str) -> None:
    body = result.body.lstrip()
    if body.startswith("event:") or body.startswith("data:"):
        if "type\":\"error\"" in body or "\"type\":\"error\"" in body:
            raise RuntimeError(f"{context} returned SSE error: {result.body[:500]}")
        return
    api_data(result, context)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def join_url(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def login(base: str, username: str, password: str, timeout: float) -> tuple[str, str]:
    result = request_json(
        "POST",
        join_url(base, "/api/v1/auth/login"),
        {
            "username": username,
            "password": password,
            "clientType": "admin",
        },
        timeout=timeout,
    )
    data = api_data(result, "login")
    token = (data or {}).get("accessToken") or (data or {}).get("token")
    if not token:
        raise RuntimeError("login succeeded but access token is missing")
    user_id = str(((data or {}).get("user") or {}).get("userId") or "")
    if not user_id:
        raise RuntimeError("login succeeded but user id is missing")
    return str(token), user_id


def fetch_user_id(base: str, token: str, timeout: float) -> str:
    result = request_json(
        "GET",
        join_url(base, "/api/authz/me"),
        headers=bearer(token),
        timeout=timeout,
    )
    data = api_data(result, "authz me")
    user_id = str((data or {}).get("userId") or "")
    if not user_id:
        raise RuntimeError(f"authz me response missing userId: {json.dumps(data, ensure_ascii=False)[:500]}")
    return user_id


def create_seed_user_and_login(
    base: str,
    admin_token: str,
    timeout: float,
    seed_username: str,
    seed_password: str,
    seed_role: str,
) -> tuple[str, str]:
    create_result = request_json(
        "POST",
        join_url(base, "/api/users"),
        {
            "username": seed_username,
            "displayName": "LLMGW Shadow Seed",
            "role": seed_role,
            "password": seed_password,
        },
        headers={**bearer(admin_token), "Idempotency-Key": f"llmgw-shadow-seed-{seed_username}"},
        timeout=timeout,
        allow_error=True,
    )
    if create_result.status >= 400 and "USERNAME_EXISTS" not in create_result.body:
        raise HttpError("POST", join_url(base, "/api/users"), create_result.status, create_result.body)

    result = request_json(
        "POST",
        join_url(base, "/api/v1/auth/login"),
        {
            "username": seed_username,
            "password": seed_password,
            "clientType": "desktop",
        },
        timeout=timeout,
    )
    data = api_data(result, "seed user login")
    token = str((data or {}).get("accessToken") or "")
    user_id = str(((data or {}).get("user") or {}).get("userId") or "")
    if not token or not user_id:
        raise RuntimeError("seed user login succeeded but token or user id is missing")
    return token, user_id


def create_document(base: str, token: str, timeout: float, tag: str) -> tuple[str, str]:
    title = f"LLMGW shadow seed {tag}"
    content = (
        "# Intro\n"
        "This is a short production shadow evidence document.\n\n"
        "## Scope\n"
        "Answer briefly. Do not perform external actions.\n"
    )
    result = request_json(
        "POST",
        join_url(base, "/api/v1/documents"),
        {"title": title, "content": content},
        headers=bearer(token),
        timeout=timeout,
    )
    data = api_data(result, "create document")
    session_id = str((data or {}).get("sessionId") or "")
    document_id = str(((data or {}).get("document") or {}).get("id") or "")
    if not session_id or not document_id:
        raise RuntimeError(f"create document response missing ids: {json.dumps(data, ensure_ascii=False)[:500]}")
    return session_id, document_id


def create_group(base: str, token: str, document_id: str, timeout: float) -> str:
    result = request_json(
        "POST",
        join_url(base, "/api/v1/groups"),
        {"prdDocumentId": document_id},
        headers=bearer(token),
        timeout=timeout,
    )
    data = api_data(result, "create group")
    group_id = str((data or {}).get("groupId") or "")
    if not group_id:
        raise RuntimeError(f"create group response missing groupId: {json.dumps(data, ensure_ascii=False)[:500]}")
    return group_id


def call_session_chat(base: str, token: str, session_id: str, timeout: float, tag: str) -> None:
    result = request_json(
        "POST",
        join_url(base, f"/api/v1/sessions/{urllib.parse.quote(session_id)}/messages/run"),
        {"content": f"Shadow evidence ping {tag}. Reply with one short sentence."},
        headers=bearer(token),
        timeout=timeout,
    )
    api_data(result, "session chat")


def call_preview_ask(base: str, token: str, session_id: str, timeout: float, tag: str) -> None:
    result = request_json(
        "POST",
        join_url(base, f"/api/v1/sessions/{urllib.parse.quote(session_id)}/preview-ask"),
        {
            "question": f"Summarize this section briefly. seed={tag}",
            "headingId": "intro",
            "headingTitle": "Intro",
        },
        headers=bearer(token),
        timeout=timeout,
    )
    accept_json_or_sse(result, "preview ask")


def create_open_platform_app(base: str, admin_token: str, user_id: str, group_id: str, timeout: float, tag: str) -> str:
    result = request_json(
        "POST",
        join_url(base, "/api/open-platform/apps"),
        {
            "appName": f"LLMGW Shadow Seed {tag}",
            "description": "Temporary low-risk shadow evidence seed",
            "boundUserId": user_id,
            "boundGroupId": group_id,
            "ignoreUserSystemPrompt": False,
            "disableGroupContext": False,
        },
        headers=bearer(admin_token),
        timeout=timeout,
    )
    data = api_data(result, "create open platform app")
    api_key = str((data or {}).get("apiKey") or "")
    if not api_key:
        raise RuntimeError(f"create open platform app response missing apiKey: {json.dumps(data, ensure_ascii=False)[:500]}")
    return api_key


def call_open_platform_chat(base: str, api_key: str, group_id: str, timeout: float, tag: str) -> None:
    result = request_json(
        "POST",
        join_url(base, "/api/v1/open-platform/v1/chat/completions"),
        {
            "model": "prdagent",
            "stream": False,
            "groupId": group_id,
            "messages": [
                {
                    "role": "user",
                    "content": f"Open Platform shadow evidence ping {tag}. Reply with one short sentence.",
                }
            ],
        },
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=timeout,
    )
    doc = parse_json_object(result.body, "open platform chat")
    if "choices" not in doc and doc.get("success") is not True:
        raise RuntimeError(f"open platform chat failed: {result.body[:500]}")


def call_tutorial_email_send(base: str, token: str, timeout: float, tag: str) -> None:
    result = request_json(
        "POST",
        join_url(base, "/api/tutorial-email/generate"),
        {
            "topic": f"LLM Gateway shadow send evidence {tag}",
            "style": "plain operational email",
            "language": "中文",
            "extraRequirements": "内容简短，只生成一段欢迎说明和一个按钮。",
        },
        headers=bearer(token),
        timeout=timeout,
    )
    api_data(result, "tutorial email generate")


def resolve_image_gen_model(base: str, token: str, timeout: float) -> tuple[str, str]:
    result = request_json(
        "GET",
        join_url(base, "/api/mds"),
        headers=bearer(token),
        timeout=timeout,
    )
    data = api_data(result, "mds models")
    if not isinstance(data, list):
        raise RuntimeError(f"mds models returned non-list data: {json.dumps(data, ensure_ascii=False)[:500]}")
    candidates: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        if item.get("enabled") is not True or item.get("isImageGen") is not True:
            continue
        platform_id = str(item.get("platformId") or "").strip()
        model_name = str(item.get("modelName") or "").strip()
        if platform_id and model_name:
            candidates.append(item)
    if not candidates:
        raise RuntimeError("no enabled image generation model with platformId/modelName found")
    picked = candidates[0]
    return str(picked["platformId"]).strip(), str(picked["modelName"]).strip()


def call_image_raw_generate(
    base: str,
    token: str,
    timeout: float,
    tag: str,
    platform_id: str,
    model_id: str,
    size: str,
    response_format: str,
) -> None:
    result = request_json(
        "POST",
        join_url(base, "/api/visual-agent/image-gen/generate"),
        {
            "prompt": f"Minimal production gateway raw evidence card. tag={tag}. Plain white background, black text only.",
            "platformId": platform_id,
            "modelId": model_id,
            "responseFormat": response_format,
            "size": size,
            "n": 1,
        },
        headers=bearer(token),
        timeout=timeout,
    )
    api_data(result, "image raw generate")


def parse_csv_values(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(",") if part.strip()]


def require_image_ref_shas(raw: str, minimum: int, context: str) -> list[str]:
    shas = [value.lower() for value in parse_csv_values(raw)]
    if len(shas) < minimum:
        raise RuntimeError(f"{context} requires at least {minimum} sha values via --image-ref-shas")
    for sha in shas[:minimum]:
        if len(sha) != 64 or any(ch not in "0123456789abcdef" for ch in sha):
            raise RuntimeError(f"{context} got invalid sha value: {sha}")
    return shas


def wait_image_run(
    base: str,
    token: str,
    timeout: float,
    run_id: str,
    poll_seconds: float,
    poll_interval_seconds: float,
    context: str,
) -> str:
    deadline = time.monotonic() + max(1, poll_seconds)
    terminal_statuses = {"Completed", "Failed", "Cancelled"}
    last_status = ""
    last_body = ""
    while True:
        run_result = request_json(
            "GET",
            join_url(base, f"/api/visual-agent/image-gen/runs/{urllib.parse.quote(run_id)}")
            + "?includeItems=true&includeImages=false",
            headers=bearer(token),
            timeout=timeout,
        )
        run_data = api_data(run_result, f"{context} get run")
        run_doc = (run_data or {}).get("run") if isinstance(run_data, dict) else None
        status = str((run_doc or {}).get("status") or "")
        last_status = status
        last_body = run_result.body[:1000]
        if status in terminal_statuses:
            if status != "Completed":
                raise RuntimeError(f"{context} run {run_id} ended with {status}: {last_body}")
            return run_id
        if time.monotonic() >= deadline:
            raise RuntimeError(f"{context} run {run_id} timed out at status {last_status}: {last_body}")
        time.sleep(max(0.5, poll_interval_seconds))


def call_image_worker_text2img_run(
    base: str,
    token: str,
    timeout: float,
    tag: str,
    platform_id: str,
    model_id: str,
    size: str,
    response_format: str,
    poll_seconds: float,
    poll_interval_seconds: float,
) -> str:
    result = request_json(
        "POST",
        join_url(base, "/api/visual-agent/image-gen/runs"),
        {
            "platformId": platform_id,
            "modelId": model_id,
            "items": [
                {
                    "prompt": (
                        "Minimal production gateway worker text2img evidence card. "
                        f"tag={tag}. Plain white background, black text only."
                    ),
                    "count": 1,
                    "size": size,
                }
            ],
            "size": size,
            "responseFormat": response_format,
            "maxConcurrency": 1,
            "appKey": "visual-agent",
        },
        headers={**bearer(token), "Idempotency-Key": f"llmgw-shadow-image-worker-text2img-{tag}"},
        timeout=timeout,
    )
    data = api_data(result, "image worker text2img create run")
    run_id = str((data or {}).get("runId") or "")
    if not run_id:
        raise RuntimeError(f"image worker text2img create run response missing runId: {json.dumps(data, ensure_ascii=False)[:500]}")

    return wait_image_run(base, token, timeout, run_id, poll_seconds, poll_interval_seconds, "image worker text2img")


def call_image_worker_img2img_run(
    base: str,
    token: str,
    timeout: float,
    tag: str,
    platform_id: str,
    model_id: str,
    size: str,
    response_format: str,
    image_ref_sha: str,
    poll_seconds: float,
    poll_interval_seconds: float,
) -> str:
    result = request_json(
        "POST",
        join_url(base, "/api/visual-agent/image-gen/runs"),
        {
            "platformId": platform_id,
            "modelId": model_id,
            "items": [
                {
                    "prompt": (
                        "Minimal production gateway worker img2img evidence. "
                        f"tag={tag}. Preserve the reference composition and add a small black label."
                    ),
                    "count": 1,
                    "size": size,
                }
            ],
            "size": size,
            "responseFormat": response_format,
            "maxConcurrency": 1,
            "appKey": "visual-agent",
            "initImageAssetSha256": image_ref_sha,
        },
        headers={**bearer(token), "Idempotency-Key": f"llmgw-shadow-image-worker-img2img-{tag}"},
        timeout=timeout,
    )
    data = api_data(result, "image worker img2img create run")
    run_id = str((data or {}).get("runId") or "")
    if not run_id:
        raise RuntimeError(f"image worker img2img create run response missing runId: {json.dumps(data, ensure_ascii=False)[:500]}")
    return wait_image_run(base, token, timeout, run_id, poll_seconds, poll_interval_seconds, "image worker img2img")


def create_image_master_workspace(base: str, token: str, timeout: float, tag: str) -> str:
    result = request_json(
        "POST",
        join_url(base, "/api/visual-agent/image-master/workspaces"),
        {
            "title": f"LLMGW shadow seed {tag}",
            "scenarioType": "image-gen",
        },
        headers={**bearer(token), "Idempotency-Key": f"llmgw-shadow-image-master-workspace-{tag}"},
        timeout=timeout,
    )
    data = api_data(result, "image master create workspace")
    workspace = (data or {}).get("workspace") if isinstance(data, dict) else None
    workspace_id = str((workspace or {}).get("id") or (workspace or {}).get("Id") or "")
    if not workspace_id:
        raise RuntimeError(f"image master create workspace response missing id: {json.dumps(data, ensure_ascii=False)[:500]}")
    return workspace_id


def call_image_worker_vision_run(
    base: str,
    token: str,
    timeout: float,
    tag: str,
    platform_id: str,
    model_id: str,
    size: str,
    response_format: str,
    image_ref_shas: list[str],
    poll_seconds: float,
    poll_interval_seconds: float,
) -> str:
    workspace_id = create_image_master_workspace(base, token, timeout, tag)
    refs = [
        {
            "refId": index + 1,
            "assetSha256": sha,
            "label": f"reference {index + 1}",
            "role": "reference",
        }
        for index, sha in enumerate(image_ref_shas[:2])
    ]
    result = request_json(
        "POST",
        join_url(base, f"/api/visual-agent/image-master/workspaces/{urllib.parse.quote(workspace_id)}/image-gen/runs"),
        {
            "prompt": (
                "Use @img1 and @img2 as references. Minimal production gateway worker vision evidence. "
                f"tag={tag}. Create a simple combined comparison card."
            ),
            "targetKey": f"llmgw-shadow-vision-{tag}",
            "platformId": platform_id,
            "modelId": model_id,
            "size": size,
            "responseFormat": response_format,
            "imageRefs": refs,
            "userMessageContent": f"Use @img1 and @img2 for LLM Gateway shadow vision evidence. tag={tag}",
        },
        headers={**bearer(token), "Idempotency-Key": f"llmgw-shadow-image-worker-vision-{tag}"},
        timeout=timeout,
    )
    data = api_data(result, "image worker vision create run")
    run_id = str((data or {}).get("runId") or "")
    if not run_id:
        raise RuntimeError(f"image worker vision create run response missing runId: {json.dumps(data, ensure_ascii=False)[:500]}")
    return wait_image_run(base, token, timeout, run_id, poll_seconds, poll_interval_seconds, "image worker vision")


def fetch_gateway_health(gw_base: str, timeout: float) -> dict[str, Any]:
    result = request_json("GET", join_url(gw_base, "/healthz"), timeout=timeout)
    return parse_json_object(result.body, "gateway healthz")


def fetch_shadow_summary(
    gw_base: str,
    key: str,
    timeout: float,
    since_hours: float,
    release_commit: str,
    kind: str | None = None,
) -> dict[str, Any]:
    query: dict[str, str] = {"sinceHours": str(since_hours)}
    if release_commit:
        query["releaseCommit"] = release_commit
    if kind:
        query["kind"] = kind
    url = join_url(gw_base, "/shadow-comparisons") + "?" + urllib.parse.urlencode(query)
    result = request_json("GET", url, headers={"X-Gateway-Key": key}, timeout=timeout)
    doc = parse_json_object(result.body, "shadow comparisons")
    summary = doc.get("summary")
    if not isinstance(summary, dict):
        raise RuntimeError(f"shadow comparisons missing summary: {result.body[:500]}")
    return summary


def read_env_secret(*names: str) -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def format_summary(label: str, summary: dict[str, Any]) -> str:
    return (
        f"{label}: total={summary.get('total', 0)} "
        f"allMatch={summary.get('allMatch', 0)} "
        f"critical={summary.get('critical', 0)} "
        f"httpFail={summary.get('httpFail', 0)} "
        f"coverageHours={summary.get('coverageHours', 0)}"
    )


def wait_for_shadow_growth(
    gw_base: str,
    key: str,
    timeout: float,
    since_hours: float,
    release_commit: str,
    baselines: dict[str, int],
    expected_growth: dict[str, int],
    poll_seconds: float,
    poll_interval_seconds: float,
) -> None:
    pending = {k: v for k, v in expected_growth.items() if v > 0}
    if not pending or poll_seconds <= 0:
        return

    deadline = time.monotonic() + poll_seconds
    while True:
        remaining: dict[str, tuple[int, int]] = {}
        for kind, growth in pending.items():
            summary = fetch_shadow_summary(gw_base, key, timeout, since_hours, release_commit, kind)
            total = int(summary.get("total", 0) or 0)
            target = baselines.get(kind, 0) + growth
            if total < target:
                remaining[kind] = (total, target)
        if not remaining:
            return
        if time.monotonic() >= deadline:
            detail = ", ".join(f"{kind}={total}/{target}" for kind, (total, target) in remaining.items())
            print(f"shadow growth wait timed out: {detail}")
            return
        time.sleep(max(0.5, poll_interval_seconds))


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed LLM Gateway shadow evidence through MAP API.")
    parser.add_argument("--base", default=os.environ.get("PRD_AGENT_BASE", DEFAULT_BASE), help="MAP API base URL")
    parser.add_argument("--gw-base", default=os.environ.get("LLMGW_GATE_BASE") or os.environ.get("GW_BASE") or "", help="Gateway /gw/v1 base URL")
    parser.add_argument("--gw-key", default=read_env_secret("LLMGW_GATE_KEY", "GW_KEY", "LLMGW_SERVE_KEY"), help="Gateway key, preferably via env")
    parser.add_argument("--admin-token", default=read_env_secret("PRD_TEST_ADMIN_TOKEN", "MAP_ADMIN_TOKEN"), help="Existing MAP admin JWT")
    parser.add_argument("--root-username", default=read_env_secret("ROOT_ACCESS_USERNAME") or "root", help="Root username for login")
    parser.add_argument("--root-password", default=read_env_secret("ROOT_ACCESS_PASSWORD"), help="Root password for login, preferably via env")
    parser.add_argument("--iterations", type=int, default=1, help="How many text seed iterations to run")
    parser.add_argument("--sleep-seconds", type=float, default=0, help="Sleep between iterations")
    parser.add_argument("--timeout", type=float, default=90, help="HTTP timeout seconds")
    parser.add_argument("--since-hours", type=float, default=168, help="Shadow summary window")
    parser.add_argument("--release-commit", default="", help="Release commit filter; defaults to gateway health commit")
    parser.add_argument("--skip-preview-ask", action="store_true", help="Only run session chat, skip preview-ask")
    parser.add_argument("--include-open-platform", action="store_true", help="Also seed one non-stream Open Platform call per iteration")
    parser.add_argument("--include-tutorial-email-send", action="store_true", help="Also seed one admin non-stream SendAsync call per iteration")
    parser.add_argument("--include-image-raw", action="store_true", help="Also seed one real image raw call per iteration")
    parser.add_argument("--include-image-worker-text2img", action="store_true", help="Also seed one ImageGenRunWorker text2img run per iteration")
    parser.add_argument("--include-image-worker-img2img", action="store_true", help="Also seed one ImageGenRunWorker img2img run per iteration; requires --image-ref-shas")
    parser.add_argument("--include-image-worker-vision", action="store_true", help="Also seed one ImageGenRunWorker multi-image vision run per iteration; requires at least two --image-ref-shas")
    parser.add_argument("--image-platform-id", default=read_env_secret("LLMGW_SHADOW_IMAGE_PLATFORM_ID"), help="Pinned image platform id; defaults to first enabled image model from /api/mds")
    parser.add_argument("--image-model-id", default=read_env_secret("LLMGW_SHADOW_IMAGE_MODEL_ID"), help="Pinned image model id; defaults to first enabled image model from /api/mds")
    parser.add_argument("--image-ref-shas", default=read_env_secret("LLMGW_SHADOW_IMAGE_REF_SHAS"), help="Comma-separated existing image asset sha256 values for img2img/vision evidence")
    parser.add_argument("--image-size", default="1024x1024", help="Image seed size")
    parser.add_argument("--image-response-format", default="url", help="Image seed response format")
    parser.add_argument("--image-worker-poll-seconds", type=float, default=360, help="How long to wait for ImageGenRunWorker runs")
    parser.add_argument("--image-worker-poll-interval-seconds", type=float, default=5, help="ImageGenRunWorker run poll interval")
    parser.add_argument("--settle-seconds", type=float, default=8, help="Wait before querying shadow summaries because send/raw shadow writes are async")
    parser.add_argument("--summary-poll-seconds", type=float, default=0, help="Poll shadow summaries until expected kind counts grow; useful during 100% sampling windows")
    parser.add_argument("--summary-poll-interval-seconds", type=float, default=5, help="Shadow summary poll interval")
    parser.add_argument("--seed-username", default="", help="Optional reusable business user for open-platform seeding")
    parser.add_argument("--seed-password", default=read_env_secret("LLMGW_SHADOW_SEED_PASSWORD"), help="Password for --seed-username; omit for auto generated one-shot user")
    args = parser.parse_args()

    if args.iterations < 1:
        raise SystemExit("--iterations must be >= 1")

    base = args.base.rstrip("/")
    gw_base = (args.gw_base or join_url(base, "/gw/v1")).rstrip("/")

    release_commit = args.release_commit.strip()
    if not release_commit:
        health = fetch_gateway_health(gw_base, args.timeout)
        release_commit = str(health.get("commit") or "")

    admin_token = args.admin_token.strip()
    user_id = ""
    if not admin_token:
        if not args.root_password:
            raise SystemExit("Missing admin token or ROOT_ACCESS_PASSWORD")
        admin_token, user_id = login(base, args.root_username, args.root_password, args.timeout)
    elif (
        args.include_open_platform
        or args.include_image_raw
        or args.include_image_worker_text2img
        or args.include_image_worker_img2img
        or args.include_image_worker_vision
    ):
        user_id = fetch_user_id(base, admin_token, args.timeout)

    token = admin_token
    needs_seed_user = (
        args.include_open_platform
        or args.include_tutorial_email_send
        or args.include_image_raw
        or args.include_image_worker_text2img
        or args.include_image_worker_img2img
        or args.include_image_worker_vision
    )
    if needs_seed_user:
        seed_username = args.seed_username.strip()
        seed_password = args.seed_password.strip()
        if not seed_username:
            seed_username = "llmgw_seed_" + datetime.now(timezone.utc).strftime("%m%d%H%M%S")
            seed_password = secrets.token_urlsafe(24)
        elif not seed_password:
            raise SystemExit("--seed-password or LLMGW_SHADOW_SEED_PASSWORD is required when --seed-username is set")
        seed_role = (
            "ADMIN"
            if (
                args.include_tutorial_email_send
                or args.include_image_raw
                or args.include_image_worker_text2img
                or args.include_image_worker_img2img
                or args.include_image_worker_vision
            )
            else "PM"
        )
        token, user_id = create_seed_user_and_login(base, admin_token, args.timeout, seed_username, seed_password, seed_role)

    image_platform_id = args.image_platform_id.strip()
    image_model_id = args.image_model_id.strip()
    needs_image_model = (
        args.include_image_raw
        or args.include_image_worker_text2img
        or args.include_image_worker_img2img
        or args.include_image_worker_vision
    )
    if needs_image_model and (not image_platform_id or not image_model_id):
        image_platform_id, image_model_id = resolve_image_gen_model(base, token, args.timeout)

    image_ref_shas: list[str] = []
    if args.include_image_worker_img2img:
        image_ref_shas = require_image_ref_shas(args.image_ref_shas, 1, "image worker img2img")
    if args.include_image_worker_vision:
        image_ref_shas = require_image_ref_shas(args.image_ref_shas, 2, "image worker vision")

    print(f"base={base}")
    print(f"gwBase={gw_base}")
    print(f"releaseCommit={release_commit}")
    print(f"iterations={args.iterations}")
    if args.include_image_raw:
        print(f"imageRawModel={image_platform_id}/{image_model_id}")
    if args.include_image_worker_text2img:
        print(f"imageWorkerText2ImgModel={image_platform_id}/{image_model_id}")
    if args.include_image_worker_img2img:
        print(f"imageWorkerImg2ImgModel={image_platform_id}/{image_model_id}")
        print(f"imageWorkerImg2ImgRefSha={image_ref_shas[0]}")
    if args.include_image_worker_vision:
        print(f"imageWorkerVisionModel={image_platform_id}/{image_model_id}")
        print(f"imageWorkerVisionRefShas={','.join(image_ref_shas[:2])}")

    baseline_counts: dict[str, int] = {}
    if args.gw_key:
        for kind in ("send", "stream", "raw"):
            baseline_counts[kind] = int(fetch_shadow_summary(
                gw_base,
                args.gw_key,
                args.timeout,
                args.since_hours,
                release_commit,
                kind,
            ).get("total", 0) or 0)

    for index in range(args.iterations):
        tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{index + 1}"
        session_id, document_id = create_document(base, token, args.timeout, tag)
        call_session_chat(base, token, session_id, args.timeout, tag)
        if not args.skip_preview_ask:
            call_preview_ask(base, token, session_id, args.timeout, tag)
        group_id = ""
        if args.include_open_platform:
            group_id = create_group(base, token, document_id, args.timeout)
            api_key = create_open_platform_app(base, admin_token, user_id, group_id, args.timeout, tag)
            call_open_platform_chat(base, api_key, group_id, args.timeout, tag)
        if args.include_tutorial_email_send:
            call_tutorial_email_send(base, token, args.timeout, tag)
        if args.include_image_raw:
            call_image_raw_generate(
                base,
                token,
                args.timeout,
                tag,
                image_platform_id,
                image_model_id,
                args.image_size,
                args.image_response_format,
            )
        if args.include_image_worker_text2img:
            run_id = call_image_worker_text2img_run(
                base,
                token,
                args.timeout,
                tag,
                image_platform_id,
                image_model_id,
                args.image_size,
                args.image_response_format,
                args.image_worker_poll_seconds,
                args.image_worker_poll_interval_seconds,
            )
            print(f"seed[{index + 1}] imageWorkerText2ImgRunId={run_id}")
        if args.include_image_worker_img2img:
            run_id = call_image_worker_img2img_run(
                base,
                token,
                args.timeout,
                tag,
                image_platform_id,
                image_model_id,
                args.image_size,
                args.image_response_format,
                image_ref_shas[0],
                args.image_worker_poll_seconds,
                args.image_worker_poll_interval_seconds,
            )
            print(f"seed[{index + 1}] imageWorkerImg2ImgRunId={run_id}")
        if args.include_image_worker_vision:
            run_id = call_image_worker_vision_run(
                base,
                token,
                args.timeout,
                tag,
                image_platform_id,
                image_model_id,
                args.image_size,
                args.image_response_format,
                image_ref_shas[:2],
                args.image_worker_poll_seconds,
                args.image_worker_poll_interval_seconds,
            )
            print(f"seed[{index + 1}] imageWorkerVisionRunId={run_id}")
        print(f"seed[{index + 1}] sessionId={session_id}")
        if index + 1 < args.iterations and args.sleep_seconds > 0:
            time.sleep(args.sleep_seconds)

    if args.gw_key:
        if args.settle_seconds > 0:
            time.sleep(args.settle_seconds)
        wait_for_shadow_growth(
            gw_base,
            args.gw_key,
            args.timeout,
            args.since_hours,
            release_commit,
            baseline_counts,
            {
                "stream": args.iterations,
                "send": args.iterations if args.include_tutorial_email_send else 0,
                "raw": args.iterations
                * (
                    int(args.include_image_raw)
                    + int(args.include_image_worker_text2img)
                    + int(args.include_image_worker_img2img)
                    + int(args.include_image_worker_vision)
                ),
            },
            args.summary_poll_seconds,
            args.summary_poll_interval_seconds,
        )
        print(format_summary(
            "shadow/global",
            fetch_shadow_summary(gw_base, args.gw_key, args.timeout, args.since_hours, release_commit),
        ))
        print(format_summary(
            "shadow/send",
            fetch_shadow_summary(gw_base, args.gw_key, args.timeout, args.since_hours, release_commit, "send"),
        ))
        print(format_summary(
            "shadow/stream",
            fetch_shadow_summary(gw_base, args.gw_key, args.timeout, args.since_hours, release_commit, "stream"),
        ))
        print(format_summary(
            "shadow/raw",
            fetch_shadow_summary(gw_base, args.gw_key, args.timeout, args.since_hours, release_commit, "raw"),
        ))
    else:
        print("shadow summary skipped: missing gateway key")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
