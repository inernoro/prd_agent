using System.Text;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 离线 HTML 打包：从站点记录的文件清单出发，经 <see cref="IAssetStorage"/> 按清单里的 CosKey 读字节，
/// 交给 <see cref="HostedSiteHtmlInliner"/> 内嵌。读文件的键只可能来自清单，引用路径永远不会被拼成存储键。
/// </summary>
public sealed class HostedSiteOfflineExportService : IHostedSiteOfflineExportService
{
    public const long MaxOutputBytes = HostedSiteHtmlInliner.DefaultMaxOutputBytes;

    private readonly IAssetStorage _storage;
    private readonly ILogger<HostedSiteOfflineExportService> _logger;

    public HostedSiteOfflineExportService(IAssetStorage storage, ILogger<HostedSiteOfflineExportService> logger)
    {
        _storage = storage;
        _logger = logger;
    }

    public async Task<HostedSiteOfflineExportResult> ExportAsync(HostedSite site, CancellationToken ct = default)
    {
        // 与「版本基线能不能读入口 HTML」同一条判据：壳子本身就是正文的包装站（Markdown）可以打包，
        // PDF / 视频壳只是个容器，正文是那份原始文件。
        if (!HostedSiteService.IsRevisionReadableWrapper(site.WrappedAssetType?.Trim()))
            return Fail(HostedSiteOfflineExportFailure.WrappedAsset);

        var extension = Path.GetExtension(site.EntryFile ?? string.Empty);
        if (!string.Equals(extension, ".html", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(extension, ".htm", StringComparison.OrdinalIgnoreCase))
            return Fail(HostedSiteOfflineExportFailure.EntryNotHtml);

        var files = (site.Files ?? new List<HostedSiteFile>())
            .Where(f => !string.IsNullOrWhiteSpace(f.Path) && !string.IsNullOrWhiteSpace(f.CosKey))
            .ToList();
        var entry = files.FirstOrDefault(f => string.Equals(f.Path, site.EntryFile, StringComparison.OrdinalIgnoreCase));
        if (entry == null) return Fail(HostedSiteOfflineExportFailure.EntryMissing);
        if (entry.Size > MaxOutputBytes) return Fail(HostedSiteOfflineExportFailure.TooLarge, entry.Path);

        var entryBytes = await _storage.TryDownloadBytesAsync(entry.CosKey, ct);
        if (entryBytes == null) return Fail(HostedSiteOfflineExportFailure.EntryUnreadable);
        if (entryBytes.LongLength > MaxOutputBytes) return Fail(HostedSiteOfflineExportFailure.TooLarge, entry.Path);

        var html = entryBytes.Length >= 3 && entryBytes[0] == 0xEF && entryBytes[1] == 0xBB && entryBytes[2] == 0xBF
            ? Encoding.UTF8.GetString(entryBytes, 3, entryBytes.Length - 3)
            : Encoding.UTF8.GetString(entryBytes);

        var inliner = new HostedSiteHtmlInliner(
            files.Select(f => new HostedSiteInlineFile(f.Path, f.Size, f.MimeType, f.CosKey)),
            async (file, token) => string.IsNullOrWhiteSpace(file.StorageKey)
                ? null
                : await _storage.TryDownloadBytesAsync(file.StorageKey, token),
            MaxOutputBytes);
        var result = await inliner.InlineAsync(entry.Path, html, ct);
        var missing = result.Missing.Select(ToPublic).ToList();

        if (!result.Succeeded)
            return Fail(HostedSiteOfflineExportFailure.TooLarge, result.OverLimitAt, missing);

        if (missing.Count > 0)
        {
            // 降级留痕：离线文件照常给出，但哪些位置缺了要在日志和响应头里都说清楚。
            _logger.LogInformation(
                "离线打包站点 {SiteId}：{Missing} 处引用未能打包（示例：{Sample}）",
                site.Id, missing.Count, string.Join(", ", missing.Take(5).Select(m => $"{m.Reason}:{m.Reference}")));
        }

        return new HostedSiteOfflineExportResult
        {
            Html = Encoding.UTF8.GetBytes(result.Html),
            FileName = BuildFileName(site.Title),
            InlinedCount = result.InlinedCount,
            Missing = missing,
        };
    }

    /// <summary>失败文案的唯一构造器：外因（发生了什么）→ 影响 → 下一步，内因细节只作括号附注。</summary>
    internal static string DescribeFailure(HostedSiteOfflineExportFailure failure, string? detail = null) => failure switch
    {
        HostedSiteOfflineExportFailure.WrappedAsset =>
            "这是 PDF / 视频包装出来的网页，正文是那份原始文件而不是网页，打不成离线 HTML。线上页面不受影响；请直接打开源文件另存。",
        HostedSiteOfflineExportFailure.EntryNotHtml =>
            "这个站点的入口文件不是 HTML，没有可以打包的网页。线上页面不受影响；如需离线保存，请在浏览器里直接另存。",
        HostedSiteOfflineExportFailure.EntryMissing =>
            "这个网页的入口文件已经不在文件清单里了（多半被重新上传或删除过），无法打包。请重新上传网页后再试。",
        HostedSiteOfflineExportFailure.EntryUnreadable =>
            "暂时从存储里读不到这个网页的入口文件，所以这次没有生成下载。网页本身没有被改动；请过一会儿再试，一直不行请联系管理员检查对象存储。",
        HostedSiteOfflineExportFailure.TooLarge =>
            $"这个网页把图片、字体、脚本都装进一个文件后会超过 {MaxOutputBytes / 1024 / 1024}MB（内嵌后体积约增加三分之一），所以这次没有生成下载。线上页面不受影响；如需离线保存，请先压缩或删掉大体积的图片 / 视频后再试。"
            + (string.IsNullOrWhiteSpace(detail) ? string.Empty : $"（超限时正在打包：{detail}）"),
        _ => "离线打包没有完成，请稍后再试。",
    };

    private static HostedSiteOfflineExportResult Fail(
        HostedSiteOfflineExportFailure failure,
        string? detail = null,
        IReadOnlyList<HostedSiteOfflineExportMissing>? missing = null) => new()
    {
        Failure = failure,
        Message = DescribeFailure(failure, detail),
        Missing = missing ?? Array.Empty<HostedSiteOfflineExportMissing>(),
    };

    private static HostedSiteOfflineExportMissing ToPublic(HostedSiteInlineMissing m) => new(
        m.Reference,
        m.Reason switch
        {
            HostedSiteInlineMissingReason.NotInSite => "not-in-site",
            HostedSiteInlineMissingReason.OutsideSiteRoot => "outside-site-root",
            _ => "read-failed",
        });

    internal static string BuildFileName(string? title)
    {
        var invalid = new HashSet<char>("\\/:*?\"<>|");
        var cleaned = new string((title ?? string.Empty)
                .Select(c => char.IsControl(c) || invalid.Contains(c) ? ' ' : c)
                .ToArray())
            .Trim()
            .TrimEnd('.')
            .Trim();
        while (cleaned.Contains("  ", StringComparison.Ordinal)) cleaned = cleaned.Replace("  ", " ", StringComparison.Ordinal);
        if (cleaned.Length == 0) cleaned = "page";
        if (cleaned.Length > 80) cleaned = cleaned[..80];
        return cleaned + "（离线版）.html";
    }
}
