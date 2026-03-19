using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace PrdAgent.Api.Extensions;

/// <summary>
/// HTTP 请求扩展方法。
/// </summary>
public static class HttpRequestExtensions
{
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
