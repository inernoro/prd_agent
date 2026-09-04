using System;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
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
    // 凭据词换个分隔符就绕过去了：上一版列了 `token=` 却没列 `token:`
    [InlineData("upstream rejected: access token: ghp_16C7e42F292c6912E7710c838347Ae178B4a")]
    [InlineData("api key: abcdef 无效")]
    // 短到长度闸拦不住的固定开头（sk-live-… 只有 18 个字符）
    [InlineData("上游拒绝了 sk-live-1234567890")]
    [InlineData("密钥已过期")]
    [InlineData("Secret 不匹配")]
    // 不像人话的长串：JWT、摘要、随机 id 都是这个形状
    [InlineData("拒绝：eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")]
    [InlineData("校验失败 9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c")]
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

    // ── 带条件的语句，写完要看结果 ────────────────────────────────

    /// <summary>
    /// 摘标记的那几条语句都带了条件（MineFilter），但「带条件」和「看结果」是两件事：
    /// 写了一条只在特定条件下才生效的更新，却不看它到底生没生效，那个条件就只是装饰。
    ///
    /// 收尾兜底那一处尤其致命：匹配为 0 意味着标记还挂在库里，而接口照样回成功 ——
    /// 之后同一个 clientRequestId 的每一次重试都会撞 ENTRY_WRITE_IN_PROGRESS，
    /// 这条记录再没人收得了尾。
    /// </summary>
    [Fact]
    public void 兜底摘标记要看有没有摘掉()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        var tail = McpSourceGuard.Slice(src, "if (!IsMyGeneration(latest, generation))", "summaryApplied = explicitSummary == null;");
        tail.ShouldContain("cleared.MatchedCount == 0",
            customMessage: "兜底那次摘标记的结果没看：匹配为 0 时标记还挂着，接口却回成功，同键重试从此永远撞 409");
        tail.ShouldContain("ENTRY_CHANGED_SINCE_CREATE",
            customMessage: "重试仍摘不掉时要如实回冲突，不能原地打转、更不能谎报成功");
    }

    // ── 审计行的时刻 ──────────────────────────────────────────────

    /// <summary>
    /// 直连那条路的审计行必须记「发起时刻」，不是「完成时刻」。
    ///
    /// 额度是在调用开始时扣的，审计行若记完成时刻，跨 UTC 午夜的那一笔就会分到两天：
    /// 额度算在前一天的计数器上，记录落在新的一天，接入台按天聚合时「今天调了几次」
    /// 与「今天写了几次 / 出了几张图」对不上——两个数都不对，用户无从判断哪个是真的。
    /// 网关那条路本来就在派发前取时刻，这条守卫钉住两条路同一个口径。
    /// </summary>
    [Fact]
    public void 直连审计行记的是发起时刻()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Filters/AgentApiKeyUsageFilter.cs"));
        var invoked = src.IndexOf("var invokedAt = DateTime.UtcNow;", StringComparison.Ordinal);
        // 锚在真正那次派发上：前面还有两处早退路径也写着 await next()。
        var dispatch = src.IndexOf("var executed = await next();", StringComparison.Ordinal);
        invoked.ShouldBeGreaterThan(-1, "没有在派发前取墙钟：CreatedAt 会退回模型默认，记成完成时刻");
        dispatch.ShouldBeGreaterThan(-1, "派发点不见了，切片锚点要跟着改");
        invoked.ShouldBeLessThan(dispatch, "墙钟取在派发之后 —— 那就还是完成时刻");

        var log = McpSourceGuard.Slice(src, "_usage.LogAsync(new McpCallLog", "}, CancellationToken.None);");
        log.ShouldContain("CreatedAt = invokedAt",
            customMessage: "审计行没显式落发起时刻，会走模型默认（= 构造这个对象的时刻 = 调用完成之后）");
    }

    /// <summary>
    /// 撤回那处摘标记同样要看结果，而且结论不能拿过期快照下。
    ///
    /// 它是照着 `current` 那份回读快照判「正文到底提交没提交」的，而快照到写之间还有窗口：
    /// 匹配为 0 时那条已经又变了 —— 可能被删（于是 KeptCommitted 变成「为一条已经不在的
    /// 条目报成功」），也可能只是被再改一次（标记还挂着，同键重试从此一直撞 409）。
    /// 收尾兜底那处刚修过同一个形状，这处是它的兄弟。
    /// </summary>
    [Fact]
    public void 撤回摘标记也要看有没有摘掉()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        var body = McpSourceGuard.Slice(src, "var holdsMine = await HoldsRequestedContentAsync(current",
            "return holdsMine ? RollbackOutcome.KeptCommitted");
        body.ShouldContain("cleared.MatchedCount == 0",
            customMessage: "撤回那处摘标记的结果没看：匹配为 0 时结论还是照过期快照下的");
        body.ShouldContain("RollbackOutcome.AlreadyGone",
            customMessage: "重读发现不是我那条时要说「已经不在了」，不能仍报 KeptCommitted");
        body.ShouldContain("RollbackOutcome.Retained",
            customMessage: "反复摘不掉时要按「留了个占位」说 —— 那句话会让调用方换键，而不是去撞 409");
        body.ShouldContain("HoldsRequestedContentAsync(again",
            customMessage: "重读之后结论要按新读到的那份重下，否则还是过期快照");
    }

    /// <summary>
    /// 冲突那处摘标记是三兄弟里的最后一个，同样要看结果。
    ///
    /// 这条路本来就要回 409，所以「摘没摘掉」看着不影响返回码 —— 影响的是那句建议
    /// 能不能走通：标记留着的话，调用方照它说的「读一遍再用同一个键覆盖」重试，
    /// 每一次都会撞 ENTRY_WRITE_IN_PROGRESS。所以摘不掉时必须换一句出路（换键），
    /// 不能把一句走不通的建议照原样发出去。
    /// </summary>
    [Fact]
    public void 冲突出口摘标记也要看有没有摘掉()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreOpenApiController.cs"));
        var body = McpSourceGuard.Slice(src, "if (!IsMyGeneration(still, generation))", "map_kb_update_entry");
        body.ShouldContain("cleared.MatchedCount == 0",
            customMessage: "冲突那处摘标记的结果没看：匹配为 0 时标记还挂着，那句「用同一个键覆盖」的建议就走不通");
        body.ShouldContain("clientRequestId",
            customMessage: "反复摘不掉时要改口让调用方换一个 clientRequestId，别再指引它去撞 409");
    }

    // ── 生图 run 的整条失败 ────────────────────────────────────────

    /// <summary>
    /// 整条 run 在排出任何一张图之前被驳回时，轮询端点必须说得出原因和下一步。
    ///
    /// 这类失败（模型被下架、items 不合法、超上限、服务停机）一张 item 都不会建，
    /// 原因原来只发进 Redis 事件流 —— 而 runs/{runId} 正是我们给智能体的恢复路径，
    /// 它走的是轮询，收不到事件流。于是它拿到 Failed + 空 images，既不知道为什么，
    /// 也不知道该改参数还是该重发。
    /// </summary>
    [Fact]
    public void 整条生图失败要说得出原因和下一步()
    {
        var run = new ImageGenRun
        {
            Status = ImageGenRunStatus.Failed,
            ErrorCode = "VISUAL_MODEL_NOT_ALLOWED",
            ErrorMessage = "所选模型已不在视觉创作允许列表里",
        };
        var failure = VisualOpenApiController.RunFailure(run, itemCount: 0);
        failure.ShouldNotBeNull("一张 item 都没有的失败，原因只能挂在 run 上 —— 这里不给就没别处可给了");
        failure!.Code.ShouldBe("VISUAL_MODEL_NOT_ALLOWED");
        failure.Message.ShouldContain("允许列表");
        failure.NextStep.ShouldNotBeNullOrWhiteSpace("光说失败不说下一步，调用方只会原样重试同一个必然失败的请求");
        // 换个错误码要换一句下一步：参数错了重试多少次都一样，跟服务重启不是一回事。
        VisualOpenApiController.RunFailureNextStep(ErrorCodes.INVALID_FORMAT)
            .ShouldNotBe(VisualOpenApiController.RunFailureNextStep("WORKER_STOPPED"));
    }

    /// <summary>
    /// 这条路上的 errorMessage 有一支直接来自 `ex.Message`（worker 兜底那次），
    /// 原样回出去就是把内部细节递给外部调用方 —— 必须和接入台那条路走同一道脱敏。
    /// </summary>
    [Fact]
    public void 整条生图失败的原因也要脱敏()
    {
        var run = new ImageGenRun
        {
            Status = ImageGenRunStatus.Failed,
            ErrorCode = ErrorCodes.INTERNAL_ERROR,
            ErrorMessage = "System.Net.Http.HttpRequestException: 连不上 https://internal.example.com/v1/images",
        };
        var failure = VisualOpenApiController.RunFailure(run, itemCount: 0);
        failure.ShouldNotBeNull();
        failure!.Message.ShouldBe(McpArtifactExtractor.UnrecognizedFailure,
            "异常原文原样回给了外部调用方");
    }

    /// <summary>
    /// 逐张失败已经在 images[].errorMessage 里说清楚了，run 上不再重复一遍；
    /// 没失败的 run 更不该凭空多出一个 error 字段占调用方的上下文。
    /// </summary>
    [Fact]
    public void 逐张失败与成功的run不重复给整条原因()
    {
        VisualOpenApiController.RunFailure(
            new ImageGenRun { Status = ImageGenRunStatus.Failed }, itemCount: 3).ShouldBeNull();
        VisualOpenApiController.RunFailure(
            new ImageGenRun { Status = ImageGenRunStatus.Completed }, itemCount: 3).ShouldBeNull();
        // 存量 run（本次之前入库的）没有这两个字段，但也没有 item 可看 —— 不许装作知道原因，
        // 也不许干脆不给：给一个明确的「没留下原因」，调用方才知道该问管理员而不是接着轮询。
        var legacy = VisualOpenApiController.RunFailure(
            new ImageGenRun { Status = ImageGenRunStatus.Failed }, itemCount: 0);
        legacy.ShouldNotBeNull();
        legacy!.Code.ShouldBe(ErrorCodes.INTERNAL_ERROR);
    }

    // ── 产物地址的协议 ────────────────────────────────────────────

    /// <summary>
    /// 产物地址是下游给的，而接入台会把它直接放进 `&lt;a href&gt;`。
    /// `javascript:` 与 `data:text/html,` 在 React 18 下并不会被可靠拦住 ——
    /// 于是「点开刚做出来的东西」变成点开对方塞的一段脚本。落库前就该拦掉。
    /// </summary>
    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("JavaScript:alert(1)")]
    [InlineData(" javascript:alert(1)")]
    [InlineData("data:text/html,<script>alert(1)</script>")]
    [InlineData("vbscript:msgbox(1)")]
    [InlineData("file:///etc/passwd")]
    // 协议相对：看着像站内路径，实际跟着当前页协议去了外站
    [InlineData("//evil.example.com/x")]
    [InlineData("")]
    [InlineData(null)]
    public void 危险协议的产物地址一律当没给(string? url)
        => McpArtifactExtractor.SafeArtifactUrl(url).ShouldBeNull();

    [Theory]
    [InlineData("/web-pages?site=abc")]
    [InlineData("https://x.example.com/a.png")]
    [InlineData("http://x.example.com/a.png")]
    public void 站内路由与http地址照常放行(string url)
        => McpArtifactExtractor.SafeArtifactUrl(url).ShouldBe(url);

    /// <summary>
    /// 闸要装在取地址那条路上，不是只提供一个没人调的函数（接线只建一半的老形状）。
    /// 下游给了危险协议时退回站内路由，用户仍有得点。
    /// </summary>
    [Fact]
    public void 下游给危险协议时退回站内路由()
    {
        var artifact = McpArtifactExtractor.Extract(
            "map_kb_create_store", producesArtifacts: true,
            responseBody: """{"success":true,"data":{"storeId":"abc","url":"javascript:alert(1)"}}""");
        artifact.Url.ShouldBe("/document-store?store=abc",
            "危险协议被原样收下了 —— 它该被当成没给，退回按 kind + id 反推的站内路由");
    }

    /// <summary>整条失败的原因必须真的落库，否则轮询端点永远读到 null。</summary>
    [Fact]
    public void 整条生图失败要落库不能只发事件流()
    {
        var src = McpSourceGuard.StripComments(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs"));
        var mark = McpSourceGuard.Slice(src, "private async Task MarkRunFailedSafeAsync(", "var run = await _db.ImageGenRuns.Find");
        mark.ShouldContain("x.ErrorCode, errorCode",
            customMessage: "错误码只发进了事件流没落库，轮询 runs/{runId} 的调用方读不到");
        mark.ShouldContain("x.ErrorMessage, errorMessage",
            customMessage: "原因只发进了事件流没落库，轮询 runs/{runId} 的调用方读不到");
    }
}
