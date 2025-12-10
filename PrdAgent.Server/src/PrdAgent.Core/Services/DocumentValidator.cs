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

        // 格式验证 - 检查是否为Markdown格式
        if (!IsValidMarkdown(content))
        {
            return DocumentValidationResult.Fail("INVALID_FORMAT", 
                "文档格式不正确，请上传Markdown格式的PRD文档");
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
    /// 检查是否为有效的Markdown格式
    /// </summary>
    private static bool IsValidMarkdown(string content)
    {
        // Markdown特征检测
        var markdownPatterns = new[]
        {
            @"^#{1,6}\s+.+",      // 标题
            @"^\*\s+.+",          // 无序列表
            @"^\d+\.\s+.+",       // 有序列表
            @"\*\*.+\*\*",        // 粗体
            @"`.+`",              // 行内代码
            @"^\s*```",           // 代码块
            @"^\s*>\s+.+",        // 引用
            @"\[.+\]\(.+\)",      // 链接
            @"^\s*[-*]{3,}\s*$",  // 分隔线
            @"^\|.+\|"            // 表格
        };

        var lines = content.Split('\n');
        int markdownFeatures = 0;

        foreach (var pattern in markdownPatterns)
        {
            var regex = new Regex(pattern, RegexOptions.Multiline);
            if (regex.IsMatch(content))
            {
                markdownFeatures++;
            }
        }

        // 至少有2个Markdown特征，或者包含至少一个标题
        var hasTitle = Regex.IsMatch(content, @"^#{1,6}\s+.+", RegexOptions.Multiline);
        return hasTitle || markdownFeatures >= 2;
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


