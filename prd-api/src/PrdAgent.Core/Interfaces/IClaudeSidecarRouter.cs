namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Claude Agent SDK Sidecar 路由器：负责选实例、流式调 sidecar 的
/// `/v1/agent/run`、把 SSE 事件解析回业务可用的 <see cref="SidecarEvent"/>。
/// 对 prd-api 业务层屏蔽"本地 / 同 compose / 跨服务器 sandbox"三种部署形态的差异，
/// 由 appsettings 的 `ClaudeSdkExecutor:Sidecars` 配置决定。
/// </summary>
public interface IClaudeSidecarRouter
{
    /// <summary>是否启用了至少一个 sidecar 实例。</summary>
    bool IsConfigured { get; }

    /// <summary>当前实例总数（含不健康）。</summary>
    int InstanceCount { get; }

    /// <summary>已通过最近一次健康检查的实例数。</summary>
    int HealthyCount { get; }

    /// <summary>
    /// 流式执行一次 agent run。调用方应在 await foreach 中消费事件，
    /// 直到收到 <c>done</c> 或 <c>error</c> 类型的事件。
    /// </summary>
    /// <param name="request">运行请求</param>
    /// <param name="ct">取消令牌（取消时会向 sidecar 发 cancel 请求）</param>
    IAsyncEnumerable<SidecarEvent> RunStreamAsync(
        SidecarRunRequest request,
        CancellationToken ct);
}

/// <summary>Sidecar 协议事件类型，与 Python sidecar 的 SidecarEvent.type 一一对应。</summary>
public enum SidecarEventType
{
    Unknown = 0,
    TextDelta,
    ToolUse,
    ToolResult,
    Usage,
    Done,
    Error,
    Keepalive,
}

/// <summary>sidecar SSE 事件载荷</summary>
public sealed class SidecarEvent
{
    public SidecarEventType Type { get; init; } = SidecarEventType.Unknown;
    public string? RawType { get; init; }
    public string? Text { get; init; }
    public string? ToolName { get; init; }
    public string? ToolUseId { get; init; }
    public System.Text.Json.JsonElement? ToolInput { get; init; }
    public string? Content { get; init; }
    public string? FinalText { get; init; }
    public long? InputTokens { get; init; }
    public long? OutputTokens { get; init; }
    public string? ErrorCode { get; init; }
    public string? Message { get; init; }
    public int? Turn { get; init; }
    public string? SidecarName { get; init; }
}

/// <summary>调用 sidecar 的运行请求；序列化时由 router 负责，业务层不直接拼 JSON。</summary>
public sealed class SidecarRunRequest
{
    public string RunId { get; init; } = string.Empty;
    public string Model { get; init; } = "claude-opus-4-5";
    public string SystemPrompt { get; init; } = string.Empty;
    public List<SidecarChatMessage> Messages { get; init; } = new();
    public List<SidecarToolDef> Tools { get; init; } = new();
    public int MaxTokens { get; init; } = 4096;
    public int MaxTurns { get; init; } = 10;
    public int TimeoutSeconds { get; init; } = 600;

    /// <summary>sidecar 反向调主服务的 base URL，跨服务器时不能用 127.0.0.1。</summary>
    public string? CallbackBaseUrl { get; init; }

    /// <summary>本次 run 临时签发的 sk-ak-* AgentApiKey 明文，sidecar 用它调主服务。</summary>
    public string? AgentApiKey { get; init; }

    /// <summary>用于在主服务侧关联日志、限流、计费的应用主体标识。</summary>
    public string? AppCallerCode { get; init; }

    /// <summary>路由提示：匹配 sidecar 实例的 Tags。</summary>
    public string? SidecarTag { get; init; }

    /// <summary>会话粘性 key：相同 key 落到同一 sidecar 实例。</summary>
    public string? StickyKey { get; init; }

    /// <summary>
    /// 上游切换：命名 profile（cc-switch 风格），sidecar 根据 profiles.yaml 解析 baseUrl + apiKey。
    /// 与 BaseUrl/ApiKey 互斥；profile 优先。
    /// </summary>
    public string? Profile { get; init; }

    /// <summary>per-request 直接覆盖 Anthropic-compatible 端点 URL（如 DeepSeek / Kimi / GLM / 自建网关）。</summary>
    public string? BaseUrl { get; init; }

    /// <summary>per-request 直接覆盖 API key；与 BaseUrl 一起用，跳过 sidecar 默认 env。</summary>
    public string? ApiKey { get; init; }
}

public sealed class SidecarChatMessage
{
    public string Role { get; init; } = "user";
    public string Content { get; init; } = string.Empty;
}

public sealed class SidecarToolDef
{
    public string Name { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public System.Text.Json.JsonElement InputSchema { get; init; }
}
