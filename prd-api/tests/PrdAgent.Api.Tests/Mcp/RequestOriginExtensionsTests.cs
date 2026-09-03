using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 「用户实际访问的那个地址」怎么算出来。
///
/// 这条判据坏掉不会红：接入台照常渲染，只是把一条 http:// 的连接地址塞进用户的客户端配置，
/// 他照着配、连不上、也不知道为什么。所以必须钉住 —— 尤其钉住**本仓库真实的 nginx 形态**：
/// `deploy/nginx/nginx.conf` 设 `Host $host` 与 `X-Forwarded-Proto $scheme`，从不设 `X-Forwarded-Host`。
///
/// 同一条事实还有第二个后果，也在这里钉住：nginx 既然不覆盖 X-Forwarded-Host，那它就是外部调用方
/// 能随便填的。主机名一旦采信它，分享链与调用记录里的产物地址就会指向攻击者选的域名，而这些地址
/// 主人日后会从接入台点开。所以主机只认被 nginx 清洗过的 Request.Host，唯一例外是网关自己的回环
/// 续跳（凭进程内令牌自证）。
/// </summary>
public class RequestOriginExtensionsTests
{
    /// <summary>普通外部请求：进程里注册了令牌服务，但请求没带令牌。</summary>
    private static HttpRequest Request(string scheme, string host, params (string Key, string Value)[] headers)
        => Build(scheme, host, loopbackToken: null, headers);

    /// <summary>网关自己的回环续跳：带上本进程令牌。</summary>
    private static HttpRequest LoopbackRequest(string scheme, string host, params (string Key, string Value)[] headers)
        => Build(scheme, host, loopbackToken: Signal.Token, headers);

    private static readonly McpLoopbackSignal Signal = new();

    private static HttpRequest Build(
        string scheme, string host, string? loopbackToken, (string Key, string Value)[] headers)
    {
        var services = new ServiceCollection();
        services.AddSingleton(Signal);
        var ctx = new DefaultHttpContext { RequestServices = services.BuildServiceProvider() };
        ctx.Request.Scheme = scheme;
        ctx.Request.Host = new HostString(host);
        foreach (var (k, v) in headers) ctx.Request.Headers[k] = v;
        if (loopbackToken != null) ctx.Request.Headers[McpLoopbackSignal.HeaderName] = loopbackToken;
        return ctx.Request;
    }

    [Fact]
    public void 本仓库真实的_nginx_形态_只有_Proto_没有_ForwardedHost_也要给出_https()
    {
        // 这是事故形状本身：上一版要求先有 X-Forwarded-Host 才读 X-Forwarded-Proto，
        // 而 nginx 从不设前者，同源 GET 又没有 Origin —— 于是回了 http。
        var req = Request("http", "mcp-demo.miduo.org", ("X-Forwarded-Proto", "https"));

        req.ResolveExternalBaseUrl().ShouldBe("https://mcp-demo.miduo.org");
    }

    [Fact]
    public void 外部请求填的_ForwardedHost_一律不采信()
    {
        // 攻击面：nginx 不覆盖这个头，外部 MCP 调用方可以随便填。采信它就等于让分享链和
        // 调用记录里的产物地址指向攻击者选的域名，而主人日后会从接入台点开那条地址。
        var req = Request("http", "mcp-demo.miduo.org",
            ("X-Forwarded-Proto", "https"), ("X-Forwarded-Host", "evil.example.com"));

        req.ResolveExternalBaseUrl().ShouldBe("https://mcp-demo.miduo.org");
    }

    [Fact]
    public void 网关回环续跳带令牌时_才采信它带进来的公网主机()
    {
        // 这一跳的 Host 是 127.0.0.1，真正的公网主机由网关放在 X-Forwarded-Host 里带进来。
        // 判据不是「头在不在」，而是「这一跳是不是我们自己发的」——令牌只存在于本进程内存里。
        var req = LoopbackRequest("http", "127.0.0.1:5000",
            ("X-Forwarded-Proto", "https"), ("X-Forwarded-Host", "public.example.com"));

        req.ResolveExternalBaseUrl().ShouldBe("https://public.example.com");
    }

    [Fact]
    public void 别的进程的令牌不算自证()
    {
        var other = new McpLoopbackSignal();
        var req = Request("http", "mcp-demo.miduo.org",
            ("X-Forwarded-Proto", "https"),
            ("X-Forwarded-Host", "evil.example.com"),
            (McpLoopbackSignal.HeaderName, other.Token));

        req.ResolveExternalBaseUrl().ShouldBe("https://mcp-demo.miduo.org");
    }

    [Fact]
    public void 多跳时取最靠近用户的第一段()
    {
        var req = LoopbackRequest("http", "127.0.0.1:5000",
            ("X-Forwarded-Proto", "https, http"), ("X-Forwarded-Host", "public.example.com, inner"));

        req.ResolveExternalBaseUrl().ShouldBe("https://public.example.com");
    }

    [Fact]
    public void Origin_头不参与_它同样由调用方控制()
    {
        var req = Request("http", "mcp-demo.miduo.org", ("Origin", "https://evil.example.com"));

        req.ResolveExternalBaseUrl().ShouldBe("http://mcp-demo.miduo.org");
    }

    [Fact]
    public void 什么都没有时退回请求自身()
    {
        Request("https", "localhost:5001").ResolveExternalBaseUrl().ShouldBe("https://localhost:5001");
    }
}
