namespace PrdAgent.Core.Models;

/// <summary>
/// 已注册应用 - 第三方应用注册到系统后的记录
/// </summary>
public class RegisteredApp
{
    public string Id { get; set; } = MongoDB.Bson.ObjectId.GenerateNewId().ToString();

    /// <summary>应用唯一标识（由应用方定义）</summary>
    public string AppId { get; set; } = null!;

    /// <summary>应用名称</summary>
    public string AppName { get; set; } = null!;

    /// <summary>应用描述</summary>
    public string? Description { get; set; }

    /// <summary>应用图标（emoji 或 URL）</summary>
    public string? Icon { get; set; }

    /// <summary>应用版本</summary>
    public string Version { get; set; } = "1.0.0";

    /// <summary>应用能力声明</summary>
    public AppCapabilities Capabilities { get; set; } = new();

    /// <summary>输入规范</summary>
    public AppInputSchema InputSchema { get; set; } = new();

    /// <summary>输出规范</summary>
    public AppOutputSchema OutputSchema { get; set; } = new();

    /// <summary>调用端点（HTTP URL 或内部路由）</summary>
    public string Endpoint { get; set; } = null!;

    /// <summary>是否支持流式响应</summary>
    public bool SupportsStreaming { get; set; }

    /// <summary>是否支持状态回调</summary>
    public bool SupportsStatusCallback { get; set; }

    /// <summary>回调地址（用于异步通知）</summary>
    public string? CallbackUrl { get; set; }

    /// <summary>认证方式</summary>
    public AppAuthType AuthType { get; set; } = AppAuthType.None;

    /// <summary>API Key（如果 AuthType 为 ApiKey）</summary>
    public string? ApiKey { get; set; }

    /// <summary>是否为内置应用</summary>
    public bool IsBuiltin { get; set; }

    /// <summary>是否为桩应用（测试用）</summary>
    public bool IsStub { get; set; }

    /// <summary>桩应用配置（固定响应等）</summary>
    public StubAppConfig? StubConfig { get; set; }

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>注册时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>最后心跳时间</summary>
    public DateTime? LastHeartbeatAt { get; set; }

    /// <summary>健康状态</summary>
    public AppHealthStatus HealthStatus { get; set; } = AppHealthStatus.Unknown;

    /// <summary>调用统计</summary>
    public AppStats Stats { get; set; } = new();
}

/// <summary>
/// 应用能力声明
/// </summary>
public class AppCapabilities
{
    /// <summary>支持的输入类型</summary>
    public List<string> InputTypes { get; set; } = new() { "text" };

    /// <summary>支持的输出类型</summary>
    public List<string> OutputTypes { get; set; } = new() { "text" };

    /// <summary>是否需要用户上下文</summary>
    public bool RequiresUserContext { get; set; }

    /// <summary>是否需要会话上下文</summary>
    public bool RequiresSessionContext { get; set; }

    /// <summary>是否支持附件</summary>
    public bool SupportsAttachments { get; set; }

    /// <summary>最大输入长度</summary>
    public int? MaxInputLength { get; set; }

    /// <summary>预计处理时间（秒）</summary>
    public int? EstimatedProcessingTime { get; set; }

    /// <summary>触发关键词（用于智能路由）</summary>
    public List<string> TriggerKeywords { get; set; } = new();

    /// <summary>适用场景描述</summary>
    public string? UseCaseDescription { get; set; }
}

/// <summary>
/// 输入规范
/// </summary>
public class AppInputSchema
{
    /// <summary>必需字段</summary>
    public List<string> Required { get; set; } = new() { "content" };

    /// <summary>可选字段</summary>
    public List<string> Optional { get; set; } = new() { "attachments", "context" };

    /// <summary>自定义字段定义</summary>
    public Dictionary<string, FieldDefinition> Fields { get; set; } = new();
}

/// <summary>
/// 输出规范
/// </summary>
public class AppOutputSchema
{
    /// <summary>返回字段</summary>
    public List<string> Fields { get; set; } = new() { "result", "message" };

    /// <summary>是否返回回复内容</summary>
    public bool ReturnsReply { get; set; } = true;

    /// <summary>是否返回实体 ID</summary>
    public bool ReturnsEntityId { get; set; }

    /// <summary>自定义字段定义</summary>
    public Dictionary<string, FieldDefinition> CustomFields { get; set; } = new();
}

/// <summary>
/// 字段定义
/// </summary>
public class FieldDefinition
{
    public string Type { get; set; } = "string";
    public string? Description { get; set; }
    public bool Required { get; set; }
    public object? DefaultValue { get; set; }
}

