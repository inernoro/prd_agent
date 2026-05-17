"""
Sidecar 协议数据契约。与 prd-api 的 ClaudeSidecar* 类型一一对应。
任何字段调整必须同步更新 prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/SidecarTypes.cs
"""
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


class SidecarMessage(BaseModel):
    role: str
    content: str


class SidecarToolDef(BaseModel):
    """工具的 JSON Schema 描述，直接喂给 anthropic SDK 的 tools 参数"""
    name: str
    description: str
    input_schema: dict[str, Any]


class SidecarRunRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

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
    protocol: Optional[str] = Field(None, alias="protocol")

    # runtime adapter 选择：
    #   legacy-sidecar / legacy: 走当前自研 messages.tool_use loop
    #   claude-agent-sdk / official: 走官方 Claude Agent SDK（可选依赖）
    # MAP 默认传 claude-agent-sdk；为空时由 SIDECAR_AGENT_ADAPTER 环境变量决定，
    # sidecar standalone 默认 legacy。
    runtime_adapter: Optional[str] = Field(None, alias="runtimeAdapter")

    # MAP/CDS trace context. These identifiers are safe to log and help correlate
    # official SDK events with MAP events and UI diagnostics.
    map_session_id: Optional[str] = Field(None, alias="mapSessionId")
    trace_id: Optional[str] = Field(None, alias="traceId")

    # Per-run workspace context. MAP/CDS owns workspace selection; official SDK uses
    # workspace_root as cwd when present, otherwise falls back to AGENT_WORKSPACE_ROOT.
    workspace_root: Optional[str] = Field(None, alias="workspaceRoot")
    git_repository: Optional[str] = Field(None, alias="gitRepository")
    git_ref: Optional[str] = Field(None, alias="gitRef")


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
