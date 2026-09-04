using System.Collections.Generic;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
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

    /// <summary>带上平台/运维声明的公网入口（容器 env 或 appsettings）。</summary>
    private static HttpRequest RequestWithDeclared(
        string scheme, string host, string declaredKey, string declaredValue,
        params (string Key, string Value)[] headers)
        => Build(scheme, host, loopbackToken: null, headers, declared: (declaredKey, declaredValue));

    private static HttpRequest Build(
        string scheme, string host, string? loopbackToken, (string Key, string Value)[] headers,
        (string Key, string Value)? declared = null)
    {
        var services = new ServiceCollection();
        services.AddSingleton(Signal);
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder()
            .AddInMemoryCollection(declared == null
                ? new Dictionary<string, string?>()
                : new Dictionary<string, string?> { [declared.Value.Key] = declared.Value.Value })
            .Build());
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

    [Fact]
    public void CDS_预览里_Host_是回环_必须用平台声明的公网入口()
    {
        // 2026-09-04 真人验收当场抓到的 P1：接入台给出的连接地址是 https://127.0.0.1:48798/api/mcp。
        // 根因是 CDS 转发器故意把 Host 改写成上游 127.0.0.1:port（容器内按 vhost 路由的应用
        // 看不到内部 host 会 404），真域名只在外部可伪造的 X-Forwarded-Host 里。
        // 出路是第三个来源：平台注入的 CDS_PREVIEW_URL —— 请求方够不着。
        var req = RequestWithDeclared("http", "127.0.0.1:48798",
            "CDS_PREVIEW_URL", "https://mcp-integration-plan-k7k8od-claude-prd-agent.miduo.org",
            ("X-Forwarded-Host", "evil.example.com"));

        req.ResolveExternalBaseUrl()
            .ShouldBe("https://mcp-integration-plan-k7k8od-claude-prd-agent.miduo.org",
                customMessage: "声明的入口要压过回环 Host，也要压过外部填的 X-Forwarded-Host");
    }

    [Fact]
    public void 运维配的_ServerUrl_优先于平台注入()
    {
        RequestWithDeclared("http", "127.0.0.1:48798", "ServerUrl", "https://map.example.com/")
            .ResolveExternalBaseUrl()
            .ShouldBe("https://map.example.com");
    }

    [Fact]
    public void 声明的入口写歪了就当没配_不许把不是地址的东西发给用户()
    {
        // 只写主机名、写成内网 scheme、写成一句话——都不是能点开的地址。
        RequestOriginExtensions.IsUsableBaseUrl("map.example.com").ShouldBeFalse();
        RequestOriginExtensions.IsUsableBaseUrl("ftp://map.example.com").ShouldBeFalse();
        RequestOriginExtensions.IsUsableBaseUrl("请填写实际值").ShouldBeFalse();
        RequestOriginExtensions.IsUsableBaseUrl("https://map.example.com").ShouldBeTrue();

        // 配歪时退回原来的头部推断，而不是把歪值发出去
        RequestWithDeclared("http", "real.example.com", "CDS_PREVIEW_URL", "请填写实际值",
                ("X-Forwarded-Proto", "https"))
            .ResolveExternalBaseUrl()
            .ShouldBe("https://real.example.com");
    }

    [Fact]
    public void 相对地址补成绝对_绝对地址原样返回()
    {
        var req = RequestWithDeclared("http", "127.0.0.1:48798", "ServerUrl", "https://map.example.com");

        req.ResolveAbsoluteUrl("/local-assets/a/b.png")
            .ShouldBe("https://map.example.com/local-assets/a/b.png");
        req.ResolveAbsoluteUrl("local-assets/a/b.png")
            .ShouldBe("https://map.example.com/local-assets/a/b.png");
        req.ResolveAbsoluteUrl("https://cdn.example.com/x.png")
            .ShouldBe("https://cdn.example.com/x.png");
        req.ResolveAbsoluteUrl(null).ShouldBeNull();
        req.ResolveAbsoluteUrl("   ").ShouldBe("   ");
    }

    [Fact]
    public void 开放层返回给智能体的存储地址_必须过绝对化()
    {
        // 形状 2：这个助手第一次落地时是 WebPages 的私有方法，于是视觉创作与知识库附件
        // 两处兄弟各漏各的。钉住「三处都在用」，下一个漏的会当场红。
        foreach (var path in new[]
                 {
                     "prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesOpenApiController.cs",
                     "prd-api/src/PrdAgent.Api/Controllers/Api/VisualOpenApiController.cs",
                     "prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs",
                 })
            McpSourceGuard.StripComments(McpSourceGuard.Read(path))
                .ShouldContain("ResolveAbsoluteUrl",
                    customMessage: $"{path} 把存储层的相对地址原样回给了智能体，远端客户端点开是 404");
    }

    [Fact]
    public void 分享链写库_不跟调用方的取消令牌走()
    {
        // 与建站那一步同族：写已经提交、驱动才报取消时，用量过滤器会把额度退回去，
        // 重试于是又建/又续一条。这条判据删掉不会红（要让 Mongo 与驱动在同一微秒赛跑）。
        var slice = McpSourceGuard.Slice(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesOpenApiController.cs"),
            "CreateShareWithReuseInfoAsync", "purpose: \"share\"");
        McpSourceGuard.StripComments(slice).ShouldContain("ct: CancellationToken.None",
            customMessage: "分享链写库又跟着 RequestAborted 走了（server-authority）");
    }
}
