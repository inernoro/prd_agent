namespace PrdAgent.Core.Models;

/// <summary>站点中可通过受控附件端点取得的 PDF；只读取已登记的文件，不接受外部地址。</summary>
public static class HostedSitePdfFiles
{
    public static bool IsPdf(HostedSiteFile file) =>
        IsSafePath(file.Path)
        && file.Path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)
        && string.Equals(file.MimeType, "application/pdf", StringComparison.OrdinalIgnoreCase)
        && !string.IsNullOrWhiteSpace(file.CosKey)
        && file.Size > 0 && file.Size <= HostedSiteUploadLimits.MaxSingleFileBytes;

    public static bool IsSafePath(string? path) =>
        !string.IsNullOrWhiteSpace(path)
        && !path.Any(c => char.IsControl(c) || c is '\\' or ':' or '?' or '#')
        && !path.Split('/').Any(segment => segment is "" or "." or "..");

    public static List<string> Paths(HostedSite site) =>
        (site.Files ?? new()).Where(IsPdf).Select(file => file.Path).Distinct(StringComparer.Ordinal).ToList();

    public static HostedSiteFile? Find(HostedSite site, string path) =>
        IsSafePath(path)
            ? (site.Files ?? new()).FirstOrDefault(file => IsPdf(file)
                && string.Equals(file.Path, path, StringComparison.Ordinal))
            : null;
}
