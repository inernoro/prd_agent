using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

/// <summary>
/// AI 助手附件输入（随提问回传的已提取文本，不落库）。
/// </summary>
public class AssistantAttachmentInput
{
    public string? Name { get; set; }
    public string? Text { get; set; }
}

/// <summary>
/// AI 助手「上传附件作为上下文」共享逻辑（项目管理 / 产品管理智能体共用）：
/// 上传时提取纯文本返回前端，前端随提问把文本回传，发问时拼进用户消息。
/// 无状态设计：服务端不存附件文本，避免临时存储的清理负担。
/// </summary>
public static class AssistantAttachmentHelper
{
    /// <summary>单文件上限（10MB）</summary>
    public const long MaxBytes = 10 * 1024 * 1024;

    /// <summary>提取返回给前端的单文件文本上限</summary>
    public const int MaxTextChars = 20_000;

    /// <summary>一次提问最多携带的附件数</summary>
    public const int MaxPerAsk = 3;

    /// <summary>拼进上下文时单附件文本上限（再保险，前端回传不可信）</summary>
    public const int MaxCharsPerAskAttachment = 12_000;

    /// <summary>支持的扩展名 → 归一 MIME（浏览器对 .md 常给空 mime，按扩展名判定）</summary>
    private static string? NormalizeMime(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".md" or ".markdown" => "text/markdown",
            ".pdf" => "application/pdf",
            _ => null,
        };
    }

    public sealed record ExtractResult(bool Ok, string? Error, string? Name, string? Text, int Chars, bool Truncated);

    /// <summary>校验并提取上传文件的纯文本（md 直读 / pdf 走 PdfPig）。</summary>
    public static async Task<ExtractResult> ExtractAsync(IFileContentExtractor extractor, IFormFile? file)
    {
        if (file == null || file.Length == 0)
            return new ExtractResult(false, "请选择文件", null, null, 0, false);
        if (file.Length > MaxBytes)
            return new ExtractResult(false, "文件不能超过 10MB", null, null, 0, false);

        var name = Path.GetFileName(file.FileName ?? "未命名");
        var mime = NormalizeMime(name);
        if (mime == null)
            return new ExtractResult(false, "暂只支持 .md / .pdf 文档", null, null, 0, false);

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var text = extractor.Extract(ms.ToArray(), mime, name);
        if (string.IsNullOrWhiteSpace(text))
            return new ExtractResult(false, "未能从文件中提取出文本（可能是扫描版 PDF 或空文档）", null, null, 0, false);

        text = text.Trim();
        var truncated = text.Length > MaxTextChars;
        if (truncated) text = text[..MaxTextChars];
        return new ExtractResult(true, null, name, text, text.Length, truncated);
    }

    /// <summary>
    /// 把提问携带的附件拼成上下文小节（空附件返回空串）。
    /// 输出形如：\n\n# 用户上传的参考文档\n## 《xxx.md》\n正文…
    /// </summary>
    public static string BuildSection(List<AssistantAttachmentInput>? attachments)
    {
        if (attachments == null || attachments.Count == 0) return string.Empty;
        var sb = new System.Text.StringBuilder();
        sb.Append("\n\n# 用户上传的参考文档");
        foreach (var a in attachments.Take(MaxPerAsk))
        {
            var name = (a.Name ?? "未命名").Trim();
            if (name.Length > 120) name = name[..120];
            var text = (a.Text ?? "").Trim();
            if (text.Length == 0) continue;
            if (text.Length > MaxCharsPerAskAttachment) text = text[..MaxCharsPerAskAttachment] + "\n（…已截断）";
            sb.Append("\n## 《").Append(name).Append("》\n").Append(text);
        }
        return sb.ToString();
    }
}
