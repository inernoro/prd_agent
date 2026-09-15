using System;
using System.Linq;
using System.Text.RegularExpressions;
using static PrdAgent.Api.Tests.Middleware.RequestLogRedactionProbe;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 智能体这两条路的请求体不许进 apirequestlogs。
///
/// 为什么它比「日志多存一份」严重：这两条路的请求体**就是用户的私人内容本身** ——
/// 一整篇小说正文、一篇知识库文档、一整页要托管的 HTML。而 apirequestlogs 与生产
/// 共用同一个 Mongo（cross-project-isolation 通道 4），日志页里还会把它拼成一条
/// 可以直接复制去重放的 curl。中间件那个清理器只按键名摘 prompt / message，
/// `content` / `htmlContent` 原样留着；body 一超长更是整段退回原文。
///
/// 守卫为什么要枚举而不是点名两条前缀：开放层每加一个控制器就是一条新的 `api/open/*`
/// 路由，而漏登记不会红 —— 正是形状 3 的老形状（判据散在别处、靠人记得同步）。
/// 所以这里从控制器自己的 [Route] 反推出全部开放层路由，再逐条问中间件那个**真正
/// 生效的判据**：你挡不挡它。新增一个开放层控制器时它自动进闸。
///
/// 判据取的是运行时求值（反射调私有静态方法），不是扫源码里那张清单的字面量 ——
/// 清单在、匹配写错（裸前缀把邻居一起收走）的情况，扫字面量看不出来（形状 6）。
/// </summary>
public class McpBodyCaptureExclusionTests
{
    /// <summary>从控制器源码里反推出「开放层」的全部路由前缀。</summary>
    private static string[] OpenLayerRoutes() => McpSourceGuard
        .EnumerateRelative("prd-api/src/PrdAgent.Api/Controllers/Api", "*OpenApiController.cs")
        .Select(McpSourceGuard.Read)
        .Select(src => Regex.Match(src, @"\[Route\(""(?<r>[^""]+)""\)\]").Groups["r"].Value)
        // `api/open-api` 是后台管理页（JWT + 管理员权限），不是智能体开放层，别把它一起收了。
        .Where(r => r.StartsWith("api/open/", StringComparison.Ordinal))
        .ToArray();

    [Fact]
    public void 开放层与MCP网关的请求体不许落进接口日志()
    {
        var routes = OpenLayerRoutes();
        routes.Length.ShouldBeGreaterThan(3, "开放层控制器一个都没枚举到，守卫等于空转");

        foreach (var route in routes)
            CarriesCredential("/" + route + "/anything").ShouldBeTrue(
                $"开放层路由 {route} 没被挡住：它的请求体是用户的正文/文档/整页 HTML，会原样落进与生产共用的接口日志");

        // 网关那条路同理：tools/call 的 arguments 里装的是同一批内容。
        CarriesCredential("/api/mcp").ShouldBeTrue();
        CarriesCredential("/api/mcp/anything").ShouldBeTrue();
    }

    /// <summary>
    /// 反向一条：别为了省事把整个 `/api/` 收进去。挡得过宽，等于把所有端点的排障能力
    /// 一起关掉，而那不是这次要解决的问题。
    /// </summary>
    [Fact]
    public void 不许挡过宽()
    {
        CarriesCredential("/api/open-api/keys").ShouldBeFalse("后台管理页不该被顺手挡掉");
        CarriesCredential("/api/documents").ShouldBeFalse();
        CarriesCredential("/api/mcp-console/calls").ShouldBeFalse("接入台面板自己是普通后台接口");
    }
}
