using System;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Filters;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 直连开放接口时的闸门判据。
///
/// 背景：同一把 sk-ak 有两条路能做同一件事 —— 走 /api/mcp 的 tools/call，或者直接 POST
/// /api/open/visual/images。闸门原先只长在网关里，直连那条路完全没有上限，接入台上写着的
/// 「每日 50 张」对它是假的。堵法是让直连也认出「这一次等价于哪个内置工具」，再套同一套闸门。
///
/// 这几条判据坏掉都不会红：接口照常返回、图照常出，只是额度不扣或者扣两回。
/// </summary>
public class McpDirectCallGateTests
{
    [Fact]
    public void 直连生图接口_能被反查成生图工具()
    {
        var tool = McpBuiltinTools.MatchRequest("POST", "/api/open/visual/images");
        tool.ShouldNotBeNull();
        tool!.Name.ShouldBe("map_visual_generate_image");
        McpUsageService.IsImageTool(tool).ShouldBeTrue();
    }

    [Fact]
    public void 同一条路径不同动词_不算同一个工具()
    {
        // 反查必须带上动词：知识库同一条路径上 POST 建条目、GET 列条目，
        // 只按路径认的话，一次读会被当成写扣额度。
        McpBuiltinTools.MatchRequest("GET", "/api/open/visual/images").ShouldBeNull();
    }

    [Fact]
    public void 网关自身入口不会被反查成工具_否则每次调用扣两回()
    {
        McpBuiltinTools.MatchRequest("POST", "/api/mcp").ShouldBeNull();
    }

    [Fact]
    public void 每个内置工具都反查得回它自己()
    {
        // 接线守卫（形状 2）：新增一条工具时，如果它的路径模板长成反查看不懂的样子，
        // 直连那条路就悄悄没了闸门 —— 没有这条用例的话，全量测试照样全绿。
        foreach (var tool in McpBuiltinTools.All)
        {
            var concrete = ConcretePath(tool.PathTemplate);
            var back = McpBuiltinTools.MatchRequest(tool.Method, concrete);
            back.ShouldNotBeNull($"{tool.Name} 的路径模板 {tool.PathTemplate} 反查不回来");
            // 同一条 (动词, 路径) 只该对应一个工具；反查回别的工具说明注册表里撞车了
            back!.Name.ShouldBe(tool.Name);
        }
    }

    [Fact]
    public void 取用技能是POST但按读计_直连与走网关必须给同一个答案()
    {
        var tool = McpBuiltinTools.All.Single(t => t.Name == "map_market_fork_skill");
        // 网关读 IsWriteTool，直连闸门读的也必须是它，不能自己按动词再判一次
        McpUsageService.IsWriteTool(tool).ShouldBeFalse();
    }

    [Fact]
    public void 生图张数_网关与控制器读同一个收敛区间()
    {
        // 两处各 clamp 一遍的话，上限改动只落一边，闸门占的坑和实际出图数就对不上。
        for (var n = -3; n <= 9; n++)
        {
            var viaGateway = McpGatewayController.ReadRequestedImageCount(
                new JsonObject { ["count"] = n });
            var viaController = VisualOpenApiController.ResolveImageCount(
                new VisualOpenApiController.GenerateImageRequest { Count = n });
            viaGateway.ShouldBe(viaController, customMessage: $"count={n} 时两边不一致");
        }

        McpGatewayController.ReadRequestedImageCount(new JsonObject())
            .ShouldBe(VisualOpenApiController.ResolveImageCount(null));
    }

    [Fact]
    public void 动态工具的登记路径_也能被同一个模板匹配认出来()
    {
        // 动态工具（AgentOpenEndpoint）在网关那条路上是扣写入额度的；直连闸门必须用同一个
        // 匹配器认出它，否则登记表接口在直连这条路上仍是无上限的后门。
        McpBuiltinTools.PathTemplateMatches("/api/report/weekly/generate", "/api/report/weekly/generate")
            .ShouldBeTrue();
        McpBuiltinTools.PathTemplateMatches("/api/report/{id}/publish", "/api/report/abc123/publish")
            .ShouldBeTrue();
        // 段数不同不算命中，占位不许跨段吃
        McpBuiltinTools.PathTemplateMatches("/api/report/{id}", "/api/report/abc123/publish")
            .ShouldBeFalse();
        McpBuiltinTools.PathTemplateMatches("/api/report/weekly", "/api/report/monthly")
            .ShouldBeFalse();
    }

