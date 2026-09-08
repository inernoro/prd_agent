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
    // 承诺的另一半：公开发布。上一版只兑现了「删除」那半句。
    [InlineData("POST", "/api/literary-agent/prompts/p1/publish")]
    [InlineData("POST", "/api/watermarks/w1/publish")]
    [InlineData("PUT", "/api/ai-toolbox/items/i1/publish")]
    [InlineData("POST", "/api/document-store/entries/e1/creative-publish")]
    public void 真实的破坏性请求都挡得住(string method, string path)
        => McpDestructiveActions.IsDestructiveRequest(method, path).ShouldBeTrue(
            customMessage: $"{method} {path} 没挡住 —— 接入向导承诺过删除不开放给智能体");

    /// <summary>
    /// 判据认的是**最后一段**，不是「路径里含 delete 字样」。
    /// 模糊匹配会误伤查询路由，而那种误伤同样是「说好能用却调不动」。
    /// </summary>
    [Theory]
    [InlineData("GET", "/api/web-pages/deleted-items")]
    [InlineData("GET", "/api/document-store/stores/s1")]
    [InlineData("POST", "/api/mcp")]
    [InlineData("POST", "/api/web-pages/batch-delete-preview")]
    // 内置的「网页托管发布」走的是这条 —— 最后一段是 pages，不该被公开发布那半句误伤
    [InlineData("POST", "/api/open/web-pages/pages")]
    // 分享链按工具说明只对本人与团队可见，不是公开发布
    [InlineData("POST", "/api/open/web-pages/pages/s1/share")]
    // 撤回是把东西收回来，本来就该放行
    [InlineData("POST", "/api/literary-agent/prompts/p1/unpublish")]
    public void 正常请求不被误挡(string method, string path)
        => McpDestructiveActions.IsDestructiveRequest(method, path).ShouldBeFalse(
            customMessage: $"{method} {path} 被误挡了");

    /// <summary>
    /// 规范化的**顺序**：先摘查询串/锚点，再去尾斜杠。
    ///
    /// 反过来写也能过掉最朴素的那条（<c>/batch-delete?dry=1</c>），但尾斜杠一加就露馅：
    /// <c>/batch-delete/?dry=1</c> 去完尾斜杠什么都没少，最后一段被切成 <c>?dry=1</c>，
    /// 整条从门下溜过去。两句都在、编译过、单条用例还是绿的 —— 只有把两种写法凑在一起才现形。
    /// </summary>
    [Theory]
    [InlineData("/api/web-pages/batch-delete?dry=1")]
    [InlineData("/api/web-pages/batch-delete/?dry=1")]
    [InlineData("/api/web-pages/batch-delete/?a=1&b=2")]
    [InlineData("/api/web-pages/batch-delete#frag")]
    [InlineData("/api/literary-agent/prompts/p1/publish/?force=1")]
    public void 查询串与尾斜杠凑一起也绕不过去(string path)
        => McpDestructiveActions.IsDestructiveRequest("POST", path)
            .ShouldBeTrue(customMessage: $"{path} 绕过了这道门 —— 规范化的顺序反了");

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

    /// <summary>
    /// 开放层是**给 sk-ak 走的受控接口**，直连那道门不该管到它头上。
    ///
    /// 上一版没有这条豁免，后果是真的：<c>llmgw/tutorial/publisher.py</c> 用
    /// <c>MAP_DOC_STORE_KEY</c>（sk-ak 前缀 → authType=agent-apikey）打
    /// <c>POST .../tutorial-link-graph/publish</c> 发布教程双链图谱，
    /// 失败时用 <c>DELETE .../nodes/&#123;sourceId&#125;</c> 回滚 —— 两条一起 403，
    /// 发布断了、连回滚也断了。判据太宽的代价从来不是「多挡一点」，是打断真实流水线。
    /// </summary>
    [Theory]
    [InlineData("/api/open/document-store/publisher/stores/s1/tutorial-link-graph/publish")]
    [InlineData("/api/open/document-store/publisher/stores/s1/nodes/n1")]
    [InlineData("/api/open/web-pages/pages/s1")]
    [InlineData("/API/OPEN/document-store/stores/s1")]
    public void 开放层的路不归这道门管(string path)
        => McpDestructiveActions.IsCuratedOpenApiPath(path).ShouldBeTrue(
            customMessage: $"{path} 被当成普通业务路由 —— 开放层是给 sk-ak 走的受控接口，"
                + "挡它等于打断 publisher.py 的发布与回滚");

    /// <summary>
    /// **结尾那个斜杠是判据的一部分。**
    ///
    /// <c>/api/open-platform/</c> 与 <c>/api/open-api/</c> 是三个挂 <c>[AdminController]</c>
    /// 的后台控制器，跟开放层没有关系。写成 <c>StartsWith("/api/open")</c> 会把
    /// <c>DELETE /api/open-platform/apps/&#123;id&#125;</c> 一起放行 —— 前缀判据的经典漏法
    /// （形状 1：语义上不同的输入被判成同一类）。
    /// </summary>
    [Theory]
    [InlineData("/api/open-platform/apps/a1")]
    [InlineData("/api/open-platform/app-callers/c1")]
    [InlineData("/api/open-api/keys/k1")]
    [InlineData("/api/web-pages/w1")]
    [InlineData("/api/openbook/x")]
    [InlineData(null)]
    public void 名字里带open但不是开放层的_照旧归这道门管(string? path)
        => McpDestructiveActions.IsCuratedOpenApiPath(path).ShouldBeFalse(
            customMessage: $"{path} 被误当成开放层放行了 —— 前缀少了结尾那个斜杠");

    /// <summary>
    /// 豁免只挂在直连那道门上，不挂进判据本身。
    ///
    /// 两者回答的是不同问题：<c>IsDestructiveRequest</c> 答「这个动作收不收得回来」，
    /// <c>IsCuratedOpenApiPath</c> 答「这条路是不是给 API key 走的」。网关那条路
    /// 只问前者（它管的是 MCP 工具面，而向导那句承诺说的正是工具面），
    /// 直连那道门两个一起问。把豁免揉进判据本身，网关那侧会跟着一起松掉。
    /// </summary>
    [Fact]
    public void 开放层的删除本身仍算破坏性()
        => McpDestructiveActions.IsDestructiveRequest(
                "DELETE", "/api/open/document-store/publisher/stores/s1/nodes/n1")
            .ShouldBeTrue(customMessage: "豁免被揉进了判据本身 —— 网关那侧会跟着一起松掉");

    /// <summary>
    /// 直连那道门必须**同时**问过这两件事。
    ///
    /// 少问哪一个都不会红：只问破坏性 → publisher.py 断（上一版）；
    /// 只问开放层 → 普通业务控制器的 DELETE 全放行（第 26 轮那个缺口回来）。
    /// </summary>
    [Fact]
    public void 直连那道门两个判据都要问()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Middleware/AdminPermissionMiddleware.cs"));
        var invoke = src[src.IndexOf("public async Task Invoke(", StringComparison.Ordinal)..];
        var gate = McpSourceGuard.Slice(invoke, "var isAgentKey =", "var dip =");
        gate.ShouldContain("IsCuratedOpenApiPath(path)",
            customMessage: "没问「这条路是不是开放层」—— publisher.py 的发布与回滚会一起 403");
        gate.ShouldContain("IsDestructiveRequest(method, path)",
            customMessage: "没问「这个动作收不收得回来」—— 第 26 轮那个缺口回来了");
    }

    /// <summary>
    /// 直连那道门必须排在**权限扫描的早退之前**。
    ///
    /// 上一版把它写在 <c>isAgentKey</c> 分支里，而那整段在
    /// <c>if (required == null) { await _next(context); return; }</c> 之后 ——
    /// 只挂 <c>[Authorize(AuthenticationSchemes = "ApiKey")] + [RequireScope]</c>、
    /// 没有 <c>[AdminController]</c> 标记的控制器，扫描器给不出 required，
    /// 请求在门开之前就走掉了。判据本身没写错，取值的时刻错了（形状 5）。
    ///
    /// 顺序这种事删掉不会红：两段都在、编译过、上面那些用例照样绿，
    /// 只有真拿 sk-ak 去打一条非 AdminController 的 DELETE 才现形。
    /// </summary>
    [Fact]
    public void 直连那道门排在权限扫描早退之前()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Middleware/AdminPermissionMiddleware.cs"));
        var invoke = src.IndexOf("public async Task Invoke(", StringComparison.Ordinal);
        invoke.ShouldBeGreaterThan(-1, "Invoke 不见了，守卫的锚点要跟着改");

        var body = src[invoke..];
        var gate = body.IndexOf("McpDestructiveActions.IsDestructiveRequest(", StringComparison.Ordinal);
        var earlyReturn = body.IndexOf("if (required == null)", StringComparison.Ordinal);
        gate.ShouldBeGreaterThan(-1, "Invoke 里没有这道门 —— 直连那条路又只剩 scope 一层了");
        earlyReturn.ShouldBeGreaterThan(-1, "权限扫描的早退不见了，守卫的锚点要跟着改");
        gate.ShouldBeLessThan(earlyReturn,
            "这道门排在了 required == null 早退之后 —— 非 AdminController 的控制器根本走不到它，"
            + "DELETE /api/open/document-store/... 照旧打得通");
    }

    /// <summary>
    /// 光「用了这个类」还不够，得用**带路径**的那个。
    ///
    /// 上一版守卫只断言文件里出现 <c>McpDestructiveActions</c>，而网关当时转调的是
    /// <c>IsDestructiveMethod</c>（只认 DELETE）—— 类共用了，判据没共用，
    /// 于是登记成 <c>POST /api/web-pages/batch-delete</c> 的接口照样列得出、调得动。
    /// 守卫在场却一点忙没帮上，因为它断言的东西太弱。
    /// </summary>
    [Theory]
    [InlineData("src/PrdAgent.Api/Controllers/McpGatewayController.cs")]
    [InlineData("src/PrdAgent.Api/Middleware/AdminPermissionMiddleware.cs")]
    public void 两条路都用带路径的判据_不是只看方法(string relative)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
            dir = dir.Parent;
        dir.ShouldNotBeNull(customMessage: "没找到 PrdAgent.sln，测试定位不到源码");

        var text = File.ReadAllText(Path.Combine(dir!.FullName, relative));
        text.ShouldContain("IsDestructiveRequest",
            customMessage: $"{relative} 只看 HTTP 方法 —— 登记表与业务路由都收任意 POST 路径，"
                + "POST /api/web-pages/batch-delete 会从这里漏过去");
    }
}
