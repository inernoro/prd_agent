using System;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 下游是别人的地盘：登记表里的动态接口想回什么回什么，而它回来的东西会经过两条路
/// 落到我们这边 —— 一条进接入台给普通用户看（ErrorMessage），一条进服务端日志（响应体原文）。
/// 两条都得先过一道，不能因为「形状认得出来」或者「日志是内部的」就原样收下。
///
/// 还有第三件事在这里一起守：登记表能登记 DELETE，而向导底部对用户承诺过
/// 「删除这类收不回来的动作一律不开放给智能体」。承诺兑现在内置工具那边（压根没登记），
/// 动态这条路必须显式挡住，否则用户读到的承诺从另一扇门被绕过去。
/// </summary>
public class McpDownstreamSafetyTests
{
    // ── 破坏性动作不进工具面 ──────────────────────────────────────────

    [Theory]
    [InlineData("DELETE", true)]
    [InlineData("delete", true)]
    [InlineData(" DELETE ", true)]
    [InlineData("GET", false)]
    [InlineData("POST", false)]
    [InlineData("PUT", false)]
    [InlineData("PATCH", false)]
    [InlineData(null, false)]
    public void 删除类动作认得出来(string? method, bool destructive)
        => McpGatewayController.IsDestructiveMethod(method).ShouldBe(destructive);

    [Fact]
    public void 删除类接口就算scope对上也不出现在工具清单里()
    {
        var scopes = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase) { "agent.demo" };
        var del = new AgentOpenEndpoint
        {
            IsActive = true,
            HttpMethod = "DELETE",
            RequiredScopes = new System.Collections.Generic.List<string> { "agent.demo" },
        };
        McpGatewayController.DynamicToolVisible(del, scopes, "u1").ShouldBeFalse(
            "登记表能登记 DELETE，scope 又对得上，于是它会跟普通 agent.* 一起出现在 tools/list 里 —— "
            + "而向导底部对用户写的是「删除这类收不回来的动作一律不开放」");

