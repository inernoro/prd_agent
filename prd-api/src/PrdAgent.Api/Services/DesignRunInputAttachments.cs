using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public sealed class DesignRunInputException : Exception
{
    public DesignRunInputException(string message) : base(message) { }
}

/// <summary>
/// 把用户直接上传的附件变成一次运行的冻结输入：文档取上传时已提取的正文作为事实来源，
/// 图片只记对象存储位置，工作区打包时再原样放进 reference/。
/// 只认本人上传的附件，别人的附件编号拿来也不认。
/// </summary>
public static class DesignRunInputAttachments
{
    public const int MaxUploadedSources = 5;
    public const int MaxUploadedCharacters = 60_000;
    public const int MaxReferenceImages = 3;
    public const long MaxReferenceImageBytes = 5 * 1024 * 1024;
    private static readonly HashSet<string> ImageMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/webp",
    };

    public static async Task<List<DesignUploadedSource>> ResolveSourcesAsync(
        MongoDbContext db, string userId, IReadOnlyList<string>? attachmentIds, CancellationToken ct)
    {
        var ids = Normalize(attachmentIds);
        if (ids.Count == 0) return new List<DesignUploadedSource>();
        if (ids.Count > MaxUploadedSources)
            throw new DesignRunInputException($"一次最多直接上传 {MaxUploadedSources} 个文件");
        var found = await LoadOwnedAsync(db, userId, ids, ct);
        var result = new List<DesignUploadedSource>();
        var total = 0;
        foreach (var id in ids)
        {
            var attachment = found[id];
            var text = (attachment.ExtractedText ?? string.Empty).Trim();
            if (text.Length == 0)
                throw new DesignRunInputException($"文件「{attachment.FileName}」没有可读取的文字内容，请上传 Markdown、Word、PDF 或纯文本文件");
            total += text.Length;
            if (total > MaxUploadedCharacters)
                throw new DesignRunInputException($"上传文件的正文合计超过 {MaxUploadedCharacters / 10000} 万字，请精简或分次生成");
            result.Add(new DesignUploadedSource
            {
                AttachmentId = attachment.AttachmentId,
                FileName = attachment.FileName,
                MimeType = attachment.MimeType,
                Content = text,
                ContentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant(),
            });
        }
        return result;
    }

    public static async Task<List<DesignReferenceImage>> ResolveImagesAsync(
        MongoDbContext db, string userId, IReadOnlyList<string>? attachmentIds, CancellationToken ct)
    {
        var ids = Normalize(attachmentIds);
        if (ids.Count == 0) return new List<DesignReferenceImage>();
        if (ids.Count > MaxReferenceImages)
            throw new DesignRunInputException($"一次最多附 {MaxReferenceImages} 张截图");
        var found = await LoadOwnedAsync(db, userId, ids, ct);
        return ids.Select(id =>
        {
            var attachment = found[id];
            if (!ImageMimeTypes.Contains(attachment.MimeType))
                throw new DesignRunInputException($"「{attachment.FileName}」不是 PNG、JPEG 或 WebP 图片");
            if (attachment.Size > MaxReferenceImageBytes)
                throw new DesignRunInputException($"截图「{attachment.FileName}」超过 5 MB，请压缩后重试");
            if (string.IsNullOrWhiteSpace(attachment.StorageKey))
                throw new DesignRunInputException($"截图「{attachment.FileName}」的存储位置缺失，请重新上传");
            return new DesignReferenceImage
            {
                AttachmentId = attachment.AttachmentId,
                FileName = attachment.FileName,
                MimeType = attachment.MimeType.ToLowerInvariant(),
                Size = attachment.Size,
                StorageKey = attachment.StorageKey,
                Url = attachment.Url,
            };
        }).ToList();
    }

    /// <summary>直连执行器的提示词与 OpenDesign 的工作区共用这一份文字形态，避免两边各拼各的。</summary>
    public static string ToMarkdown(DesignUploadedSource source)
        => $"# {source.FileName}\n\n{source.Content}";

    private static List<string> Normalize(IReadOnlyList<string>? ids)
        => (ids ?? Array.Empty<string>())
            .Select(id => (id ?? string.Empty).Trim())
            .Where(id => id.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();

    private static async Task<Dictionary<string, Attachment>> LoadOwnedAsync(
        MongoDbContext db, string userId, List<string> ids, CancellationToken ct)
    {
        var items = await db.Attachments
            .Find(a => ids.Contains(a.AttachmentId) && a.UploaderId == userId)
            .ToListAsync(ct);
        var map = items.ToDictionary(a => a.AttachmentId, StringComparer.Ordinal);
        var missing = ids.FirstOrDefault(id => !map.ContainsKey(id));
        if (missing != null)
            throw new DesignRunInputException("有文件不存在或不是你上传的，请重新上传后再试");
        return map;
    }
}