    [Fact]
    public void 回环令牌_只认本进程自己那一份()
    {
        var signal = new McpLoopbackSignal();
        var other = new McpLoopbackSignal();

        signal.IsGatewayContinuation(RequestWith(null)).ShouldBeFalse();
        signal.IsGatewayContinuation(RequestWith("")).ShouldBeFalse();
        signal.IsGatewayContinuation(RequestWith("1")).ShouldBeFalse();
        // 换一个进程的令牌不认：这道判据要挡的正是「外部客户端自称是回环续跳」
        signal.IsGatewayContinuation(RequestWith(other.Token)).ShouldBeFalse();
        signal.IsGatewayContinuation(RequestWith(signal.Token)).ShouldBeTrue();
    }

    private static HttpRequest RequestWith(string? token)
    {
        var ctx = new DefaultHttpContext();
        if (token != null) ctx.Request.Headers[McpLoopbackSignal.HeaderName] = token;
        return ctx.Request;
    }

    /// <summary>把 {xxx} 占位换成一个具体段，模拟真实请求路径。</summary>
    private static string ConcretePath(string template)
    {
        var parts = template.Split('/');
        for (var i = 0; i < parts.Length; i++)
            if (parts[i].Length > 1 && parts[i][0] == '{' && parts[i][^1] == '}')
                parts[i] = "abc123";
        return string.Join('/', parts);
    }
}

/// <summary>
/// 记进审计的 HTTP 状态码。
///
/// 这条坏掉的样子不是报错，是**记录自己说谎**：动作抛出去时结果对象是 null，取默认值就记成
/// HTTP 200，而同一行的状态是「失败」。面板上于是出现「失败 · HTTP 200」，排障的人第一件事
/// 得先怀疑记录本身 —— 一份会撒谎的审计比没有审计更费时间。
/// </summary>
public class McpLoggedStatusTests
{
    [Fact]
    public void 抛出去的调用记成_500_不是_200()
    {
        AgentApiKeyUsageFilter.ResolveLoggedStatus(null, threw: true).ShouldBe(500);
    }

    [Fact]
    public void 正常返回但没带状态码的记成_200()
    {
        AgentApiKeyUsageFilter.ResolveLoggedStatus(null, threw: false).ShouldBe(200);
    }

    [Fact]
    public void 结果自己带了状态码就照它记_异常已被接住的情形()
    {
        // 异常被前面的过滤器接住并换成了一个结果：那个结果才是用户真正收到的东西
        AgentApiKeyUsageFilter.ResolveLoggedStatus(403, threw: true).ShouldBe(403);
        AgentApiKeyUsageFilter.ResolveLoggedStatus(404, threw: false).ShouldBe(404);
    }
}

/// <summary>
/// 匿名端点上的密钥识别。
///
/// 海鲜市场的读端点（搜索 / 详情 / 取用）标了 [AllowAnonymous]，而 ApiKey 是非默认 scheme ——
/// 授权环节不去选它，认证中间件也就不填主体。于是「带钥匙直连这三个端点」在闸门眼里是匿名的：
/// 不进每分钟窗口，也不进调用记录，而这三个端点背后正挂着三个内置工具。
///
/// 补认证只能针对**确实带了 sk-ak- 的请求**：放宽了就等于给全站每个匿名请求都多跑一次认证。
/// 两个方向都要钉，缺哪边都不会红。
/// </summary>
public class McpAgentKeyCredentialDetectionTests
{
    private static HttpRequest RequestWith(string? authorization)
    {
        var ctx = new DefaultHttpContext();
        if (authorization != null) ctx.Request.Headers["Authorization"] = authorization;
        return ctx.Request;
    }