        del.HttpMethod = "POST";
        McpGatewayController.DynamicToolVisible(del, scopes, "u1").ShouldBeTrue("挡过宽会把正常的写入接口一起关掉");
    }

    /// <summary>
    /// 「看得见」和「调得动」必须走同一个判据。
    ///
    /// tools/call 那条路是按名字直接找登记条目的 —— 它不经过 tools/list。上一版两处各写各的
    /// scope 与白名单判断，于是新增一条限制只加在列举那侧时，结果是「列表里看不见、
    /// 直接按名字调却打得通」，而这种漏法在任何行为测试里都不会红。
    /// </summary>
    [Fact]
    public void 调用那条路也要过同一个可见性判据()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/McpGatewayController.cs"));
        var call = McpSourceGuard.Slice(src, "var match = endpoints.FirstOrDefault", "var isGetDyn");
        call.ShouldContain("IsDestructiveMethod(match.HttpMethod)",
            customMessage: "tools/call 没挡破坏性动作：列表里看不见，按名字直接调却打得通");
        call.ShouldContain("DynamicToolVisible(match",
            customMessage: "tools/call 自己另判一套 scope/白名单，早晚跟 tools/list 漂开");
    }

    // ── 给用户看的失败原因 ────────────────────────────────────────────

    [Theory]
    [InlineData("count 需要在 1-4 之间，收到 9。")]
    [InlineData("这个空间不是你的。")]
    public void 像人话的短句原样端给用户(string msg)
        => McpArtifactExtractor.UserFacing(msg).ShouldBe(msg);

    [Theory]
    // 异常原文与错误页：形状是合法的 error.message，内容却是堆栈
    [InlineData("System.NullReferenceException: Object reference not set to an instance of an object.")]
    [InlineData("Unhandled exception while processing request")]
    [InlineData("<html><head><title>500</title></head>")]
    // 多行几乎只有堆栈和错误页两种来源
    [InlineData("调用失败\n   at Foo.Bar(String s)")]
    // 凭据形状：一个字都不许上面板
    [InlineData("upstream rejected: Authorization: Bearer abc.def.ghi")]
    [InlineData("api_key=sk-live-1234567890 无效")]
    // 内部端点：用户对它无从下手，管理员看日志即可
    [InlineData("connect failed: http://10.0.3.17:8080/internal/v2/render")]
    public void 堆栈凭据与内部地址一律换成固定说法(string msg)
        => McpArtifactExtractor.UserFacing(msg).ShouldBe(McpArtifactExtractor.UnrecognizedFailure,
            customMessage: "认出了 error.message 的形状不等于那段字能端给普通用户看");

    [Fact]
    public void 超长的也不端给用户()
        => McpArtifactExtractor.UserFacing(new string('错', 400))
            .ShouldBe(McpArtifactExtractor.UnrecognizedFailure);

    /// <summary>
    /// 判据只此一处：两个取 message 的分支（error.message 与顶层 message）都得走 UserFacing。
    /// 只改一个的话，下游把细节挪到另一个字段就绕过去了 —— 判据分裂的老形状。
    /// </summary>
    [Fact]
    public void 两个取message的分支都要过同一道()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Services/Mcp/McpArtifactExtractor.cs"));
        var extract = McpSourceGuard.Slice(src, "public static string? ExtractErrorMessage(", "return UnrecognizedFailure;");
        System.Text.RegularExpressions.Regex.Matches(extract, @"UserFacing\(").Count.ShouldBe(2,
            "取 message 的分支不是两处都走 UserFacing —— 下游把细节挪到另一个字段就绕过去了");
        extract.ShouldNotContain("return Trim(msg);",
            customMessage: "又退回「认出形状就当安全」了");
    }

    // ── 进日志的响应体 ────────────────────────────────────────────────

    /// <summary>
    /// 认不出结构的响应体不许整段进日志：那类页面里装着用户内容、带签名的地址、请求细节，
    /// 偶尔还有凭据；一个几 MB 的错误页还会连着放大日志存储。
    /// </summary>
    [Fact]
    public void 响应体进日志前必须收界并擦凭据()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/McpGatewayController.cs"));
        var warn = McpSourceGuard.Slice(src, "回环失败且响应体认不出结构", ");");
        warn.ShouldNotContain(", respBody)",
            customMessage: "整段响应体又进日志了 —— 那里面可能有用户正文、签名地址甚至凭据");
        warn.ShouldContain("BoundedBodyHead(",
            customMessage: "排障要的是「长什么样」，取有界的开头即可");
        warn.ShouldContain("BodyDigest(",
            customMessage: "判「是不是同一种故障」靠指纹，不靠留全文");

        var head = McpSourceGuard.Slice(src, "private static string BoundedBodyHead(", "private static string BodyDigest(");
        head.ShouldContain("CredentialLike.Replace",
            customMessage: "开头这几百字节同样可能带凭据（错误页会把请求头回显出来）");
    }

    // ── 批量条数 ──────────────────────────────────────────────────────

    /// <summary>
    /// 一个 HTTP 请求里能塞多少条 JSON-RPC，必须在开始派发之前就收住。
    ///
    /// 外层限流看到的是「一个请求」，而数组里可以装几千条 tools/call —— 每条都会走一遍
    /// CheckRateAsync，那里是先查 Mongo 拿密钥、再看内存窗口，于是「这一分钟早就超了」
    /// 也拦不住前面那几千次数据库往返。判在循环里没用：进了循环，前面那部分已经打出去了。
    /// </summary>
    [Fact]
    public void 批量条数在派发之前就收住()
    {
        McpGatewayController.MaxBatchItems.ShouldBeInRange(10, 200,
            customMessage: "真实客户端的批量是个位数到十几条，这个上限只用来挡「一个包塞几千条」");

        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/McpGatewayController.cs"));
        var batch = McpSourceGuard.Slice(src, "if (root is JsonArray arr)", "foreach (var item in arr)");
        batch.ShouldContain("arr.Count > MaxBatchItems",
            customMessage: "批量条数没在进循环之前判 —— 判在循环里等于前面那几千条已经打出去了");
    }

    // ── 用不了的钥匙不许报「自检通过」──────────────────────────────

    /// <summary>
    /// 停用、撤销、过了宽限期的钥匙，/api/mcp 在鉴权那一步就直接拒，一个工具也调不动。
    /// 自检要是照着存下来的 scope 算出一串工具名，用户就会拿着一把作废的钥匙去接，
    /// 接不上还找不着原因。所以先问「还用得了吗」，再算「能看见什么」。
    /// </summary>
    [Fact]
    public void 自检先判钥匙还能不能用再算清单()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/McpConsoleController.cs"));
        // 切到方法末尾（下一个成员的声明），不切到「第一个 return Ok(」——
        // 不可用那条早退本身就是一个 return Ok(，切到它等于把要守的那段全甩在外面。
        var body = McpSourceGuard.Slice(src,
            "public async Task<IActionResult> VisibleTools(",
            "private sealed record VisibleTool(");
        var gate = body.IndexOf("AgentApiKey.IsUsableAt(", StringComparison.Ordinal);
        var compute = body.IndexOf("McpBuiltinTools.All", StringComparison.Ordinal);
        gate.ShouldBeGreaterThan(-1, "自检没判 IsUsableAt：作废的钥匙也会被报成「授权自检通过」");
        compute.ShouldBeGreaterThan(-1, "工具清单的计算不见了，切片锚点要跟着改");
        gate.ShouldBeLessThan(compute,
            "IsUsableAt 判在算清单之后 —— 算都算完了才发现钥匙不能用，等于没判");
        body.ShouldContain("tools = Array.Empty<VisibleTool>()",
            customMessage: "钥匙用不了时还回了工具清单：那串名字对方一个也调不动");
    }
}
