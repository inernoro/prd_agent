namespace PrdAgent.Core.Models;

/// <summary>
/// 开放平台请求日志
/// </summary>
public class OpenPlatformRequestLog
{
    /// <summary>日志唯一标识（Guid 字符串）</summary>
    public string Id { get; set; } = string.Empty;
    
    /// <summary>应用 ID</summary>
    public string AppId { get; set; } = string.Empty;
    
    /// <summary>请求 ID</summary>
    public string RequestId { get; set; } = string.Empty;
    
    /// <summary>开始时间</summary>
    public DateTime StartedAt { get; set; }
    
    /// <summary>结束时间</summary>
    public DateTime? EndedAt { get; set; }
    
    /// <summary>耗时（毫秒）</summary>
    public long? DurationMs { get; set; }
    
    /// <summary>HTTP 方法</summary>
    public string Method { get; set; } = string.Empty;
    
    /// <summary>请求路径</summary>
    public string Path { get; set; } = string.Empty;
    
    /// <summary>请求体（脱敏后）</summary>
    public string? RequestBodyRedacted { get; set; }
    
    /// <summary>HTTP 状态码</summary>
    public int StatusCode { get; set; }
    
    /// <summary>错误码</summary>
    public string? ErrorCode { get; set; }
    
    /// <summary>绑定的用户 ID</summary>
    public string? UserId { get; set; }
    
    /// <summary>实际使用的群组 ID</summary>
    public string? GroupId { get; set; }
    
    /// <summary>内部会话 ID</summary>
    public string? SessionId { get; set; }
    
    /// <summary>输入 Token 数</summary>
    public int? InputTokens { get; set; }
    
    /// <summary>输出 Token 数</summary>
    public int? OutputTokens { get; set; }
    
    /// <summary>客户端 IP</summary>
    public string? ClientIp { get; set; }
    
    /// <summary>User-Agent</summary>
    public string? UserAgent { get; set; }
    
    /// <summary>客户端类型（从 X-Client 头获取）</summary>
    public string? ClientType { get; set; }
    
    /// <summary>客户端实例 ID（从 X-Client-Id 头获取）</summary>
    public string? ClientId { get; set; }
    
    /// <summary>请求查询字符串</summary>
    public string? Query { get; set; }
    
    /// <summary>完整 URL</summary>
    public string? AbsoluteUrl { get; set; }
    
    /// <summary>响应内容（用于错误调试，仅记录非 SSE 响应）</summary>
    public string? ResponseBody { get; set; }
    
    /// <summary>响应内容是否被截断</summary>
    public bool ResponseBodyTruncated { get; set; }
}
