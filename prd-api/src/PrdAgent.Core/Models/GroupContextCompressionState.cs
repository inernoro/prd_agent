namespace PrdAgent.Core.Models;

/// <summary>
/// 群上下文压缩状态（不包含 PRD）
/// - 用于将“较长的历史消息”压缩为一段摘要，以替代原始历史传递给大模型
/// - 该状态通常缓存于 Redis（ICacheManager），并可随时间过期；过期后可再次压缩重建
/// </summary>
public class GroupContextCompressionState
{
    public string GroupId { get; set; } = string.Empty;

    /// <summary>本次摘要覆盖的群消息 seq 范围（闭区间）</summary>
    public long FromSeq { get; set; }
    public long ToSeq { get; set; }

    /// <summary>被压缩的原始文本字符数（不含 PRD）</summary>
    public int OriginalChars { get; set; }

    /// <summary>压缩后摘要字符数</summary>
    public int CompressedChars { get; set; }

    /// <summary>压缩后的摘要文本（用于直接拼入 LLM 上下文）</summary>
    public string CompressedText { get; set; } = string.Empty;

    /// <summary>创建时间（UTC）</summary>
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}

