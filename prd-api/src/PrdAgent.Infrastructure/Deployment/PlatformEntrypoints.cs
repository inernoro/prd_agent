using System.Text.Json;
using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.Deployment;

/// <summary>
/// 读取平台（CDS）注入的「本部署已发布入口表」。
///
/// 背景（2026-07-29）：MAP 前端此前自己在浏览器里按 hostname 拼兄弟服务的公网域名
/// （`<预览 slug>` + `-llmgw-web` + `.miduo.org`）来跳模型网关控制台。那是 CDS 之外的
/// 第二份域名推算实现，违反根 CLAUDE.md 规则 #11（禁止自己 slugify / 拼域名），并且会
/// 在分支名长时拼出一个 CDS 根本没发布的 host —— 命名子域的第一 DNS 标签超过 63 octet
/// 时 CDS 直接跳过不发布，前端却照拼，用户点开只看到「域名不存在」。
///
/// 现在唯一合法来源是 CDS 注入的 <see cref="ServiceUrlsKey"/>：表里有就用，表里没有就
/// **如实说没有**，不再推算（no-rootless-tree：不假定不存在的能力）。
/// 生成侧 SSOT 见 cds/src/services/preview-entrypoints.ts。
/// </summary>
public static class PlatformEntrypoints
{
    /// <summary>CDS 注入的命名服务入口表，值为 JSON 对象：{"subdomain":"https://..."}。</summary>
    public const string ServiceUrlsKey = "CDS_SERVICE_URLS";

    /// <summary>CDS 注入的本分支主入口。它的存在与否 = 「本部署是不是 CDS 托管的预览」。</summary>
    public const string PreviewUrlKey = "CDS_PREVIEW_URL";

    /// <summary>模型网关控制台在 cds-compose.yml 里声明的 cds.subdomain。</summary>
    public const string GatewayConsoleSubdomain = "llmgw-web";

    /// <summary>
    /// 平台有没有下发过入口表。
    ///
    /// 用来区分「表里明确没有这一项（= 确实没发布）」与「平台压根没下发过表」——
    /// 后者出现在跑着旧版 CDS 的预览环境（该能力 2026-07-29 才加），此时既不能说
    /// 「没发布」（不知道），也不能自己拼一个（那正是本次要消灭的行为）。
    /// </summary>
    public static bool HasEntrypointTable(IConfiguration configuration)
        => !string.IsNullOrWhiteSpace(configuration[ServiceUrlsKey])
           || !string.IsNullOrWhiteSpace(configuration[PreviewUrlKey]);

    /// <summary>
    /// 取某个命名服务的公网入口；未声明（含「因超长而未发布」）时返回 null。
    /// 解析失败一律当作「未声明」——宁可说没有，也不猜一个地址。
    /// </summary>
    public static string? ResolveServiceUrl(IConfiguration configuration, string subdomain)
    {
        var raw = configuration[ServiceUrlsKey];
        if (string.IsNullOrWhiteSpace(raw) || string.IsNullOrWhiteSpace(subdomain))
            return null;

        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
                return null;
            if (!doc.RootElement.TryGetProperty(subdomain, out var value))
                return null;
            if (value.ValueKind != JsonValueKind.String)
                return null;
            var url = value.GetString();
            return string.IsNullOrWhiteSpace(url) ? null : url;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// 模型网关控制台的基址（保证以 `/` 结尾，供前端直接拼子路径）。
    /// 返回 null 表示「本部署没有独立的网关控制台入口」，调用方据此决定是同源还是报缺席。
    /// </summary>
    public static string? ResolveGatewayConsoleBaseUrl(IConfiguration configuration)
    {
        var url = ResolveServiceUrl(configuration, GatewayConsoleSubdomain);
        if (url is null) return null;
        return url.EndsWith('/') ? url : url + "/";
    }
}
