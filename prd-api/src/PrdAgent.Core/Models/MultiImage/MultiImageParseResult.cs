namespace PrdAgent.Core.Models.MultiImage;

/// <summary>
/// 多图引用解析结果
/// </summary>
public class MultiImageParseResult
{
    /// <summary>
    /// 解析是否成功（无阻塞性错误）
    /// </summary>
    public bool IsValid { get; set; }

    /// <summary>
    /// 原始 prompt（保留 @imgN 标记）
    /// </summary>
    public string OriginalPrompt { get; set; } = string.Empty;

    /// <summary>
    /// prompt 中提到的 refId 列表（按出现顺序）
    /// </summary>
    public List<int> MentionedRefIds { get; set; } = new();

    /// <summary>
    /// 解析后的图片引用列表（按在 prompt 中出现的顺序）
    /// </summary>
    public List<ResolvedImageRef> ResolvedRefs { get; set; } = new();

    /// <summary>
    /// 非阻塞性警告（如引用的图片不存在）
    /// </summary>
    public List<string> Warnings { get; set; } = new();

    /// <summary>
    /// 阻塞性错误
    /// </summary>
    public List<string> Errors { get; set; } = new();

    /// <summary>
    /// 是否为多图场景（引用了2张及以上图片）
    /// </summary>
    public bool IsMultiImage => ResolvedRefs.Count > 1;

    /// <summary>
    /// 是否为单图场景
    /// </summary>
    public bool IsSingleImage => ResolvedRefs.Count == 1;

    /// <summary>
    /// 是否为纯文本场景（无图片引用）
    /// </summary>
    public bool IsTextOnly => ResolvedRefs.Count == 0;
}

/// <summary>
/// 意图分析结果（多图场景）
/// </summary>
public class ImageIntentResult
{
    /// <summary>
    /// 是否成功分析
    /// </summary>
    public bool Success { get; set; }

    /// <summary>
    /// 增强后的 prompt（可直接发送给生图模型）
    /// 格式：保留用户原始意图，将 @imgN 替换为清晰的图片描述
    /// </summary>
    public string EnhancedPrompt { get; set; } = string.Empty;

    /// <summary>
    /// 错误信息（如果 Success=false）
    /// </summary>
    public string? ErrorMessage { get; set; }

    /// <summary>
    /// 分析置信度（0-1）
    /// </summary>
    public double Confidence { get; set; }

    /// <summary>
    /// 原始 prompt
    /// </summary>
    public string OriginalPrompt { get; set; } = string.Empty;

    /// <summary>
    /// 图片引用数量
    /// </summary>
    public int ImageRefCount { get; set; }
}
