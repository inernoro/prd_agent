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

    // 交互内容（仅脱敏 token/密钥；PRD 正文不落盘由上游保证）
    // - QuestionText/AnswerText 用于管理后台快速查看
    // - 单条上限 200k 字符（超出会被截断；并记录 hash/长度用于对照）
    public string? QuestionText { get; set; }
    public string? AnswerText { get; set; }
    public int? AnswerTextChars { get; set; }
    public string? AnswerTextHash { get; set; }

    // 响应（不再记录 rawSSE）
    public int? StatusCode { get; set; }
    public Dictionary<string, string>? ResponseHeaders { get; set; }
    public int? AssembledTextChars { get; set; } // 保留：用于摘要统计（与 AnswerTextChars 一致）
    public string? AssembledTextHash { get; set; } // 保留：用于摘要统计（与 AnswerTextHash 一致）
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

