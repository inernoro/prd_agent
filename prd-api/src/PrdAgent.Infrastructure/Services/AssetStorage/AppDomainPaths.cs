using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// 统一的"领域(domain) + 类型(type)"目录映射：
/// - 本地：/data/{domain}/{type}
/// - COS key：{domain}/{type}/{sha}.{ext}
/// 全部强制小写，避免跨系统大小写不一致导致的 404/重复写入。
///
/// 域名设计原则：与 appKey 一一对应
/// - visual-agent: 视觉创作 Agent
/// - literary-agent: 文学创作 Agent
/// - prd-agent: PRD 智能问答 Agent
/// - assets: 资源管理（头像、桌面素材等）
/// - watermark: 水印配置
/// - logs: 日志相关
/// - mds: 模型管理相关
/// </summary>
public static class AppDomainPaths
{
    public const string BaseLocal = "/data";

    // domains - 与 appKey 一一对应（全小写）
    public const string DomainVisualAgent = "visual-agent";
    public const string DomainLiteraryAgent = "literary-agent";
    public const string DomainPrdAgent = "prd-agent";
    public const string DomainDefectAgent = "defect-agent";
    public const string DomainWorkflowAgent = "workflow-agent";
    public const string DomainAssets = "assets";
    public const string DomainWatermark = "watermark";
    public const string DomainLogs = "logs";
    public const string DomainMds = "mds";

    // 兼容旧域名（逐步迁移）
    [Obsolete("请使用 DomainVisualAgent")]
    public const string DomainImageGen = "imagegen";
    [Obsolete("请使用 DomainAssets")]
    public const string DomainUploads = "uploads";
    [Obsolete("请使用 DomainLogs")]
    public const string DomainLlmLogs = "llmlogs";

    // types（全小写）
    public const string TypeImg = "img";
    public const string TypeBin = "bin";
    public const string TypeLog = "log";
    public const string TypeDoc = "doc";
    public const string TypeMeta = "meta";
    public const string TypeFont = "font";

    private static readonly HashSet<string> DomainAllow = new(StringComparer.Ordinal)
    {
        // 新域名
        DomainVisualAgent, DomainLiteraryAgent, DomainPrdAgent, DomainDefectAgent, DomainWorkflowAgent, DomainAssets, DomainWatermark, DomainLogs, DomainMds,
#pragma warning disable CS0618 // 允许使用旧域名以保持兼容
        // 兼容旧域名
        DomainImageGen, DomainUploads, DomainLlmLogs,
#pragma warning restore CS0618
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
