using System;
using System.IO;
using PrdAgent.Api.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 「收不回来的动作不给智能体」这句承诺的判据。
///
/// 它要挡的是**两条路**：走网关的登记接口，和拿同一把 sk-ak 直连业务控制器。
/// 后者是这一轮 review 抓出来的真实缺口 —— 持 web-pages:write 的钥匙
/// 能调 DELETE /api/web-pages/{id}，把主人的站点删掉。
/// </summary>
public class McpDestructiveActionsTests
{
    [Theory]
    [InlineData("DELETE")]
    [InlineData("delete")]
    [InlineData(" DELETE ")]
    public void DELETE_一律算破坏性(string method)
        => McpDestructiveActions.IsDestructiveMethod(method).ShouldBeTrue();

    [Theory]
    [InlineData("GET")]
    [InlineData("POST")]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData(null)]
    public void 其余方法本身不算(string? method)
        => McpDestructiveActions.IsDestructiveMethod(method).ShouldBeFalse();

    /// <summary>这一轮 review 点名的那几条真实路由。</summary>
    [Theory]
    [InlineData("DELETE", "/api/web-pages/abc123")]
    [InlineData("DELETE", "/api/document-store/stores/s1")]
    [InlineData("POST", "/api/web-pages/batch-delete")]
    [InlineData("POST", "/api/web-pages/batch-delete/")]
    public void 真实的破坏性请求都挡得住(string method, string path)
        => McpDestructiveActions.IsDestructiveRequest(method, path).ShouldBeTrue(
            customMessage: $"{method} {path} 没挡住 —— 接入向导承诺过删除不开放给智能体");

    /// <summary>
    /// 判据认的是**最后一段**，不是「路径里含 delete 字样」。
    /// 模糊匹配会误伤查询路由，而那种误伤同样是「说好能用却调不动」。
    /// </summary>
    [Theory]
    [InlineData("GET", "/api/web-pages/deleted-items")]
    [InlineData("POST", "/api/web-pages/publish")]
    [InlineData("GET", "/api/document-store/stores/s1")]
    [InlineData("POST", "/api/mcp")]
    [InlineData("POST", "/api/web-pages/batch-delete-preview")]
    public void 正常请求不被误挡(string method, string path)
        => McpDestructiveActions.IsDestructiveRequest(method, path).ShouldBeFalse(
            customMessage: $"{method} {path} 被误挡了");

    [Fact]
    public void 查询串不混进段名()
        => McpDestructiveActions.IsDestructiveRequest("POST", "/api/web-pages/batch-delete?dry=1")
            .ShouldBeTrue(customMessage: "带查询串就绕过了这道门");

    /// <summary>
    /// 两条路都必须走这一处判据。
    ///
    /// 这条接线删掉不会红：网关自己写一份、middleware 再写一份，照样编译、照样全绿，
    /// 只有真的拿 sk-ak 去打 DELETE 才现形 —— 而那正是这一轮 review 抓到的缺口。
    /// </summary>
    [Theory]
    [InlineData("src/PrdAgent.Api/Controllers/McpGatewayController.cs")]
    [InlineData("src/PrdAgent.Api/Middleware/AdminPermissionMiddleware.cs")]
    public void 网关与直连两条路共用同一处判据(string relative)
    {
        // 定位方式与 AgentApiKeyScopeModeTests.ReadSource 一致：往上找 PrdAgent.sln
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
            dir = dir.Parent;
        dir.ShouldNotBeNull(customMessage: "没找到 PrdAgent.sln，测试定位不到源码");

        var file = Path.Combine(dir!.FullName, relative);
        File.Exists(file).ShouldBeTrue(customMessage: $"源码不存在：{file}");
        File.ReadAllText(file).ShouldContain("McpDestructiveActions",
            customMessage: $"{relative} 没走共用判据，自己判 DELETE 就是下一次漂移的起点");
    }
}
