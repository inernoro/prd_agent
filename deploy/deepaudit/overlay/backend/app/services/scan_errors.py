"""Stable, non-sensitive explanations for ordinary source-scan failures."""
import json
import re

ERROR_MESSAGES = {
    "MODEL_POOL_ALL_UNAVAILABLE": "模型服务暂时没有可用实例，本次分析未完成，请稍后重试。",
    "MODEL_RATE_LIMITED": "模型服务请求受限，本次分析未完成，请稍后重试。",
    "MODEL_TIMEOUT": "模型服务响应超时，本次分析未完成，请稍后重试。",
    "MODEL_AUTH_FAILED": "模型服务认证失败，本次分析未完成，请管理员检查专用服务凭据。",
    "ANALYSIS_FAILED": "分析执行失败或中断，未形成完整质量结论，请查看覆盖范围并重试。",
}


def classify_scan_error(error):
    """Inspect only known provider status/codes; never return exception text."""
    seen = set()
    current = error
    while current is not None and id(current) not in seen and len(seen) < 8:
        seen.add(id(current))
        response = getattr(current, "response", None)
        status = getattr(current, "status_code", None) or getattr(response, "status_code", None)
        code = getattr(current, "code", None)
        body = getattr(current, "body", None)
        if body is None:
            raw = getattr(current, "api_response", None)
            if isinstance(raw, str) and len(raw) <= 32768:
                try:
                    body = json.loads(raw)
                except (ValueError, TypeError):
                    pass
        if isinstance(body, dict):
            nested = body.get("error", body)
            if isinstance(nested, dict):
                code = nested.get("code", code)
        if code == "MODEL_POOL_ALL_UNAVAILABLE":
            return code
        # LiteLLM may retain a structured gateway error inside its 503 message.
        if status == 503 and re.search(r'''["']code["']\s*:\s*["']MODEL_POOL_ALL_UNAVAILABLE["']''', str(current)):
            return "MODEL_POOL_ALL_UNAVAILABLE"
        if status == 429:
            return "MODEL_RATE_LIMITED"
        if status in (401, 403):
            return "MODEL_AUTH_FAILED"
        if status in (408, 504) or isinstance(current, TimeoutError) or type(current).__name__ in {
            "TimeoutException", "ReadTimeout", "ConnectTimeout", "APITimeoutError", "Timeout"
        }:
            return "MODEL_TIMEOUT"
        current = getattr(current, "__cause__", None) or getattr(current, "__context__", None) or getattr(current, "original_error", None)
    return "ANALYSIS_FAILED"


def record_scan_error(task, error=None):
    """Keep the first specific cause, including when an outer wrapper fails later."""
    code = classify_scan_error(error)
    if getattr(task, "error_code", None) not in ERROR_MESSAGES or task.error_code == "ANALYSIS_FAILED":
        task.error_code = code
    task.error_message = ERROR_MESSAGES[task.error_code]
