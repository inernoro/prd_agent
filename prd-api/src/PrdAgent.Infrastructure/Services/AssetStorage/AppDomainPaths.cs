using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// 统一的“领域(domain) + 类型(type)”目录映射：
/// - 本地：/data/{domain}/{type}
/// - COS key：{domain}/{type}/{sha}.{ext}
/// 全部强制小写，避免跨系统大小写不一致导致的 404/重复写入。
/// </summary>
public static class AppDomainPaths
{
    public const string BaseLocal = "/data";

    // domains（全小写）
    public const string DomainImageMaster = "imagemaster";
    public const string DomainImageGen = "imagegen";
    public const string DomainUploads = "uploads";
    public const string DomainLlmLogs = "llmlogs";
    public const string DomainWatermark = "watermark";

    // types（全小写）
    public const string TypeImg = "img";
    public const string TypeBin = "bin";
    public const string TypeLog = "log";
    public const string TypeDoc = "doc";
    public const string TypeMeta = "meta";
    public const string TypeFont = "font";

    private static readonly HashSet<string> DomainAllow = new(StringComparer.Ordinal)
    {
        DomainImageMaster, DomainImageGen, DomainUploads, DomainLlmLogs, DomainWatermark,
    };

    private static readonly HashSet<string> TypeAllow = new(StringComparer.Ordinal)
    {
        TypeImg, TypeBin, TypeLog, TypeDoc, TypeMeta, TypeFont,
    };

    private static readonly Regex SafeSeg = new("^[a-z0-9][a-z0-9_-]*$", RegexOptions.Compiled);

    public static string NormDomain(string? domain)
    {
        var d = (domain ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(d)) throw new ArgumentException("domain 不能为空", nameof(domain));
        if (!DomainAllow.Contains(d)) throw new ArgumentException($"domain 不支持：{d}", nameof(domain));
        if (!SafeSeg.IsMatch(d)) throw new ArgumentException($"domain 非法：{d}", nameof(domain));
        return d;
    }

    public static string NormType(string? type)
    {
        var t = (type ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(t)) throw new ArgumentException("type 不能为空", nameof(type));
        if (!TypeAllow.Contains(t)) throw new ArgumentException($"type 不支持：{t}", nameof(type));
        if (!SafeSeg.IsMatch(t)) throw new ArgumentException($"type 非法：{t}", nameof(type));
        return t;
    }

    public static string LocalDir(string domain, string type)
    {
        var d = NormDomain(domain);
        var t = NormType(type);
        return Path.Combine(BaseLocal, d, t);
    }

    public static string CosKey(string domain, string type, string sha256, string ext)
    {
        var d = NormDomain(domain);
        var t = NormType(type);
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) throw new ArgumentException("sha 不能为空", nameof(sha256));
        var e = (ext ?? string.Empty).Trim().TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(e)) e = "png";
        return $"{d}/{t}/{sha}.{e}";
    }
}

