using System.Text.RegularExpressions;

namespace PrdAgent.Core.Services;

/// <summary>
/// 文档验证器
/// </summary>
public static class DocumentValidator
{
    /// <summary>最大文档大小（10MB）</summary>
    public const int MaxDocumentSize = 10 * 1024 * 1024;

    /// <summary>最大Token数（100K，约10万字中文）</summary>
    public const int MaxTokens = 100_000;

    /// <summary>
    /// 验证文档内容
    /// </summary>
    public static DocumentValidationResult Validate(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return DocumentValidationResult.Fail("CONTENT_EMPTY", "文档内容不能为空");
        }

        // 大小验证
        var sizeInBytes = System.Text.Encoding.UTF8.GetByteCount(content);
        if (sizeInBytes > MaxDocumentSize)
        {
            return DocumentValidationResult.Fail("DOCUMENT_TOO_LARGE", 
                $"文档大小超出限制（最大10MB，当前{sizeInBytes / 1024 / 1024:F1}MB）");
        }

        // 格式验证 - 检查是否为有效的文本格式（Markdown / MDC / 纯文本）
        if (!IsValidTextContent(content))
        {
            return DocumentValidationResult.Fail("INVALID_FORMAT",
                "文档格式不正确，请上传 Markdown、MDC 或纯文本格式的文档");
        }

        // Token估算
        var estimatedTokens = EstimateTokens(content);
        if (estimatedTokens > MaxTokens)
        {
            return DocumentValidationResult.Fail("DOCUMENT_TOO_LARGE", 
                $"文档内容过长（预估Token数：{estimatedTokens}，最大支持：{MaxTokens}）");
        }

        return DocumentValidationResult.Success(estimatedTokens);
    }

    /// <summary>
    /// 检查是否为有效的文本内容（Markdown / MDC / 纯文本）
    /// </summary>
    private static bool IsValidTextContent(string content)
    {
        // 去除 MDC/Markdown 的 YAML frontmatter 后再检测
        var body = StripYamlFrontmatter(content);

        // 纯文本只要有可读字符即可
        if (body.Trim().Length < 2)
            return false;

        return true;
    }

    /// <summary>
    /// 去除 YAML frontmatter（--- ... --- 包裹的头部元数据），常见于 .mdc 文件
    /// </summary>
    public static string StripYamlFrontmatter(string content)
    {
        if (!content.StartsWith("---"))
            return content;

        // 查找第二个 --- 标记（frontmatter 的结束）
        var endIndex = content.IndexOf("\n---", 3, StringComparison.Ordinal);
        if (endIndex < 0)
            return content;

        // 跳过结束标记行
        var afterFrontmatter = endIndex + 4; // "\n---".Length
        if (afterFrontmatter < content.Length && content[afterFrontmatter] == '\n')
            afterFrontmatter++;
        if (afterFrontmatter < content.Length && content[afterFrontmatter] == '\r')
            afterFrontmatter++;

        return afterFrontmatter >= content.Length ? string.Empty : content[afterFrontmatter..];
    }

    /// <summary>
    /// 估算Token数量（改进版）
    /// </summary>
    public static int EstimateTokens(string content)
    {
        if (string.IsNullOrEmpty(content))
            return 0;

        // 分别计算中文和非中文字符
        var chinesePattern = new Regex(@"[\u4e00-\u9fff]");
        var chineseMatches = chinesePattern.Matches(content);
        int chineseCount = chineseMatches.Count;
        
        // 非中文字符（按空格分词估算）
        var nonChineseContent = chinesePattern.Replace(content, " ");
        var words = nonChineseContent.Split(new[] { ' ', '\t', '\n', '\r' }, 
            StringSplitOptions.RemoveEmptyEntries);
        int wordCount = words.Length;

        // 中文：约1.5 Token/字符（GPT/Claude对中文的tokenization）
        // 英文：约1.3 Token/词（考虑到子词tokenization）
        // 标点符号和空格：约0.5 Token
        var punctuationCount = Regex.Matches(content, @"[^\w\s\u4e00-\u9fff]").Count;
        
        return (int)(chineseCount * 1.5 + wordCount * 1.3 + punctuationCount * 0.5);
    }
}

/// <summary>
/// 文档验证结果
/// </summary>
public class DocumentValidationResult
{
    public bool IsValid { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public int EstimatedTokens { get; set; }

    public static DocumentValidationResult Success(int estimatedTokens) => new()
    {
        IsValid = true,
        EstimatedTokens = estimatedTokens
    };

    public static DocumentValidationResult Fail(string code, string message) => new()
    {
        IsValid = false,
        ErrorCode = code,
        ErrorMessage = message
    };
}
