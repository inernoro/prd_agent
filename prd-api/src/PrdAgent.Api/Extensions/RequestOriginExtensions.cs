using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services.Mcp;

namespace PrdAgent.Api.Extensions;

/// <summary>
/// 解析「用户实际访问的那个地址」。
///
/// 为什么不能直接用 Request.Scheme：部署形态是 nginx 终止 TLS、以明文 HTTP 转给 Kestrel，
/// 而本仓库没有启用 UseForwardedHeaders。于是 Request.Scheme 恒为 http。
/// 把这种地址回给用户（尤其是让他复制进客户端配置的连接地址）就是给了一条打不通的路。
///
/// **协议与主机分开取，且两者的可信度不一样**：
/// `deploy/nginx/nginx.conf` 每个 location 都设了 `Host $host` 与 `X-Forwarded-Proto $scheme`，
/// 但**从不设 `X-Forwarded-Host`**。这一条事实有两个方向的后果，都踩过：
///
///   1. 上一版把协议判据挂在「有没有 X-Forwarded-Host」上 —— 那个头在真实部署里永远没有，
///      于是协议永远落回 http，等于没修（形状 8：把不成立的证据当成证据）。
///   2. 修完之后又反过来错了一次：既然 nginx 不覆盖 X-Forwarded-Host，那它就是**外部调用方
///      可以随便填的**，而这里让它盖过了被 nginx 清洗过的 Request.Host。后果是分享链、
///      调用记录里的产物地址会指向攻击者选的域名，而这些地址主人日后会从接入台点开。
///
/// **但只认 Request.Host 又栽了第三次**（2026-09-04 真人验收当场发现）：接入台给出的连接地址是
/// `https://127.0.0.1:48798/api/mcp` —— 用户复制进 Claude Code 的那串东西指向回环，功能等于零。
/// 根因在 CDS 转发器（`cds/src/forwarder/proxy-handler.ts`）：它**故意**把 Host 改写成上游的
/// `127.0.0.1:port`（容器内按 vhost 路由的应用看不到内部 host 会 404），并在注释里写明
/// 「原始域名通过 X-Forwarded-Host 暴露给应用」。也就是说，在这套部署里 Request.Host 恒是回环，
/// 真域名只在那个**外部可以伪造**的头里 —— 两条路各自都不安全或不可用。
///
/// 出路是第三个来源：**平台/运维显式声明的公网入口**。它写在容器 env 里，外部调用方碰不到，
/// 也不依赖任何代理是否清洗过头部。CDS 注入 `CDS_PREVIEW_URL`（实测就是本分支的公网地址），
/// 生产用 `ServerUrl` 配置。两者都没有时才退回下面的头部推断。
///
/// 所以现在的取值：
///   0. ServerUrl 配置 ‖ CDS_PREVIEW_URL           （显式声明，外部碰不到，最高优先）
///   协议 = X-Forwarded-Proto ‖ Request.Scheme      （nginx 每个 location 都覆盖它，外部填不进来）
///   主机 = Request.Host                            （nginx 的 `Host $host` 就是公网域名）
///
/// 唯一的例外是**网关自己的回环续跳**：那一跳的 Host 是 127.0.0.1，真正的公网主机由网关放在
/// X-Forwarded-Host 里带进来。这一跳凭 McpLoopbackSignal 的进程内令牌自证（外部无从得知），
/// 所以只在它成立时才采信那个头 —— 判据不是「头在不在」，而是「这一跳是不是我们自己发的」。
///
/// Origin 头不再参与：它同样由调用方控制，而且这套部署里 Request.Host 已经够用。
///
/// 已知债务：同一套判据在 DefectAgentController / DataSyncConsumerController / AdminPeerNodesController
/// 各有一份抄本。新代码一律用这里，那三处收敛属于另一轮的事（判据分裂的老形状，见 debt.platform.md）。
/// </summary>
public static class RequestOriginExtensions
{
    public static string ResolveExternalBaseUrl(this HttpRequest request)
    {
        // 显式声明的公网入口优先。它不是「又一个可以填的头」——是容器 env，
        // 请求方够不着，所以既治得了回环 Host，也不重开伪造的口子。
        var declared = ResolveDeclaredBaseUrl(request);
        if (declared != null) return declared;

        // 逗号分隔时取第一跳（最靠近用户的那一段）
        var proto = First(request.Headers["X-Forwarded-Proto"].FirstOrDefault()) ?? request.Scheme;
        var host = ResolveHost(request);
        return $"{proto}://{host}".TrimEnd('/');
    }

    /// <summary>
    /// 运维/平台显式声明的公网入口。顺序：`ServerUrl`（人配的，最权威）→ `CDS_PREVIEW_URL`（平台注入）。
    ///
    /// 只认能解析成 http/https 绝对地址的值：配歪了（写成主机名、写成内网地址）宁可当没配，
    /// 退回下面的头部推断，也不要把一个语法就不对的东西发给用户当连接地址。
    /// </summary>
    internal static readonly string[] DeclaredBaseUrlKeys = { "ServerUrl", "CDS_PREVIEW_URL" };

    private static string? ResolveDeclaredBaseUrl(HttpRequest request)
    {
        if (request.HttpContext.RequestServices?.GetService(typeof(IConfiguration)) is not IConfiguration config)
            return null;

        foreach (var key in DeclaredBaseUrlKeys)
        {
            var raw = config[key];
            if (string.IsNullOrWhiteSpace(raw)) continue;
            var trimmed = raw.Trim().TrimEnd('/');
            if (IsUsableBaseUrl(trimmed)) return trimmed;
        }
        return null;
    }

    /// <summary>是不是一个能直接发给用户去访问的绝对地址。</summary>
    internal static bool IsUsableBaseUrl(string? value)
        => !string.IsNullOrWhiteSpace(value)
           && Uri.TryCreate(value, UriKind.Absolute, out var uri)
           && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
           && !string.IsNullOrEmpty(uri.Host);

    /// <summary>
    /// 主机只有两个来源：被 nginx 清洗过的 Request.Host，以及网关回环续跳自己带进来的公网主机。
    /// 后者要先验令牌 —— 拿不到令牌服务（没注册 / 非本进程）时一律不采信。
    /// </summary>
    private static string ResolveHost(HttpRequest request)
    {
        var signal = request.HttpContext.RequestServices?.GetService(typeof(McpLoopbackSignal)) as McpLoopbackSignal;
        if (signal != null && signal.IsGatewayContinuation(request))
        {
            var forwarded = First(request.Headers["X-Forwarded-Host"].FirstOrDefault());
            if (forwarded != null) return forwarded;
        }
        return request.Host.Value;
    }

    private static string? First(string? headerValue)
    {
        if (string.IsNullOrWhiteSpace(headerValue)) return null;
        var v = headerValue.Split(',')[0].Trim();
        return v.Length == 0 ? null : v;
    }
}
