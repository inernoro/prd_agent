using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 系统 API 请求日志（面向用户发起的请求，不记录提示词信息）
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
public class ApiRequestLog
{
    public string Id { get; set; } = string.Empty;

    public string RequestId { get; set; } = string.Empty;

    public DateTime StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public long? DurationMs { get; set; }

    public string Method { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string? Query { get; set; }
    public string? AbsoluteUrl { get; set; }
    public string? Protocol { get; set; }

    public string? RequestContentType { get; set; }
    public string? ResponseContentType { get; set; }
    public int StatusCode { get; set; }

    /// <summary>
    /// ApiResponse 摘要（success/errorCode/items/total），用于列表快速定位
    /// </summary>
    public string? ApiSummary { get; set; }

    public string? ErrorCode { get; set; }

    public string UserId { get; set; } = "anonymous";

    public string? GroupId { get; set; }
    public string? SessionId { get; set; }

    public string? ClientIp { get; set; }
    public string? UserAgent { get; set; }

    /// <summary>
    /// 客户端类型：desktop/web/unknown（由 X-Client 识别）
    /// </summary>
    public string? ClientType { get; set; }

    /// <summary>
    /// 客户端实例 id（由 X-Client-Id 识别）
    /// </summary>
    public string? ClientId { get; set; }

    /// <summary>
    /// 应用 id（Open Platform API Key）
    /// </summary>
    public string? AppId { get; set; }

    /// <summary>
    /// 应用名称（Open Platform API Key）
    /// </summary>
    public string? AppName { get; set; }

    /// <summary>
    /// 请求体（JSON 文本，已剔除 prompt/messages/systemPrompt 等提示词字段）
    /// </summary>
    public string? RequestBody { get; set; }

    public bool RequestBodyTruncated { get; set; }

    /// <summary>
    /// 复刻请求的 curl（不包含密钥/Token；body 已做提示词剔除）
    /// </summary>
    public string? Curl { get; set; }

    public bool IsEventStream { get; set; }

    // ===== 新增字段（系统日志增强） =====

    /// <summary>
    /// 请求状态：running(进行中) / completed(完成) / failed(失败) / timeout(超时)
    /// </summary>
    public string? Status { get; set; }

    /// <summary>
    /// 方向：inbound(入站) / outbound(出站)
    /// </summary>
    public string? Direction { get; set; }

    /// <summary>
    /// 响应体（可能被截断）
    /// </summary>
    public string? ResponseBody { get; set; }

    /// <summary>
    /// 响应体是否被截断
    /// </summary>
    public bool ResponseBodyTruncated { get; set; }

    /// <summary>
    /// 响应体原始字节数
    /// </summary>
    public int? ResponseBodyBytes { get; set; }

    /// <summary>
    /// 目标地址（出站请求时记录）
    /// </summary>
    public string? TargetHost { get; set; }
}