/// <summary>
/// 桩应用配置
/// </summary>
public class StubAppConfig
{
    /// <summary>固定响应内容</summary>
    public string? FixedResponse { get; set; }

    /// <summary>响应延迟（毫秒）</summary>
    public int DelayMs { get; set; }

    /// <summary>是否随机失败</summary>
    public bool RandomFailure { get; set; }

    /// <summary>失败概率（0-100）</summary>
    public int FailureProbability { get; set; }

    /// <summary>失败时的错误消息</summary>
    public string? FailureMessage { get; set; }

    /// <summary>是否回显输入</summary>
    public bool EchoInput { get; set; }

    /// <summary>响应模板（支持变量替换）</summary>
    public string? ResponseTemplate { get; set; }
}

/// <summary>
/// 应用统计
/// </summary>
public class AppStats
{
    public long TotalInvocations { get; set; }
    public long SuccessCount { get; set; }
    public long FailureCount { get; set; }
    public double AvgResponseTimeMs { get; set; }
    public DateTime? LastInvokedAt { get; set; }
}

/// <summary>
/// 认证方式
/// </summary>
public enum AppAuthType
{
    None,
    ApiKey,
    Bearer,
    Basic,
    Custom
}

/// <summary>
/// 健康状态
/// </summary>
public enum AppHealthStatus
{
    Unknown,
    Healthy,
    Degraded,
    Unhealthy,
    Offline
}

// ==================== 统一协议 ====================

/// <summary>
/// 统一请求格式 - 通道网关发送给应用的标准请求
/// </summary>
public class UnifiedAppRequest
{
    /// <summary>请求 ID（用于追踪）</summary>
    public string RequestId { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>时间戳</summary>
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;

    /// <summary>来源信息</summary>
    public RequestSource Source { get; set; } = new();

    /// <summary>请求内容</summary>
    public RequestContent Content { get; set; } = new();

    /// <summary>用户上下文</summary>
    public RequestContext Context { get; set; } = new();

    /// <summary>路由信息</summary>
    public RoutingInfo? Routing { get; set; }
}

/// <summary>
/// 请求来源
/// </summary>
public class RequestSource
{
    /// <summary>通道类型（email, sms, siri, webhook, api）</summary>
    public string Channel { get; set; } = "unknown";

    /// <summary>发送者标识（邮箱、手机号等）</summary>
    public string SenderIdentifier { get; set; } = null!;

    /// <summary>发送者名称</summary>
    public string? SenderName { get; set; }

    /// <summary>原始消息 ID</summary>
    public string? OriginalMessageId { get; set; }

    /// <summary>通道特定元数据</summary>
    public Dictionary<string, object> ChannelMetadata { get; set; } = new();
}

/// <summary>
/// 请求内容
/// </summary>
public class RequestContent
{
    /// <summary>主题/标题</summary>
    public string? Subject { get; set; }

    /// <summary>正文内容</summary>
    public string Body { get; set; } = string.Empty;

    /// <summary>内容类型（text, html, markdown）</summary>
    public string ContentType { get; set; } = "text";

    /// <summary>附件列表</summary>
    public List<RequestAttachment> Attachments { get; set; } = new();

    /// <summary>额外参数</summary>
    public Dictionary<string, object> Parameters { get; set; } = new();
}

/// <summary>
/// 请求附件
/// </summary>
public class RequestAttachment
{
    public string FileName { get; set; } = null!;
    public string MimeType { get; set; } = null!;
    public long FileSize { get; set; }
    public string? Url { get; set; }
    public string? Base64Content { get; set; }
}

/// <summary>
/// 请求上下文
/// </summary>
public class RequestContext
{
    /// <summary>映射的用户 ID</summary>
    public string? UserId { get; set; }

    /// <summary>用户名</summary>
    public string? UserName { get; set; }

    /// <summary>会话 ID</summary>
    public string? SessionId { get; set; }

    /// <summary>群组 ID</summary>
    public string? GroupId { get; set; }

    /// <summary>自定义提示词（来自工作流配置）</summary>
    public string? CustomPrompt { get; set; }

    /// <summary>额外上下文数据</summary>
    public Dictionary<string, object> Metadata { get; set; } = new();
}

/// <summary>
/// 路由信息
/// </summary>
public class RoutingInfo
{
    /// <summary>匹配的规则 ID</summary>
    public string? RuleId { get; set; }

