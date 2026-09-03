using Microsoft.AspNetCore.Http;

namespace PrdAgent.Api.Extensions;

/// <summary>
/// 解析「用户实际访问的那个地址」。
///
/// 为什么不能直接用 Request.Scheme/Host：部署形态是 nginx 终止 TLS、以明文 HTTP 转给 Kestrel，
/// 而本仓库没有启用 UseForwardedHeaders。于是 Request.Scheme 恒为 http，Request.Host 可能还是容器内地址。
/// 把这种地址回给用户（尤其是让他复制进客户端配置的连接地址）就是给了一条打不通的路。
///
/// 取值顺序沿用 DefectAgentController.ResolveBaseUrl 早就在用的那套：
/// X-Forwarded-Host/Proto &gt; Origin &gt; Request.Host。
///
/// 已知债务：同一套判据在 DefectAgentController / DataSyncConsumerController / AdminPeerNodesController
/// 各有一份抄本。新代码一律用这里，那三处收敛属于另一轮的事（判据分裂的老形状，见 debt.platform.md）。
/// </summary>
public static class RequestOriginExtensions
{
    public static string ResolveExternalBaseUrl(this HttpRequest request)
    {
        var forwardedHost = request.Headers["X-Forwarded-Host"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(forwardedHost))
        {
            var scheme = request.Headers["X-Forwarded-Proto"].FirstOrDefault();
            if (string.IsNullOrWhiteSpace(scheme)) scheme = "https";
            return $"{scheme.Split(',')[0].Trim()}://{forwardedHost.Split(',')[0].Trim()}".TrimEnd('/');
        }

        var origin = request.Headers.Origin.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(origin))
            return origin.Trim().TrimEnd('/');

        return $"{request.Scheme}://{request.Host}".TrimEnd('/');
    }
}
