using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 债务接进任务台的纯函数判据。
///
/// 为什么这几条值得单独守：它们错了都**不会报错**。
/// ParseKey 放宽一点，撞车的标识就会被同步接受，然后两条债务在库里互相覆盖；
/// 收紧一点，仓库推上来的整批条目被静默跳过，界面上只是「什么都没有」。
/// 两种坏法都没有异常、没有红灯，只有人某天发现债务区不对劲。
/// </summary>
public class ActiveTaskDebtsTests
{
    [Theory]
    [InlineData("platform.active-tasks#15", "platform.active-tasks", 15)]
    [InlineData("cds#1", "cds", 1)]
    [InlineData("cds.build-gate#6", "cds.build-gate", 6)]
    [InlineData("doc.readability#8", "doc.readability", 8)]
    [InlineData("md-to-ppt#3", "md-to-ppt", 3)]
    [InlineData("visual-agent.layering#29", "visual-agent.layering", 29)]
    public void ParseKey_认得真实台账里的模块名(string key, string module, int num)
    {
        var parsed = ActiveTaskDebtsController.ParseKey(key);
        Assert.NotNull(parsed);
        Assert.Equal(module, parsed!.Value.Module);
        Assert.Equal(num, parsed.Value.Num);
    }

    [Theory]
    [InlineData(null)]              // 没给
    [InlineData("")]                // 空
    [InlineData("   ")]             // 只有空白
    [InlineData("platform.active-tasks")] // 缺编号 —— 整份台账不是一条债务
    [InlineData("#15")]             // 缺模块 —— 不知道是哪份台账的第 15 条
    [InlineData("platform#0")]      // 编号从 1 起，0 不是条目
    [InlineData("platform#-1")]
    [InlineData("platform#abc")]
    [InlineData("Platform#1")]      // 大写：台账文件名都是小写，放行大写等于放行两个标识指同一条
    [InlineData("platform active#1")]
    [InlineData("platform#1#2")]
    [InlineData("platform#99999")]  // 五位编号：没有哪份台账有上万条，多半是把别的数字塞进来了
    [InlineData("doc/debt.cds.md#1")] // 路径不是模块名
    public void ParseKey_挡住不合法的标识(string? key)
    {
        Assert.Null(ActiveTaskDebtsController.ParseKey(key));
    }

    [Fact]
    public void BuildHeadline_先给判断再给数字()
    {
        // 空态不说「0 条」——「0」逼读者自己想这是好事还是没同步
        Assert.Contains("没有欠着的账", ActiveTaskDebtsController.BuildHeadline(0, 0, 0));

        // 有我的也有没人管的：两个数都给，但拼成一句判断
        var both = ActiveTaskDebtsController.BuildHeadline(10, 3, 5);
        Assert.Contains("3", both);
        Assert.Contains("5", both);

        // 只有我的
        Assert.Contains("其余都有人管了", ActiveTaskDebtsController.BuildHeadline(4, 4, 0));

        // 全都没人管
        Assert.Contains("都还没人管", ActiveTaskDebtsController.BuildHeadline(7, 0, 7));

        // 别人认领完了
        Assert.Contains("有人认领了", ActiveTaskDebtsController.BuildHeadline(6, 0, 2));
    }

    [Fact]
    public void Clip_空白当没有_而不是当空串()
    {
        // 空串和 null 在界面上是两回事：null 不渲染，空串会渲染成一行空白
        Assert.Null(ActiveTaskDebtsController.Clip(null, 10));
        Assert.Null(ActiveTaskDebtsController.Clip("   ", 10));
        Assert.Equal("abc", ActiveTaskDebtsController.Clip("  abc  ", 10));
        Assert.Equal("abcde", ActiveTaskDebtsController.Clip("abcdefghij", 5));
    }