    [Fact]
    public void 带_sk_ak_的_Bearer_要认出来()
    {
        AgentApiKeyUsageFilter.HasAgentKeyCredential(RequestWith("Bearer sk-ak-abc123")).ShouldBeTrue();
        // 大小写不同的 Bearer、以及不带 Bearer 前缀直接给密钥，都算
        AgentApiKeyUsageFilter.HasAgentKeyCredential(RequestWith("bearer sk-ak-abc123")).ShouldBeTrue();
        AgentApiKeyUsageFilter.HasAgentKeyCredential(RequestWith("sk-ak-abc123")).ShouldBeTrue();
    }

    [Fact]
    public void 认证处理器认哪些头_这里就得认哪些()
    {
        // ApiKeyAuthenticationHandler 在 Authorization **整个缺席**时退到 X-AI-Access-Key。
        // 这里少认一个头，就等于「换个写法就绕过闸门」——判据比它该管的范围窄的那个老形状。
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers["X-AI-Access-Key"] = "sk-ak-abc123";
        AgentApiKeyUsageFilter.HasAgentKeyCredential(ctx.Request).ShouldBeTrue();

        // 但顺序也得一样：Authorization 在场时就只看它（处理器正是这么取的），
        // 否则两边对同一个请求给出不同的身份判断。
        var both = new DefaultHttpContext();
        both.Request.Headers["Authorization"] = "Bearer eyJhbGciOiJIUzI1NiJ9.x.y";
        both.Request.Headers["X-AI-Access-Key"] = "sk-ak-abc123";
        AgentApiKeyUsageFilter.HasAgentKeyCredential(both.Request).ShouldBeFalse();
    }

    [Fact]
    public void 审计行不许再从_HttpContext_User_取主人()
    {
        // 匿名端点上 HttpContext.User 是空的（ApiKey 是非默认 scheme，授权环节不选它）。
        // 从它取 boundUserId，记录就写成「没有主人」，而接入台按主人过滤 ——
        // 额度扣了、列表里查无此事。这条判据坏掉不会红：记录照样写进库，只是谁也看不到。
        var source = SourceOf("prd-api/src/PrdAgent.Api/Filters/AgentApiKeyUsageFilter.cs");
        var body = StripComments(source[source.IndexOf("private Task LogAsync", StringComparison.Ordinal)..]);
        body.ShouldNotContain("http.User",
            customMessage: "审计行要用闸门认出来的那个主体，不是 HttpContext.User");
    }

    /// <summary>
    /// 扫源码前先去掉注释行。
    ///
    /// 第一版没去，于是被守的那处**注释里**写着「不是 http.User」这几个字，守卫立刻判红 ——
    /// 判据读到了一个真实存在的字符串，只是它不是真正生效的那个东西（形状 6）。
    /// 一条会因为解释文字而变红的守卫，下一个人只会把注释改掉，而不是把代码改对。
    /// </summary>
    private static string StripComments(string source) => string.Join('\n',
        source.Split('\n').Where(line => !line.TrimStart().StartsWith("//", StringComparison.Ordinal)));

    private static string SourceOf(string repoRelativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))) dir = dir.Parent;
        dir.ShouldNotBeNull("找不到仓库根，无法做源码守卫");
        var full = Path.Combine(dir!.FullName, repoRelativePath);
        File.Exists(full).ShouldBeTrue($"被守的文件不在了：{repoRelativePath}");
        return File.ReadAllText(full);
    }

    [Fact]
    public void 别的凭据形态一律不补认证()
    {
        // JWT 会话：它走默认 scheme，本来就有主体，不需要这条路
        AgentApiKeyUsageFilter.HasAgentKeyCredential(RequestWith("Bearer eyJhbGciOiJIUzI1NiJ9.x.y")).ShouldBeFalse();
        // 旧版 sk-{32} App key 与平台访问钥匙都不是接入台的密钥
        AgentApiKeyUsageFilter.HasAgentKeyCredential(RequestWith("Bearer sk-0123456789abcdef")).ShouldBeFalse();
        AgentApiKeyUsageFilter.HasAgentKeyCredential(RequestWith(null)).ShouldBeFalse();
        AgentApiKeyUsageFilter.HasAgentKeyCredential(RequestWith("")).ShouldBeFalse();
    }
}
