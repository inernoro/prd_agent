using System.Text.Json.Serialization;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;

namespace PrdAgent.Infrastructure.Cache;

/// <summary>
/// 缓存序列化 AOT 兼容的 JSON 序列化上下文
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
// 会话和文档
[JsonSerializable(typeof(Session))]
[JsonSerializable(typeof(ParsedPrd))]
// 引导进度
[JsonSerializable(typeof(GuideProgress))]
[JsonSerializable(typeof(List<string>))]
// 缺口分析
[JsonSerializable(typeof(GapAnalysisResult))]
// Token 使用
[JsonSerializable(typeof(TokenUsageRecord))]
[JsonSerializable(typeof(List<TokenUsageRecord>))]
// 在线状态
[JsonSerializable(typeof(OnlineStatusInfo))]
[JsonSerializable(typeof(List<OnlineStatusInfo>))]
// 缺口通知
[JsonSerializable(typeof(GapNotification))]
[JsonSerializable(typeof(List<GapNotification>))]
// 登录尝试
[JsonSerializable(typeof(LoginAttemptInfo))]
public partial class CacheJsonContext : JsonSerializerContext
{
}

/// <summary>
/// Token 使用记录
/// </summary>
public class TokenUsageRecord
{
    public string SessionId { get; set; } = string.Empty;
    public string? UserId { get; set; }
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public DateTime Timestamp { get; set; }
}

/// <summary>
/// 在线状态信息
/// </summary>
public class OnlineStatusInfo
{
    public string UserId { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public DateTime LastActiveAt { get; set; }
    public bool IsOnline { get; set; }
}

/// <summary>
/// 缺口通知
/// </summary>
public class GapNotification
{
    public string GapId { get; set; } = string.Empty;
    public string GroupId { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public string? Suggestion { get; set; }
    public DateTime CreatedAt { get; set; }
    public bool IsRead { get; set; }
}

/// <summary>
/// 登录尝试信息
/// </summary>
public class LoginAttemptInfo
{
    public int AttemptCount { get; set; }
    public DateTime FirstAttemptAt { get; set; }
    public DateTime? LockedUntil { get; set; }
}

