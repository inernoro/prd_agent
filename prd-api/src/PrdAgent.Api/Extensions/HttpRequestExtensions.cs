using System.Net;
using System.Net.Sockets;
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
    ///
    /// 本仓库部署是多层反代：public-nginx → gateway → branch-nginx → api。
    /// 每层都用 $proxy_add_x_forwarded_for 把「它看到的 remote_addr」追加到 X-Forwarded-For 末尾；
    /// 内层 nginx 又用 $remote_addr 覆盖 X-Real-IP，使其退化成上一跳（gateway）的内网地址。
    /// 因此两种简单做法都错：
    ///   - 取 XFF 首段 → 客户端可伪造（`X-Forwarded-For: 1.2.3.4` 直接污染统计）
    ///   - 无脑信 X-Real-IP → 多层下变成内网跳，统计全坍缩到一个代理 IP
    ///
    /// 正确做法（可信代理链解析）：把 XFF 从「最右」向左扫，跳过内网/回环/CGNAT 等可信反代跳，
    /// 第一个公网地址就是最外层可信反代记录的真实客户端 —— 既穿透多层代理，又防伪造
    /// （伪造值只能塞在链最左，右侧必有反代追加的真实段，扫不到伪造段）。
    /// 全是内网（纯内网访问）时回退到 XFF 首段 / X-Real-IP / RemoteIpAddress。
    /// IPv4-mapped IPv6（::ffff:1.2.3.4）统一规整回点分十进制。
    /// 注：内网段即视为可信代理，未维护精确可信 IP 白名单；仅用于访问统计/审计展示，不作安全判定。
    /// </summary>
    public static string? GetRealClientIp(this HttpContext context)
    {
        var xff = context.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(xff))
        {
            var parts = xff.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            // 从右向左找第一个公网 IP（最外层可信反代填入的真实客户端）
            for (var i = parts.Length - 1; i >= 0; i--)
            {
                var norm = NormalizeIp(parts[i]);
                if (IsPublicIp(norm)) return norm;
            }
            // 全是内网（纯内网/LAN/VPN 部署）：绝不回退到 XFF 最左段——那是客户端自带、可伪造
            // （`X-Forwarded-For: 10.0.0.123` 也能污染统计）。直接 fall through 到代理覆盖写的
            // X-Real-IP / socket 地址，两者都不可被客户端伪造。
        }

        // X-Real-IP：反代用 $remote_addr 覆盖写，客户端不可伪造（多层下是内网跳，但仍是可信值）
        var xRealIp = context.Request.Headers["X-Real-IP"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(xRealIp))
            return NormalizeIp(xRealIp.Trim());

        return NormalizeIp(context.Connection.RemoteIpAddress?.ToString());
    }

    // 是否公网 IP（用于在 XFF 链里区分「真实客户端」与「内网反代跳」）。
    // 排除：回环、私有段（10/8、172.16-31、192.168/16）、链路本地（169.254/16、fe80::/10）、
    // CGNAT（100.64/10）、ULA（fc00::/7）、0.0.0.0/8。
    private static bool IsPublicIp(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip) || !IPAddress.TryParse(ip, out var addr)) return false;
        if (addr.IsIPv4MappedToIPv6) addr = addr.MapToIPv4();
        if (IPAddress.IsLoopback(addr)) return false;
        var b = addr.GetAddressBytes();
        if (addr.AddressFamily == AddressFamily.InterNetwork)
        {
            if (b[0] == 0 || b[0] == 10 || b[0] == 127) return false;
            if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return false;
            if (b[0] == 192 && b[1] == 168) return false;
            if (b[0] == 169 && b[1] == 254) return false;
            if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return false;
            return true;
        }
        if (addr.IsIPv6LinkLocal || addr.IsIPv6SiteLocal) return false;
        if ((b[0] & 0xFE) == 0xFC) return false; // ULA fc00::/7
        return true;
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
