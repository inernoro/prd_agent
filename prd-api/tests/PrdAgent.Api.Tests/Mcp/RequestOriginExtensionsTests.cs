using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Extensions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 「用户实际访问的那个地址」怎么算出来。
///
/// 这条判据坏掉不会红：接入台照常渲染，只是把一条 http:// 的连接地址塞进用户的客户端配置，
/// 他照着配、连不上、也不知道为什么。所以必须钉住 —— 尤其钉住**本仓库真实的 nginx 形态**：
/// `deploy/nginx/nginx.conf` 设 `Host $host` 与 `X-Forwarded-Proto $scheme`，从不设 `X-Forwarded-Host`。
/// </summary>
public class RequestOriginExtensionsTests
{
    private static HttpRequest Request(string scheme, string host, params (string Key, string Value)[] headers)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Scheme = scheme;
        ctx.Request.Host = new HostString(host);
        foreach (var (k, v) in headers) ctx.Request.Headers[k] = v;
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
    public void 有_ForwardedHost_时以它为准()
    {
        var req = Request("http", "api:8080",
            ("X-Forwarded-Proto", "https"), ("X-Forwarded-Host", "public.example.com"));

        req.ResolveExternalBaseUrl().ShouldBe("https://public.example.com");
    }

    [Fact]
    public void 多跳时取最靠近用户的第一段()
    {
        var req = Request("http", "api:8080",
            ("X-Forwarded-Proto", "https, http"), ("X-Forwarded-Host", "public.example.com, inner"));

        req.ResolveExternalBaseUrl().ShouldBe("https://public.example.com");
    }

    [Fact]
    public void 没有转发头时退回_Origin()
    {
        var req = Request("http", "api:8080", ("Origin", "https://from-origin.example.com"));

        req.ResolveExternalBaseUrl().ShouldBe("https://from-origin.example.com");
    }

    [Fact]
    public void 什么都没有时退回请求自身()
    {
        Request("https", "localhost:5001").ResolveExternalBaseUrl().ShouldBe("https://localhost:5001");
    }
}
