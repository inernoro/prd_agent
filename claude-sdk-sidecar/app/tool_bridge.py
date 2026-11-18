"""Tool callback using a live, run-scoped continuation; no shared-token fallback."""
import logging
import os
import uuid
import asyncio
import time
from typing import Any
import httpx


logger = logging.getLogger("sidecar.tools")


class ToolBridge:
    def __init__(
        self,
        callback_base_url: str | None,
        agent_api_key: str | None,
        run_id: str,
        app_caller_code: str | None,
        timeout_seconds: int = 60,
        authorization=None,
        cancel_event=None,
        allowed_tools=None,
    ) -> None:
        self.callback_base_url = (callback_base_url or "").rstrip("/")
        self.callback_token = agent_api_key
        self.run_id = run_id
        self.app_caller_code = app_caller_code
        self.timeout = timeout_seconds
        self.authorization = authorization
        self.cancel_event = cancel_event
        self.allowed_tools = set(allowed_tools or [])

    def authorized(self, tool_name: str) -> bool:
        return bool(self.authorization and self.authorization.live() and tool_name in self.allowed_tools
            and not (self.cancel_event and self.cancel_event.is_set()))

    @property
    def is_configured(self) -> bool:
        return bool(self.callback_base_url and self.callback_token)

    async def invoke(self, tool_name: str, tool_input: dict[str, Any]) -> tuple[bool, str]:
        if not self.authorized(tool_name):
            return False, "runtime authorization denied"
        if not self.is_configured:
            return False, "tool bridge is not configured"
        tool_input = dict(tool_input)
        tool_input.pop("__approval_id", None)
        approval_id = f"{self.run_id}:{uuid.uuid4().hex}"
        requested, message = await self.request_permission(tool_name, tool_input, approval_id)
        if not requested:
            return False, message
        approved, approval_message = await self.wait_for_approval(tool_name, approval_id)
        if not approved:
            return False, approval_message

        if not self.authorized(tool_name):
            return False, "runtime authorization expired or cancelled"
        url = f"{self.callback_base_url}/api/agent-tools/invoke"
        payload = {
            "toolName": tool_name,
            "input": tool_input,
            "runId": self.run_id,
            "appCallerCode": self.app_caller_code,
            "approvalId": approval_id or None,
        }
        headers = {
            "X-Sidecar-Token": self.callback_token or "",
            "X-Sidecar-Name": os.environ.get("SIDECAR_NAME", "default"),
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False, trust_env=False) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as ex:
            logger.exception("tool callback transport error tool=%s", tool_name)
            return False, f"callback transport error: {ex}"

        if resp.status_code != 200:
            return False, f"callback HTTP {resp.status_code}: {resp.text[:500]}"

        try:
            data = resp.json()
        except ValueError:
            return True, resp.text

        if isinstance(data, dict):
            if data.get("success") is False:
                return False, str(data.get("message") or data.get("errorCode") or "tool failed")
            content = data.get("content")
            if content is None:
                return True, ""
            if isinstance(content, str):
                return True, content
            return True, str(content)

        return True, str(data)

    async def wait_for_approval(self, tool_name: str, approval_id: str) -> tuple[bool, str]:
        if not self.authorized(tool_name):
            return False, "runtime authorization denied"
        if not self.is_configured:
            return False, "tool bridge is not configured"
        if not approval_id:
            return False, "approval id not provided"

        url = (
            f"{self.callback_base_url}/api/agent-tools/approvals/"
            f"{self.run_id}/{approval_id}/wait"
        )
        headers = {
            "X-Sidecar-Token": self.callback_token or "",
            "X-Sidecar-Name": os.environ.get("SIDECAR_NAME", "default"),
        }
        payload = {
            "toolName": tool_name,
            "timeoutSeconds": min(max(self.timeout, 1), 900),
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout + 5, follow_redirects=False, trust_env=False) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as ex:
            logger.exception("tool approval wait transport error tool=%s", tool_name)
            return False, f"approval wait transport error: {ex}"

        if resp.status_code != 200:
            return False, f"approval wait HTTP {resp.status_code}: {resp.text[:500]}"

        try:
            data = resp.json()
        except ValueError:
            return False, f"approval wait returned non-json response: {resp.text[:500]}"

        if isinstance(data, dict) and data.get("success") is True:
            return True, str(data.get("decision") or "allowed")

        if isinstance(data, dict):
            return False, str(data.get("message") or data.get("errorCode") or "tool approval denied")

        return False, "tool approval denied"

    async def request_permission(
        self,
        tool_name: str,
        tool_input: dict[str, Any],
        approval_id: str,
        description: str | None = None,
    ) -> tuple[bool, str]:
        if not self.authorized(tool_name):
            return False, "runtime authorization denied"
        if not self.is_configured:
            return False, "tool bridge is not configured"
        if not approval_id:
            return False, "approval id not provided"

        url = (
            f"{self.callback_base_url}/api/agent-tools/approvals/"
            f"{self.run_id}/{approval_id}/request"
        )
        headers = {
            "X-Sidecar-Token": self.callback_token or "",
            "X-Sidecar-Name": os.environ.get("SIDECAR_NAME", "default"),
        }
        payload = {
            "toolName": tool_name,
            "input": tool_input,
            "description": description,
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False, trust_env=False) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as ex:
            logger.exception("tool permission request transport error tool=%s", tool_name)
            return False, f"permission request transport error: {ex}"

        if resp.status_code != 200:
            return False, f"permission request HTTP {resp.status_code}: {resp.text[:500]}"

        try:
            data = resp.json()
        except ValueError:
            return False, f"permission request returned non-json response: {resp.text[:500]}"

        if isinstance(data, dict) and data.get("success") is True:
            return True, str(data.get("risk") or "unknown")

        if isinstance(data, dict):
            return False, str(data.get("message") or data.get("errorCode") or "permission request denied")

        return False, "permission request denied"
