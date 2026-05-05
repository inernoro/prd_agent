"""
工具桥接：sidecar 收到 Claude tool_use 后，反向调主服务执行真实工具。

主服务侧通过 sk-ak-* AgentApiKey 鉴权（限定 scope + 短 TTL，由 prd-api 在
ExecuteCliAgent_ClaudeSdkAsync 入口签发）。

调用模板：
  POST {callback_base_url}/api/agent-tools/invoke
  Header: X-Agent-Api-Key: sk-ak-xxx
  Body:   { "toolName": "...", "input": {...}, "runId": "...", "appCallerCode": "..." }
  Resp:   { "success": true, "content": "..." } 或
          { "success": false, "errorCode": "...", "message": "..." }

如果未配置 callback_base_url（本地纯测试），fallback 返回固定串方便 smoke。
"""
import logging
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
    ) -> None:
        self.callback_base_url = (callback_base_url or "").rstrip("/")
        self.agent_api_key = agent_api_key
        self.run_id = run_id
        self.app_caller_code = app_caller_code
        self.timeout = timeout_seconds

    @property
    def is_configured(self) -> bool:
        return bool(self.callback_base_url and self.agent_api_key)

    async def invoke(self, tool_name: str, tool_input: dict[str, Any]) -> tuple[bool, str]:
        if not self.is_configured:
            logger.warning(
                "tool bridge not configured; returning stub for tool=%s", tool_name
            )
            return (
                True,
                f"[sidecar-stub] tool '{tool_name}' invoked locally; "
                f"configure callbackBaseUrl + agentApiKey for real execution.",
            )

        url = f"{self.callback_base_url}/api/agent-tools/invoke"
        payload = {
            "toolName": tool_name,
            "input": tool_input,
            "runId": self.run_id,
            "appCallerCode": self.app_caller_code,
        }
        headers = {"X-Agent-Api-Key": self.agent_api_key or ""}

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as ex:
            logger.exception("tool callback transport error tool=%s", tool_name)
            return False, f"callback transport error: {ex}"

        if resp.status_code >= 400:
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
