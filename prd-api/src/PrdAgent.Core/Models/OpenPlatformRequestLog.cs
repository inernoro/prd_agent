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
}
