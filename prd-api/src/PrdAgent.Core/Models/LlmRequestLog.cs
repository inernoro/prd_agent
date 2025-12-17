namespace PrdAgent.Core.Models;

/// <summary>
/// 大模型请求日志（用于调试与监控；注意：不得存储 PRD 原文与敏感信息）
/// </summary>
public class LlmRequestLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    // 关联/定位
    public string RequestId { get; set; } = string.Empty;
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? UserId { get; set; }
    public string? ViewRole { get; set; }

    // Provider / 模型信息
    public string Provider { get; set; } = string.Empty; // Claude/OpenAI/...
    public string Model { get; set; } = string.Empty;
    public string? ApiBase { get; set; }
    public string? Path { get; set; }

    // 请求（密钥已隐藏；正文按后端策略可能为摘要/占位符）
    public Dictionary<string, string>? RequestHeadersRedacted { get; set; }
    public string RequestBodyRedacted { get; set; } = string.Empty;
    public string? RequestBodyHash { get; set; }
    public int? SystemPromptChars { get; set; }
    public string? SystemPromptHash { get; set; }
    public int? MessageCount { get; set; }

    // 文档元信息（不落盘 PRD 原文）
    public int? DocumentChars { get; set; }
    public string? DocumentHash { get; set; }

    // 响应（raw SSE 仅隐藏密钥/Token；其它内容用于排障）
    public int? StatusCode { get; set; }
    public Dictionary<string, string>? ResponseHeaders { get; set; }
    public List<string>? RawSse { get; set; } // 原始 SSE 行（长度上限；仅隐藏密钥/Token）
    public bool RawSseTruncated { get; set; }
    public int? AssembledTextChars { get; set; } // 仅记录长度/哈希，不存原文
    public string? AssembledTextHash { get; set; }
    public string? Error { get; set; }

    // usage/cache
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public int? CacheCreationInputTokens { get; set; }
    public int? CacheReadInputTokens { get; set; }

    // 时序
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? FirstByteAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public long? DurationMs { get; set; }

    // 状态
    public string Status { get; set; } = "running"; // running/succeeded/failed/cancelled
}

