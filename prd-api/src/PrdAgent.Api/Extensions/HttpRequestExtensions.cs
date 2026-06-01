using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace PrdAgent.Api.Extensions;

/// <summary>
/// HTTP 请求扩展方法。
/// </summary>
public static class HttpRequestExtensions
{
    /// <summary>
    /// 取客户端 IP（用于访问统计 / 审计展示）。反向代理 / Docker 网络下，
    /// <see cref="ConnectionInfo.RemoteIpAddress"/> 只是上一跳（172.20.x.x 内网 / ::ffff: 映射）。
    ///
    /// 策略（维护者 2026-06-01 决策：只信不可伪造的代理覆盖值，不解析 X-Forwarded-For）：
    ///   1. X-Real-IP —— 反代用 $remote_addr 覆盖写入，客户端无法伪造
    ///   2. RemoteIpAddress —— socket 对端地址
    /// 不读 X-Forwarded-For：其首段客户端可伪造，而彻底防伪需要部署侧「可信代理清单」
    /// （KnownProxies/KnownNetworks 或可信跳数），代码无法推断。取「不可伪造值」优先于
    /// 「穿透多层代理的精确性」。
    ///
    /// 已知权衡（见 doc/debt.web-hosting-client-ip.md）：多层 public 拓扑
    /// （public-nginx→gateway→branch-nginx→api）下，内层 nginx 把 X-Real-IP 覆盖成 gateway
    /// 内网地址，故此处会记到代理 IP 而非真实访客。若要在生产恢复真实访客 IP，须改用全局
    /// UseForwardedHeaders + 运维提供的可信代理 CIDR。
    /// IPv4-mapped IPv6（::ffff:1.2.3.4）统一规整回点分十进制。
    /// </summary>
    public static string? GetRealClientIp(this HttpContext context)
    {
        var xRealIp = context.Request.Headers["X-Real-IP"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(xRealIp))
            return NormalizeIp(xRealIp.Trim());

        return NormalizeIp(context.Connection.RemoteIpAddress?.ToString());
    }

    // ::ffff:1.2.3.4 -> 1.2.3.4；其余原样返回
    private static string? NormalizeIp(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip)) return ip;
        if (IPAddress.TryParse(ip, out var addr) && addr.IsIPv4MappedToIPv6)
            return addr.MapToIPv4().ToString();
        return ip;
    }

    /// <summary>
    /// 解析服务器的外部可访问 URL。
    /// 优先级：X-Client-Base-Url（前端传递）> 配置 ServerUrl > X-Forwarded-Host/Proto > Origin > Request.Host
    /// </summary>
    public static string ResolveServerUrl(this HttpRequest request, IConfiguration config)
    {
        // 1. 前端显式传递（前端最清楚自己的真实域名）
        var clientBaseUrl = request.Headers["X-Client-Base-Url"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(clientBaseUrl))
            return clientBaseUrl.TrimEnd('/');

        // 2. 显式配置（环境变量 / appsettings）
        var configured = config["ServerUrl"];
        if (!string.IsNullOrWhiteSpace(configured))
            return configured.TrimEnd('/');

        // 3. X-Forwarded-Host (反向代理 / Docker / CDS)
        var forwardedHost = request.Headers["X-Forwarded-Host"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(forwardedHost))
        {
            var forwardedScheme = request.Headers["X-Forwarded-Proto"].FirstOrDefault() ?? "https";
            return $"{forwardedScheme}://{forwardedHost.Split(',')[0].Trim()}";
        }

        // 4. Origin header (浏览器请求会带)
        var origin = request.Headers.Origin.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(origin))
            return origin.TrimEnd('/');

        // 5. Fallback: Request.Host
        return $"{request.Scheme}://{request.Host}";
    }
}
