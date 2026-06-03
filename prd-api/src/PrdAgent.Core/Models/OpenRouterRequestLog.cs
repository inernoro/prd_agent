using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// OpenRouter 对外网关请求日志（与 <see cref="OpenPlatformRequestLog"/> 分离，便于按 Key 聚合用量/降级）。
///
/// 记录每次外部调用方通过 /api/v1/chat/completions、/api/v1/images/generations 的调用：
/// 请求模型 vs 实际解析模型、命中的池、是否降级、token、耗时、状态。
/// </summary>
[AppOwnership(AppNames.OpenPlatform, AppNames.OpenPlatformDisplay, IsPrimary = true)]
public class OpenRouterRequestLog
{
    /// <summary>日志唯一标识</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>AgentApiKey 的 Id</summary>
    public string KeyId { get; set; } = string.Empty;

    /// <summary>Key 所属用户 ID（计费/归属）</summary>
    public string? OwnerUserId { get; set; }

    /// <summary>请求 ID（关联 LLM 日志）</summary>
    public string RequestId { get; set; } = string.Empty;

    /// <summary>端点：chat / image / models</summary>
    public string Endpoint { get; set; } = string.Empty;

    /// <summary>客户端 body 里请求的 model（仅记录，网关按 Key 绑定覆盖）</summary>
    public string? RequestedModel { get; set; }

    /// <summary>Key 当前绑定（池 Code 或模型 id；null=默认）</summary>
    public string? Binding { get; set; }

    /// <summary>实际解析出的模型</summary>
    public string? ResolvedModel { get; set; }

    /// <summary>实际命中的模型池名称</summary>
    public string? ResolvedPool { get; set; }

    /// <summary>解析类型：DedicatedPool / DefaultPool / DirectModel / Legacy / NotFound</summary>
    public string? ResolutionType { get; set; }

    /// <summary>是否发生降级（专属模型不可用回落）</summary>
    public bool IsFallback { get; set; }

    /// <summary>是否流式</summary>
    public bool Stream { get; set; }

    /// <summary>输入 token</summary>
    public int? PromptTokens { get; set; }

    /// <summary>输出 token</summary>
    public int? CompletionTokens { get; set; }

    /// <summary>HTTP 状态码</summary>
    public int StatusCode { get; set; }

    /// <summary>错误码</summary>
    public string? ErrorCode { get; set; }

    /// <summary>耗时（毫秒）</summary>
    public long DurationMs { get; set; }

    /// <summary>客户端 IP</summary>
    public string? ClientIp { get; set; }

    /// <summary>User-Agent</summary>
    public string? UserAgent { get; set; }

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
</content>
</invoke>
