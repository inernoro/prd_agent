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
    /// 取真实客户端 IP。反向代理 / Docker 网络下，<see cref="ConnectionInfo.RemoteIpAddress"/>
    /// 只是上一跳（如 172.20.x.x 内网地址 / ::ffff: 映射地址），并非访客真实 IP。
    /// 优先级：X-Forwarded-For 第一跳 > X-Real-IP > RemoteIpAddress。
    /// 同时把 IPv4-mapped IPv6（::ffff:1.2.3.4）规整回点分十进制。
    /// 注：仅用于访问统计/审计展示，未做代理可信校验，不可作为安全判定依据。
    /// </summary>
    public static string? GetRealClientIp(this HttpContext context)
    {
        // X-Forwarded-For: "client, proxy1, proxy2"，第一个才是原始客户端
        var xff = context.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(xff))
        {
            var first = xff.Split(',')[0].Trim();
            if (!string.IsNullOrWhiteSpace(first))
                return NormalizeIp(first);
        }

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
