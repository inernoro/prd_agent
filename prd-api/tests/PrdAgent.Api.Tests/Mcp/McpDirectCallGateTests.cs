using System;
using System.Linq;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
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
