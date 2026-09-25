using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 把一个托管站点打成单个自包含的离线 HTML。
///
/// 只做「打包」，不做权限判断：调用方必须先用与查看 / 编辑站点相同的那道门拿到 <see cref="HostedSite"/>
/// （站内：GetByIdAsync + CanEditSiteAsync；分享：ResolveShareSiteAsync），再交给这里。
/// </summary>
public interface IHostedSiteOfflineExportService
{
    Task<HostedSiteOfflineExportResult> ExportAsync(HostedSite site, CancellationToken ct = default);
}

/// <summary>打包失败的外因分类。每一种都对应一句不同的人话和不同的下一步。</summary>
public enum HostedSiteOfflineExportFailure
{
    /// <summary>PDF / 视频包装站：正文是那份原始文件，不是网页。</summary>
    WrappedAsset,

    /// <summary>入口不是 .html / .htm。</summary>
    EntryNotHtml,

    /// <summary>站点文件清单里找不到入口文件。</summary>
    EntryMissing,

    /// <summary>清单里有入口，但存储这会儿没交回字节。</summary>
    EntryUnreadable,

    /// <summary>内嵌之后超过体积上限。</summary>
    TooLarge,

    /// <summary>页面用 meta 声明了自己的内容安全策略，离线内嵌的 data: 资源会被它拦下。</summary>
    ContentSecurityPolicyMeta,
}

public sealed record HostedSiteOfflineExportMissing(string Reference, string Reason);

public sealed class HostedSiteOfflineExportResult
{
    public bool Succeeded => Failure == null;

    public HostedSiteOfflineExportFailure? Failure { get; init; }

    /// <summary>失败时给人看的完整一句话（外因在前、影响、下一步）。</summary>
    public string? Message { get; init; }

    public byte[] Html { get; init; } = Array.Empty<byte>();

    public string FileName { get; init; } = "page.html";

    public int InlinedCount { get; init; }

    /// <summary>没能打包进来的引用（站内找不到 / 跳出站点根 / 读取失败）。成功时也可能非空。</summary>
    public IReadOnlyList<HostedSiteOfflineExportMissing> Missing { get; init; } = Array.Empty<HostedSiteOfflineExportMissing>();

    /// <summary>
    /// 留在文件里、打开时仍要联网加载的外部地址数（http(s) 与协议相对 //，按完整地址去重）。
    /// 大于 0 时不能对用户说「断网也能打开」。
    /// </summary>
    public int ExternalCount { get; init; }

    /// <summary>这些外部地址涉及的主机（去重、保持出现顺序），供界面举例。</summary>
    public IReadOnlyList<string> ExternalHosts { get; init; } = Array.Empty<string>();
}