    /// <summary>匹配方式</summary>
    public string? MatchType { get; set; }

    /// <summary>匹配的关键词</summary>
    public string? MatchedKeyword { get; set; }
}

/// <summary>
/// 统一响应格式 - 应用返回给通道网关的标准响应
/// </summary>
public class UnifiedAppResponse
{
    /// <summary>请求 ID（与请求对应）</summary>
    public string RequestId { get; set; } = null!;

    /// <summary>处理状态</summary>
    public AppResponseStatus Status { get; set; } = AppResponseStatus.Success;

    /// <summary>状态消息</summary>
    public string? Message { get; set; }

    /// <summary>处理结果</summary>
    public ResponseResult? Result { get; set; }

    /// <summary>回复配置</summary>
    public ResponseReply? Reply { get; set; }

    /// <summary>错误信息（如果失败）</summary>
    public ResponseError? Error { get; set; }

    /// <summary>处理耗时（毫秒）</summary>
    public long? DurationMs { get; set; }

    /// <summary>额外数据</summary>
    public Dictionary<string, object>? Data { get; set; }
}

/// <summary>
/// 响应状态
/// </summary>
public enum AppResponseStatus
{
    Success,
    Failed,
    Pending,
    Processing,
    Timeout,
    Rejected
}

/// <summary>
/// 处理结果
/// </summary>
public class ResponseResult
{
    /// <summary>结果内容</summary>
    public string? Content { get; set; }

    /// <summary>创建的实体 ID</summary>
    public string? EntityId { get; set; }

    /// <summary>实体类型</summary>
    public string? EntityType { get; set; }

    /// <summary>结构化数据</summary>
    public Dictionary<string, object>? Data { get; set; }
}

/// <summary>
/// 回复配置
/// </summary>
public class ResponseReply
{
    /// <summary>是否需要回复</summary>
    public bool ShouldReply { get; set; } = true;

    /// <summary>回复内容</summary>
    public string? Content { get; set; }

    /// <summary>回复格式（text, html, markdown）</summary>
    public string ContentType { get; set; } = "text";

    /// <summary>附件</summary>
    public List<RequestAttachment>? Attachments { get; set; }
}

/// <summary>
/// 错误信息
/// </summary>
public class ResponseError
{
    public string Code { get; set; } = "UNKNOWN_ERROR";
    public string Message { get; set; } = null!;
    public string? Details { get; set; }
    public bool Retryable { get; set; }
}

// ==================== 路由规则 ====================

/// <summary>
/// 路由规则 - 定义请求如何分发到应用
/// </summary>
public class RoutingRule
{
    public string Id { get; set; } = MongoDB.Bson.ObjectId.GenerateNewId().ToString();

    /// <summary>规则名称</summary>
    public string Name { get; set; } = null!;

    /// <summary>规则描述</summary>
    public string? Description { get; set; }

    /// <summary>优先级（数字越小越优先）</summary>
    public int Priority { get; set; } = 100;

    /// <summary>匹配条件</summary>
    public RuleCondition Condition { get; set; } = new();

    /// <summary>目标应用 ID</summary>
    public string TargetAppId { get; set; } = null!;

    /// <summary>传递给应用的额外参数</summary>
    public Dictionary<string, object> ActionParams { get; set; } = new();

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 规则条件
/// </summary>
public class RuleCondition
{
    /// <summary>条件类型</summary>
    public RuleConditionType Type { get; set; } = RuleConditionType.Keyword;

    /// <summary>通道类型（为空表示所有通道）</summary>
    public string? Channel { get; set; }

    /// <summary>发送者匹配（支持通配符）</summary>
    public string? SenderPattern { get; set; }

    /// <summary>关键词列表（用于 Keyword 类型）</summary>
    public List<string> Keywords { get; set; } = new();

    /// <summary>正则表达式（用于 Regex 类型）</summary>
    public string? RegexPattern { get; set; }

    /// <summary>用户 ID（用于 User 类型）</summary>
    public string? UserId { get; set; }

    /// <summary>自定义条件表达式</summary>
    public string? CustomExpression { get; set; }
}

/// <summary>
/// 条件类型
/// </summary>
public enum RuleConditionType
{
    /// <summary>关键词匹配</summary>
    Keyword,
    /// <summary>正则表达式</summary>
    Regex,
    /// <summary>指定用户</summary>
    User,
    /// <summary>指定发送者</summary>
    Sender,
    /// <summary>所有请求（默认路由）</summary>
    All,
    /// <summary>自定义表达式</summary>
    Custom
}
