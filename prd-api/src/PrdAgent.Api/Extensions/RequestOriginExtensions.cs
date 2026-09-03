using Microsoft.AspNetCore.Http;

namespace PrdAgent.Api.Extensions;

/// <summary>
/// 解析「用户实际访问的那个地址」。
///
/// 为什么不能直接用 Request.Scheme：部署形态是 nginx 终止 TLS、以明文 HTTP 转给 Kestrel，
/// 而本仓库没有启用 UseForwardedHeaders。于是 Request.Scheme 恒为 http。
/// 把这种地址回给用户（尤其是让他复制进客户端配置的连接地址）就是给了一条打不通的路。
///
/// **协议与主机分开取**，不能把协议挂在主机头上：
/// `deploy/nginx/nginx.conf` 每个 location 都设了 `Host $host` 与 `X-Forwarded-Proto $scheme`，
/// 但**从不设 `X-Forwarded-Host`**。上一版写成「有 X-Forwarded-Host 才读 X-Forwarded-Proto，
/// 否则退回 Origin，再否则退回 Request.Scheme」—— 在真实部署里第一支永远进不去；而同源 GET
/// 浏览器不发 Origin，第二支也进不去；于是照样落到 http。判据挂在一个这套部署根本不会出现的
/// 头上，等于没修（`predicate-and-wiring-discipline` 形状 8：把不成立的证据当成证据）。
///
/// 现在的取值：
///   协议 = X-Forwarded-Proto ‖ Origin 的协议 ‖ Request.Scheme
///   主机 = X-Forwarded-Host ‖ Origin 的主机 ‖ Request.Host（nginx 透传的 Host 就是公网域名）
///
/// 已知债务：同一套判据在 DefectAgentController / DataSyncConsumerController / AdminPeerNodesController
/// 各有一份抄本。新代码一律用这里，那三处收敛属于另一轮的事（判据分裂的老形状，见 debt.platform.md）。
/// </summary>
public static class RequestOriginExtensions
{
    public static string ResolveExternalBaseUrl(this HttpRequest request)
    {
        // 逗号分隔时取第一跳（最靠近用户的那一段）
        var proto = First(request.Headers["X-Forwarded-Proto"].FirstOrDefault());
        var host = First(request.Headers["X-Forwarded-Host"].FirstOrDefault());

        var origin = request.Headers.Origin.FirstOrDefault()?.Trim();
        if ((proto == null || host == null)
            && !string.IsNullOrWhiteSpace(origin)
            && Uri.TryCreate(origin, UriKind.Absolute, out var originUri))
        {
            proto ??= originUri.Scheme;
            host ??= originUri.IsDefaultPort ? originUri.Host : $"{originUri.Host}:{originUri.Port}";
        }

        proto ??= request.Scheme;
        host ??= request.Host.Value;

        return $"{proto}://{host}".TrimEnd('/');
    }

    private static string? First(string? headerValue)
    {
        if (string.IsNullOrWhiteSpace(headerValue)) return null;
        var v = headerValue.Split(',')[0].Trim();
        return v.Length == 0 ? null : v;
    }
}
