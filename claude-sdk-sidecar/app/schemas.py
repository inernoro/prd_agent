"""
Sidecar 协议数据契约。与 prd-api 的 ClaudeSidecar* 类型一一对应。
任何字段调整必须同步更新 prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/SidecarTypes.cs
"""
from typing import Any, Optional
from pydantic import BaseModel, Field


class SidecarMessage(BaseModel):
    role: str
    content: str


class SidecarToolDef(BaseModel):
    """工具的 JSON Schema 描述，直接喂给 anthropic SDK 的 tools 参数"""
    name: str
    description: str
    input_schema: dict[str, Any]


class SidecarRunRequest(BaseModel):
    run_id: str = Field(..., alias="runId")
    model: str = "claude-opus-4-5"
    system_prompt: str = Field("", alias="systemPrompt")
    messages: list[SidecarMessage] = Field(default_factory=list)
    tools: list[SidecarToolDef] = Field(default_factory=list)
    max_tokens: int = Field(4096, alias="maxTokens")
    max_turns: int = Field(10, alias="maxTurns")
    timeout_seconds: int = Field(600, alias="timeoutSeconds")

    callback_base_url: Optional[str] = Field(None, alias="callbackBaseUrl")
    agent_api_key: Optional[str] = Field(None, alias="agentApiKey")
    app_caller_code: Optional[str] = Field(None, alias="appCallerCode")

    # 上游切换：per-request 覆盖。三选一优先级：
    #   1. profile（命名上游集合，由 sidecar 内部 profiles 表查 base_url + api_key）
    #   2. base_url + api_key（直接覆盖）
    #   3. 默认走 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY env
    # 用于支持 DeepSeek / Kimi / GLM / OpenRouter / cc-switch 等 Anthropic-compatible 端点。
    profile: Optional[str] = Field(None, alias="profile")
    base_url: Optional[str] = Field(None, alias="baseUrl")
    api_key: Optional[str] = Field(None, alias="apiKey")

    class Config:
        populate_by_name = True


class SidecarEvent(BaseModel):
    """SSE 事件载荷，type 与 prd-api 的 ToolboxRunEventType 协议保持兼容映射"""
    type: str
    text: Optional[str] = None
    tool_name: Optional[str] = None
    tool_input: Optional[dict[str, Any]] = None
    tool_use_id: Optional[str] = None
    content: Optional[Any] = None
    final_text: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    error_code: Optional[str] = None
    message: Optional[str] = None
    turn: Optional[int] = None
