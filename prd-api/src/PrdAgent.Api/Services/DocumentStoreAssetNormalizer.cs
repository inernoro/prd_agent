using System.Text.RegularExpressions;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

public sealed record DocumentStoreInlineAsset(
    string Name,
    string? Caption,
    string? Mime,
    string? Base64,
    string? FileName,
    string? ExtensionHint);

public sealed record DocumentStoreAssetNormalizationOptions(string? Domain = null);

public sealed record DocumentStoreAssetNormalizationResult(
    string Content,
    IReadOnlyList<DocumentStoreNormalizedAsset> Assets);

public sealed record DocumentStoreNormalizedAsset(
    string Name,
    string Url,
    string Sha256,
    string Mime,
    long SizeBytes);

/// <summary>
/// 统一把知识库 Markdown 里的临时图片形态资产化，正文只落正式 HTTPS 图链。
/// 支持两种输入：
/// 1. {{IMG:name}} + assets[] 一次性归档协议。
/// 2. 旧正文中的 data:image/*;base64 自动迁移。
/// </summary>
public sealed class DocumentStoreAssetNormalizer
{
    private static readonly Regex ImagePlaceholderRegex = new(@"\{\{IMG:(?<name>[^}]+)\}\}", RegexOptions.Compiled);
    private static readonly Regex MarkdownDataImageRegex = new(
        @"!\[(?<alt>[^\]]*)\]\(\s*data:(?<mime>image/[a-zA-Z0-9.+-]+);base64,(?<data>[^)\s]+)\s*\)",
        RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex HtmlDataImageRegex = new(
        "(?<prefix><img\\b[^>]*?\\bsrc=[\"'])data:(?<mime>image/[a-zA-Z0-9.+-]+);base64,(?<data>[^\"']+)(?<suffix>[\"'][^>]*>)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.Singleline);

    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<DocumentStoreAssetNormalizer> _logger;

    public DocumentStoreAssetNormalizer(
        IAssetStorage assetStorage,
        ILogger<DocumentStoreAssetNormalizer> logger)
    {
        _assetStorage = assetStorage;
        _logger = logger;
    }

    public async Task<DocumentStoreAssetNormalizationResult> NormalizeAsync(
        string content,
        IEnumerable<DocumentStoreInlineAsset>? inlineAssets,
        DocumentStoreAssetNormalizationOptions? options,
        CancellationToken ct)
    {
        content ??= string.Empty;
        var uploaded = new List<DocumentStoreNormalizedAsset>();
        var domain = NormalizeDomain(options?.Domain);

        var byName = (inlineAssets ?? Array.Empty<DocumentStoreInlineAsset>())
            .Where(x => !string.IsNullOrWhiteSpace(x.Name))
            .GroupBy(x => x.Name.Trim(), StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Last(), StringComparer.Ordinal);

        foreach (Match match in ImagePlaceholderRegex.Matches(content).Cast<Match>().ToArray())
        {
            var name = match.Groups["name"].Value.Trim();
            if (!byName.TryGetValue(name, out var asset))
            {
                throw new InvalidOperationException($"知识库图片占位符缺少对应资产：{name}");
            }

            var stored = await UploadInlineAssetAsync(asset, domain, ct);
            uploaded.Add(stored);
            var caption = string.IsNullOrWhiteSpace(asset.Caption) ? name : asset.Caption!.Trim();
            content = content.Replace(match.Value, $"![{EscapeAlt(caption)}]({stored.Url})", StringComparison.Ordinal);
        }

        content = await ReplaceMarkdownDataImagesAsync(content, domain, uploaded, ct);
        content = await ReplaceHtmlDataImagesAsync(content, domain, uploaded, ct);

        if (content.Contains("data:image", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("知识库正文仍包含 data:image，已拒绝保存，避免分享页破图");
        }

        return new DocumentStoreAssetNormalizationResult(content, uploaded);
    }

    private async Task<string> ReplaceMarkdownDataImagesAsync(
        string content,
        string domain,
        List<DocumentStoreNormalizedAsset> uploaded,
        CancellationToken ct)
    {
        var matches = MarkdownDataImageRegex.Matches(content).Cast<Match>().ToArray();
        foreach (var match in matches)
        {
            var alt = match.Groups["alt"].Value.Trim();
            var mime = match.Groups["mime"].Value.Trim();
            var data = match.Groups["data"].Value.Trim();
            var stored = await UploadBase64Async(
                $"inline-{uploaded.Count + 1}",
                alt,
                mime,
                data,
                domain,
                ct);
            uploaded.Add(stored);
            content = content.Replace(match.Value, $"![{EscapeAlt(alt)}]({stored.Url})", StringComparison.Ordinal);
        }
        return content;
    }

    private async Task<string> ReplaceHtmlDataImagesAsync(
        string content,
        string domain,
        List<DocumentStoreNormalizedAsset> uploaded,
        CancellationToken ct)
    {
        var matches = HtmlDataImageRegex.Matches(content).Cast<Match>().ToArray();
        foreach (var match in matches)
        {
            var mime = match.Groups["mime"].Value.Trim();
            var data = match.Groups["data"].Value.Trim();
            var stored = await UploadBase64Async(
                $"html-inline-{uploaded.Count + 1}",
                null,
                mime,
                data,
                domain,
                ct);
            uploaded.Add(stored);
            var replacement = $"{match.Groups["prefix"].Value}{stored.Url}{match.Groups["suffix"].Value}";
            content = content.Replace(match.Value, replacement, StringComparison.Ordinal);
        }
        return content;
    }

    private async Task<DocumentStoreNormalizedAsset> UploadInlineAssetAsync(
        DocumentStoreInlineAsset asset,
        string domain,
        CancellationToken ct)
    {
        var (mime, base64) = SplitDataUrl(asset.Base64, asset.Mime);
        return await UploadBase64Async(asset.Name, asset.Caption, mime, base64, domain, ct, asset.FileName, asset.ExtensionHint);
    }

    private async Task<DocumentStoreNormalizedAsset> UploadBase64Async(
        string name,
        string? caption,
        string? mime,
        string base64,
        string domain,
        CancellationToken ct,
        string? fileName = null,
        string? extensionHint = null)
    {
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException ex)
        {
            throw new InvalidOperationException($"知识库图片资产 base64 无效：{name}", ex);
        }

        if (bytes.Length == 0)
        {
            throw new InvalidOperationException($"知识库图片资产为空：{name}");
        }

        var safeMime = string.IsNullOrWhiteSpace(mime) ? "image/png" : mime.Trim();
        if (!safeMime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"知识库图片资产 mime 非图片：{name} ({safeMime})");
        }

        var stored = await _assetStorage.SaveAsync(
            bytes,
            safeMime,
            ct,
            domain: domain,
            type: AppDomainPaths.TypeImg,
            fileName: fileName,
            extensionHint: extensionHint);

        _logger.LogInformation(
            "[document-store] markdown image asset normalized. name={Name} sha={Sha} bytes={Bytes}",
            name,
            stored.Sha256,
            stored.SizeBytes);

        return new DocumentStoreNormalizedAsset(name, stored.Url, stored.Sha256, stored.Mime, stored.SizeBytes);
    }

    private static (string? mime, string base64) SplitDataUrl(string? rawBase64, string? fallbackMime)
    {
        var raw = (rawBase64 ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new InvalidOperationException("知识库图片资产缺少 base64 内容");
        }

        if (!raw.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            return (fallbackMime, raw);
        }

        var comma = raw.IndexOf(',');
        if (comma <= 0)
        {
            throw new InvalidOperationException("知识库图片 data URL 格式无效");
        }

        var header = raw[..comma];
        var data = raw[(comma + 1)..].Trim();
        var mime = fallbackMime;
        var semi = header.IndexOf(';');
        if (semi > "data:".Length)
        {
            mime = header["data:".Length..semi];
        }
        return (mime, data);
    }

    private static string NormalizeDomain(string? requested)
    {
        if (string.IsNullOrWhiteSpace(requested))
        {
            return AppDomainPaths.DomainAssets;
        }

        return AppDomainPaths.NormDomain(requested);
    }

    private static string EscapeAlt(string value)
    {
        return (value ?? string.Empty)
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("]", "\\]", StringComparison.Ordinal);
    }
}