    [Fact]
    public void 状态只有四档_不做工作流()
    {
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Open));
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Claimed));
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Converted));
        Assert.True(ActiveTaskDebtState.IsValid(ActiveTaskDebtState.Closed));
        Assert.False(ActiveTaskDebtState.IsValid("in_progress"));
        Assert.False(ActiveTaskDebtState.IsValid(null));
        Assert.False(ActiveTaskDebtState.IsValid(""));
    }

    [Fact]
    public void 认领与放回是同一个判断的两侧_不许各写一份()
    {
        // 事故形状：Claim 按「转出去过没有」决定落 converted 还是 claimed，
        // Release 却无条件退回 open —— 于是界面上出现「还没人管」配「已转成 1 条活」
        // 这种自相矛盾（2026-09-16 真机截图当场照出来的）。两处必须走同一个判定源。
        var fresh = new ActiveTaskDebt();
        Assert.Equal(ActiveTaskDebtState.Claimed, ActiveTaskDebtsController.StateForClaimed(fresh));
        Assert.Equal(ActiveTaskDebtState.Open, ActiveTaskDebtsController.StateForUnclaimed(fresh));

        var converted = new ActiveTaskDebt { ConvertedTaskIds = { "任务id" } };
        Assert.Equal(ActiveTaskDebtState.Converted, ActiveTaskDebtsController.StateForClaimed(converted));
        // 关键那条：放回认领之后，转出去的那条活还在队列里，所以状态不能退回「还没人管」
        Assert.Equal(ActiveTaskDebtState.Converted, ActiveTaskDebtsController.StateForUnclaimed(converted));
    }

    [Fact]
    public void 读债务走使用档_改整块台账走管理档()
    {
        var sync = Assert.Single(McpBuiltinTools.All, t => t.Name == "map_debt_sync");
        var list = Assert.Single(McpBuiltinTools.All, t => t.Name == "map_debt_list");

        // 读：使用档。谁都该看得见我们欠着什么，这是这个功能的前提。
        Assert.Equal(McpCapabilityCatalog.ScopeTasksUse, list.RequiredScope);

        // 写：管理档。这一行原来也是 use —— 那不是这条守卫想表达的意思（它的名字讲的是
        // 「读」），是写的时候顺手带上的，而它恰好就是后来被 review 抓出来的那个洞：
        // 同步按调用方给的 Key 覆写**所有人**看到的标题、现状、补的条件，一次调用改动
        // 整块共享台账。use 档发到了 operator / viewer，留在 use 就等于任何登录用户
        // 都能重写全公司的债务台账。
        Assert.Equal(McpCapabilityCatalog.ScopeTasksManage, sync.RequiredScope);

        // 读的那个必须是 GET：POST 会被算进写入额度，读债务不该扣额度
        Assert.Equal("GET", list.Method);
        Assert.Equal("POST", sync.Method);

        // 路径得跟开放接口对得上，否则工具描述再好也打不到人
        Assert.Equal("/api/open/tasks/debts", list.PathTemplate);
        Assert.Equal("/api/open/tasks/debts/sync", sync.PathTemplate);
    }
    [Fact]
    public void 筛选只决定列出哪几条_不许顺手改掉结论句的分母()
    {
        // 事故形状：计数跟着 mineOnly 走，于是开「只看我的」时 unclaimed 被算成 0，
        // 结论句说出「其余都有人管了」—— 而实际上还有一百多条没人管。
        // 更糟的是 total 也跟着变 0，前端「total===0 就整块不渲染」的守卫一触发，
        // 连那个切回「看全部」的开关都一起消失，用户走进去就出不来。
        var me = "我";
        var all = new List<ActiveTaskDebt>
        {
            new() { Key = "cds#1", Module = "cds", Num = 1, OwnerUserId = me },
            new() { Key = "cds#2", Module = "cds", Num = 2 },
            new() { Key = "platform.x#1", Module = "platform.x", Num = 1 },
            new() { Key = "platform.x#2", Module = "platform.x", Num = 2, OwnerUserId = "别人" },
        };

        var mineOnly = ActiveTaskDebtsController.BuildBoard(all, me, module: null, mineOnly: true);
        Assert.Single(mineOnly.Items);                 // 列表确实筛了
        Assert.Equal(4, mineOnly.Total);               // 分母还是整块看板
        Assert.Equal(1, mineOnly.Mine);
        Assert.Equal(2, mineOnly.Unclaimed);           // 没人管的两条不会因为筛选而消失
        Assert.Equal(new[] { "cds", "platform.x" }, mineOnly.Modules);  // 模块下拉也要给全量

        // 同一句结论，在筛与不筛两种视图下必须一字不差
        var openAll = ActiveTaskDebtsController.BuildBoard(all, me, module: null, mineOnly: false);
        Assert.Equal(
            ActiveTaskDebtsController.BuildHeadline(openAll.Total, openAll.Mine, openAll.Unclaimed),
            ActiveTaskDebtsController.BuildHeadline(mineOnly.Total, mineOnly.Mine, mineOnly.Unclaimed));

        var oneModule = ActiveTaskDebtsController.BuildBoard(all, me, module: "cds", mineOnly: false);
        Assert.Equal(2, oneModule.Items.Count);
        Assert.Equal(4, oneModule.Total);
        Assert.Equal(new[] { "cds", "platform.x" }, oneModule.Modules);
    }

    [Fact]
    public void 转出去的活被删掉之后_债务不许继续声称已转成N条活()
    {
        // 「已转成 1 条活」这句话的根是那条活本身。活被删了根就没了，
        // 再挂着这句话就是指向空气：点过去打不开，状态也永远回不到 open/claimed
        // ——因为 StateForClaimed 只数个数，不问那几条还在不在。
        var live = new HashSet<string>(StringComparer.Ordinal) { "活着的" };

        var dangling = new ActiveTaskDebt { ConvertedTaskIds = { "已删的" }, OwnerUserId = "我" };
        var pruned = ActiveTaskDebtsController.PruneConversions(dangling, live);
        Assert.NotNull(pruned);
        Assert.Empty(pruned!.Value.Kept);
        Assert.Equal(ActiveTaskDebtState.Claimed, pruned.Value.State);   // 有人认领 -> 退回 claimed

        var unowned = new ActiveTaskDebt { ConvertedTaskIds = { "已删的" } };
        Assert.Equal(ActiveTaskDebtState.Open, ActiveTaskDebtsController.PruneConversions(unowned, live)!.Value.State);

        // 还剩活着的那条就仍是 converted，只是把死的那个 id 摘掉
        var partial = new ActiveTaskDebt { ConvertedTaskIds = { "活着的", "已删的" }, OwnerUserId = "我" };
        var half = ActiveTaskDebtsController.PruneConversions(partial, live);
        Assert.Equal(new[] { "活着的" }, half!.Value.Kept);
        Assert.Equal(ActiveTaskDebtState.Converted, half.Value.State);

        // 没有需要摘的就别写库：null 是「这条跳过」
        Assert.Null(ActiveTaskDebtsController.PruneConversions(
            new ActiveTaskDebt { ConvertedTaskIds = { "活着的" } }, live));
        Assert.Null(ActiveTaskDebtsController.PruneConversions(new ActiveTaskDebt(), live));

        // 已了结的那档，状态跟转没转过无关，摘 id 但不改状态
        var closed = new ActiveTaskDebt { ConvertedTaskIds = { "已删的" }, State = ActiveTaskDebtState.Closed };
        Assert.Equal(ActiveTaskDebtState.Closed, ActiveTaskDebtsController.PruneConversions(closed, live)!.Value.State);
    }
    [Fact]
    public void 债务看板的计数只许有一个判定源_不许第二处再抄一遍()
    {
        // 形状 3（判据分裂）：开放接口那条路曾经自己抄了一遍「谁认领了、几条没人管」，
        // 于是同一个 mineOnly 在界面和 MCP 两条路上给出两句不一样的结论。
        // 抄一遍不会报错、不会变红，只会在某天被人发现两边对不上。
        var root = LocateRepoRoot();
        var apiSrc = Path.Combine(root, "prd-api", "src", "PrdAgent.Api");
        Assert.True(Directory.Exists(apiSrc), $"找不到后端源码目录：{apiSrc}");

        // 「没人认领」这个判断的定义，全仓只许出现在债务控制器里
        const string 判据 = "Count(x => string.IsNullOrEmpty(x.OwnerUserId))";
        var offenders = Directory
            .GetFiles(apiSrc, "*.cs", SearchOption.AllDirectories)
            .Where(f => File.ReadAllText(f).Contains(判据, StringComparison.Ordinal))
            .Select(f => Path.GetFileName(f))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(new[] { "ActiveTaskDebtsController.cs" }, offenders);

        // 反向再钉一次：开放接口必须真的走共享的那个入口，而不是绕开它另算
        var openApi = File.ReadAllText(Path.Combine(apiSrc, "Controllers", "Api", "TasksOpenApiController.cs"));
        Assert.Contains("ActiveTaskDebtsController.BuildBoard(", openApi, StringComparison.Ordinal);
    }

    [Fact]
    public void 改整块共享台账要管理档_不能跟认领一条共用使用档()
    {
        // Codex 2026-09-16 抓到的一条真口子：这个控制器整体挂的是 active-tasks.use，
        // 而使用档在本 PR 里发到了 operator / viewer 这些普通角色。其余端点都是
        // 「对某一条做点什么」，谁都该能做；只有 sync 按调用方给的 Key 覆写整块共享台账，
        // 一次调用改动所有人看到的内容。留在使用档里等于任何登录用户都能重写全公司的债务台账。
        var src = File.ReadAllText(Path.Combine(
            LocateRepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskDebtsController.cs"));

        var at = src.IndexOf("public async Task<IActionResult> Sync(", StringComparison.Ordinal);
        Assert.True(at > 0, "找不到 Sync 端点");
        var body = src[at..(at + 600)];
        Assert.Contains("ActiveTasksManage", body, StringComparison.Ordinal);

        // 反向钉一次：认领这类单条操作**不许**被顺手提到管理档，
        // 否则「谁都能认领一条欠着的事」这个设计就没了
        var claimAt = src.IndexOf("public async Task<IActionResult> Claim(", StringComparison.Ordinal);
        Assert.True(claimAt > 0, "找不到 Claim 端点");
        Assert.DoesNotContain("ActiveTasksManage", src[claimAt..(claimAt + 600)], StringComparison.Ordinal);
    }

    [Fact]
    public void 了结一条也要过归属门_不许替别人宣布做完了()
    {
        // 与 Claim / Convert 同一道门。少这一句的话，认领就只挡得住「抢走」，
        // 挡不住「替你宣布做完了」—— 同一族判据漏掉一个入口，和没有这道门差不多。
        var src = File.ReadAllText(Path.Combine(
            LocateRepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskDebtsController.cs"));

        foreach (var 端点 in new[] { "Claim(", "Convert(", "Close(" })
        {
            var at = src.IndexOf($"public async Task<IActionResult> {端点}", StringComparison.Ordinal);
            Assert.True(at > 0, $"找不到端点 {端点}");
            Assert.Contains("OwnedBySomeoneElse", src[at..(at + 900)], StringComparison.Ordinal);
        }
    }

    [Fact]
    public void 模型报错只进日志_不许把网关原文吐给浏览器()
    {
        // 网关的原始错误带着 HTTP 状态与响应体、供应商与模型名、异常文本。
        // 它对用户没有一个可执行的下一步，却会把内部拓扑摊开给任何能点这个按钮的人。
        // 两条 SSE 共用一句文案，别各写各的。
        var dir = Path.Combine(LocateRepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api");
        foreach (var f in new[] { "ActiveTasksImportController.cs", "ActiveTaskSuggestionsController.cs" })
        {
            var src = File.ReadAllText(Path.Combine(dir, f));
            Assert.DoesNotContain("new { message = err }", src, StringComparison.Ordinal);
            Assert.Contains("ActiveTaskShared.ModelFailedHint", src, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void 卡够时长了吗由后端下发_前端不许拿阈值自己再算一遍()
    {
        // 后端 needsYou 已经按 BlockedEscalateMinutes 判，前端若自己拿阈值再算一次，
        // 就是同一判据的第二份实现：改了这边忘了那边，一屏之内会出现
        // 「头条说没有要你管的、底下这一行标着红」。
        var root = LocateRepoRoot();
        var shared = File.ReadAllText(Path.Combine(
            root, "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskShared.cs"));
        Assert.Contains("escalated = p.Escalated", shared, StringComparison.Ordinal);

        foreach (var f in new[] { "TeamBoardPage.tsx", "PublicBoardPage.tsx" })
        {
            var page = File.ReadAllText(Path.Combine(root, "prd-admin", "src", "pages", "active-tasks", f));
            Assert.Contains("p.escalated", page, StringComparison.Ordinal);
            // 前端拿到分钟阈值自己换算，就是又开了一份实现
            Assert.DoesNotContain("blockedEscalateMinutes", page, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void 顺手清理悬空引用不许覆盖整个数组()
    {
        // Codex 2026-09-16 抓到的：这段跑在**读**路径上（列出债务时顺手清理），
        // 原来用 Set 整个 ConvertedTaskIds。于是一次列表请求会拿着几十毫秒前的快照
        // 去覆盖整个数组 —— 中间有人把一条债务转成了任务，刚追加的那个 id 就被抹掉，
        // 状态也跟着退回去，任务与债务之间的来源链接永久断掉。
        // 一个只是「看一眼列表」的请求，不该能删掉别人刚写进去的东西。
        var src = File.ReadAllText(Path.Combine(
            LocateRepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTaskDebtsController.cs"));

        // 锚在**定义**上，不是按函数名找第一个匹配 —— 那会命中上面的调用点，
        // 于是切出来的窗口落在定义开始之前，判据读的根本不是这个函数的函数体。
        // （本文件其它几条守卫同理：找可执行的形态，别找名字。）
        const string 定义 = "internal static async Task PruneDeadConversionsAsync(";
        var at = src.IndexOf(定义, StringComparison.Ordinal);
        Assert.True(at > 0, "找不到清理函数的定义");
        var body = src[at..];
        var end = body.IndexOf("\n    internal static", 定义.Length, StringComparison.Ordinal);
        if (end > 0) body = body[..end];

        Assert.Contains("PullAll(x => x.ConvertedTaskIds", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Set(x => x.ConvertedTaskIds", body, StringComparison.Ordinal);
        // 状态是按「摘完还剩几条」算的，所以那一次写必须带上快照条件，
        // 别人并发追加了就整个跳过（下一次列表请求自愈）
        Assert.Contains("Filter.Eq(x => x.ConvertedTaskIds", body, StringComparison.Ordinal);
    }

    [Fact]
    public void 历史按结案时间落窗口_不按最后修改时间()
    {
        // 改一句半年前那条的结案说明，它的 UpdatedAt 就是今天，于是它会出现在
        // 「近 7 天」里、还被算进那一栏的合计 —— 列表跟档位说的不是一回事。
        var src = File.ReadAllText(Path.Combine(
            LocateRepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "ActiveTasksController.cs"));

        var at = src.IndexOf("[HttpGet(\"history\")]", StringComparison.Ordinal);
        Assert.True(at > 0, "找不到历史端点");
        var body = src[at..(at + 2000)];
        Assert.Contains("x.DoneAt >= since", body, StringComparison.Ordinal);
        Assert.DoesNotContain("x.UpdatedAt >= since", body, StringComparison.Ordinal);
    }

    [Fact]
    public void 改整块台账的每一个入口都要管理档_不只是界面那一个()
    {
        // 上一轮给界面那条同步端点加了管理档，而开放接口 /api/open/tasks/debts/sync 是
        // **同一个能力的第二个入口**，当时写的是 RequireScope(ScopeUse, ScopeManage)（二选一），
        // 于是只拿 tasks:use 的 key 照样能按自己给的 Key 覆写所有人看到的台账。
        // 一道门开在两个地方，只关一个等于没关。MCP 的 map_debt_sync 打的也是这条路。
        var root = LocateRepoRoot();

        var open = File.ReadAllText(Path.Combine(
            root, "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "TasksOpenApiController.cs"));
        var at = open.IndexOf("[HttpPost(\"debts/sync\")]", StringComparison.Ordinal);
        Assert.True(at > 0, "找不到开放接口的同步端点");
        // 它的 RequireScope 必须**只**认管理档
        var attr = open[at..(at + 200)];
        Assert.Contains("[RequireScope(ScopeManage)]", attr, StringComparison.Ordinal);
        Assert.DoesNotContain("RequireScope(ScopeUse", attr, StringComparison.Ordinal);

        // MCP 那个工具声明的 scope 也要一致，否则它会引着调用方拿 use 档来打这条路
        var mcp = File.ReadAllText(Path.Combine(
            root, "prd-api", "src", "PrdAgent.Api", "Mcp", "McpBuiltinTools.cs"));
        var tool = mcp.IndexOf("Name = \"map_debt_sync\"", StringComparison.Ordinal);
        Assert.True(tool > 0, "找不到 map_debt_sync");
        Assert.Contains("ScopeTasksManage", mcp[tool..(tool + 1200)], StringComparison.Ordinal);
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "doc"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return AppContext.BaseDirectory;
    }
    [Fact]
    public void 认领与转成任务是同一道门_不许只拦一边()
    {
        // Codex 2026-09-16 抓到的：Claim 拦着「已经归别人」，Convert 却无条件把 owner 改成自己。
        // 于是界面上点一下「转成我的活」，就把别人认领的那条悄悄划走了——
        // 校验只做在其中一个入口上，等于给了一条绕过去的路。
        var 别人的 = new ActiveTaskDebt { OwnerUserId = "甲", OwnerUserName = "甲" };
        var 我的 = new ActiveTaskDebt { OwnerUserId = "我", OwnerUserName = "我" };
        var 没人管的 = new ActiveTaskDebt();

        Assert.True(ActiveTaskDebtsController.OwnedBySomeoneElse(别人的, "我"));
        Assert.False(ActiveTaskDebtsController.OwnedBySomeoneElse(我的, "我"));
        Assert.False(ActiveTaskDebtsController.OwnedBySomeoneElse(没人管的, "我"));
        Assert.Contains("甲", ActiveTaskDebtsController.TakenByMessage(别人的));

        // 接线不在这里数个数了 —— 数字写死的判据，每加一个入口都得回来改一次数，
        // 而它红的时候看不出是「漏了一个入口」还是「又对了一个入口」。
        // 改由「了结一条也要过归属门」按端点名逐个查，加入口不用动判据。
    }
}
