using System;
using System.IO;
using System.Linq;
using PrdAgent.Api.Services.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 配额计数器 id 的形状，以及它取的是哪一种部署作用域。
///
/// 这条判据坏掉不会红：闸门照常工作、面板照常显示，只是**扣错了人的额度** ——
/// 同项目所有分支预览与生产共用一个 Mongo 库、连 AgentApiKey 都是同一份
/// （cross-project-isolation 通道 4/8），id 不带部署作用域时，在预览上跑几张图
/// 会把那把密钥在生产上的当日额度一起吃掉。
///
/// 测的是纯函数重载（作用域当参数传），不去改进程 env —— 那会跨用例串味，
/// 造出一个自己会飘的守卫。
/// </summary>
public class McpUsageCounterScopeTests
{
    private static readonly DateTime Day = new(2026, 9, 3, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void 没有部署作用域时_id_保持原样_与存量兼容()
    {
        McpUsageService.BuildCounterId("k1", Day, McpUsageService.KindImage, null)
            .ShouldBe("k1:20260903:image");
    }

    [Fact]
    public void 不同部署作用域各算各的额度()
    {
        var a = McpUsageService.BuildCounterId("k1", Day, McpUsageService.KindWrite, "proj1::feature-a");
        var b = McpUsageService.BuildCounterId("k1", Day, McpUsageService.KindWrite, "proj1::feature-b");
        var prod = McpUsageService.BuildCounterId("k1", Day, McpUsageService.KindWrite, null);

        a.ShouldNotBe(b, "同一把密钥在两条分支上必须各算各的额度");
        a.ShouldNotBe(prod, "分支预览不能吃掉生产那份额度");
    }

    [Fact]
    public void 额度键与调用记录都取稳定分支作用域_不取带_revision_的那一个()
    {
        // DeploymentScope.Current 带 ::revision::{commit}，那是给「入队 fencing」用的
        // （防止滚动发布期间旧 worker 抢新任务）。拿它当额度键 = 重新部署一次额度就清零；
        // 拿它当调用记录的作用域 = 每部署一次，之前的记录整批从面板上消失。
        //
        // 这一条只能扫源码：正确与否取决于**取了哪一个属性**，而两个属性的值都来自进程
        // 环境变量，在测试里改 env 会跨用例串味（xUnit 默认并行），造出的守卫自己会飘。
        // 扫源码换来的是「删掉/改回去必然变红」，比没有守卫强，也比一个会飘的守卫强。
        var source = McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Services/Mcp/McpUsageService.cs");

        source.ShouldContain("DeploymentScope.CurrentDurable");
        System.Text.RegularExpressions.Regex.IsMatch(source, @"DeploymentScope\.Current\b")
            .ShouldBeFalse("额度与调用记录都不该用带 commit revision 的 DeploymentScope.Current");
    }

    [Fact]
    public void 计数器集合必须登记回收策略()
    {
        // 每把密钥每天每种额度各留一行，而读的只有「今天」那几行（闸门与面板都按当天的
        // 确定性 _id 直接定位，从不扫历史）。没有回收路径时这个集合只会单向变大，
        // 长出来的全是死数据 —— 而这件事不会让任何测试变红，也不会让任何请求报错。
        //
        // 本仓库禁止应用自动建索引（no-auto-index 规则），所以回收策略的唯一落点是
        // DBA 执行的那份脚本。守卫盯的就是「它还在那份脚本里」。
        var script = McpSourceGuard.Read("scripts/mongodb-indexes.js");
        var begin = script.IndexOf("// collection: mcp_usage_counters", StringComparison.Ordinal);
        var end = script.IndexOf("// end collection: mcp_usage_counters", StringComparison.Ordinal);
        (begin >= 0 && end > begin).ShouldBeTrue("计数器的索引段落不在脚本里（段落标记别改名，守卫按它定位）");

        var section = script[begin..end];
        section.ShouldContain("db.mcp_usage_counters.createIndex");
        section.ShouldContain("expireAfterSeconds", customMessage: "回收靠 TTL，删了它这个集合就再没有回收路径");
        section.ShouldContain("\"DayUtc\": 1", customMessage: "TTL 必须挂在 DayUtc 上：那是这一行属于哪一天的唯一依据");
    }

    [Fact]
    public void 占坑不许跟着客户端的取消令牌走()
    {
        // 客户端在这一笔在途时断开，Mongo 完全可能已经把自增落下去了，而驱动这边抛的是取消：
        // 异常一路上抛，谁也拿不到「占了多少坑」这个结论，于是没人去退 —— 用户白扣一天额度，
        // 而那次调用根本没跑（server-authority：写库不跟 RequestAborted 走）。
        // 只能扫源码：真要复现得让 Mongo 与驱动在同一微秒里赛跑。
        // 去掉注释行再判：解释文字里同样会出现这几个词，让注释满足断言等于守卫失效
        var body = McpSourceGuard.StripComments(McpSourceGuard.Slice(
            McpSourceGuard.Read("prd-api/src/PrdAgent.Api/Services/Mcp/McpUsageService.cs"),
            "private async Task<(bool Ok, int Used)> TryReserveAsync",
            "private async Task<int> ReadUsedAsync"));

        body.ShouldContain("ct = CancellationToken.None",
            customMessage: "占坑是服务端自己的记账，客户端断开不能让它半途而废");
    }

}

/// <summary>
/// 速率状态的保留窗口。
///
/// 两张进程内静态表（速率窗口 / 拒绝标记）以 keyId 为键，只增不减：密钥可以被撤销、被硬删、
/// 被反复轮换，而条目一直留着，内存占用跟「这个进程见过多少把密钥」成正比。清扫是为它加的上限。
///
/// 这里测的是纯判据，不去动那两张静态表 —— 动了会跨用例串味，造出一个自己会飘的守卫。
/// 判据被谁改短到一分钟以内，正在计数的当前分钟会被自己扫掉，速率闸就周期性失效了。
/// </summary>
public class McpRateStateRetentionTests
{
    private static readonly DateTime Now = new(2026, 9, 3, 12, 30, 0, DateTimeKind.Utc);

    [Fact]
    public void 当前这一分钟绝不能被扫掉()
    {
        McpUsageService.IsStaleRateState(Now, Now).ShouldBeFalse();
    }

    [Fact]
    public void 上一分钟还留着_两分钟前才清()
    {
        // 保留窗口必须严格大于一分钟：跨分钟边界的调用要还能读到刚过去那一分钟的状态
        McpUsageService.IsStaleRateState(Now.AddMinutes(-1), Now).ShouldBeFalse();
        McpUsageService.IsStaleRateState(Now.AddMinutes(-3), Now).ShouldBeTrue();
    }
}

/// <summary>
/// 条件自增的上界。
///
/// 闸门从「先加、超了再退」改成「加完不超才加得上」之后，唯一会差一格的地方就是这个上界，
/// 而差一格的两种后果（多放一次 / 少放一次）都不报错、也照不亮任何现有用例。
/// </summary>
public class McpQuotaCeilingTests
{
    [Fact]
    public void 上界是_加之前最多能有多少()
    {
        // 上限 50 张、这次要 1 张：加之前最多 49，也就是第 50 张放行、第 51 张挡下
        McpUsageService.ReservationCeiling(50, 1).ShouldBe(49);
        // 一次要 4 张：加之前最多 46，第 47 张起就该挡（不能让它跨过 50）
        McpUsageService.ReservationCeiling(50, 4).ShouldBe(46);
    }

    [Fact]
    public void 一次要得比上限还多_上界为负_永远放不过去()
    {
        McpUsageService.ReservationCeiling(2, 4).ShouldBeLessThan(0);
        // 上限为 0 等于关掉这项能力，任何一次都不许过
        McpUsageService.ReservationCeiling(0, 1).ShouldBeLessThan(0);
    }
}

/// <summary>
/// 入参摘要里的凭据隐去。
///
/// 动态工具（登记表里的开放接口）的入参形状由登记的人决定，里面完全可能有 password / token /
/// apiKey，而这份摘要会落进调用记录、再原样显示在接入台上。截断到 120 字对短口令毫无保护。
///
/// 这条判据的两个方向都要钉：漏了就把凭据写进库；过宽就把 keyword、author 这类正常参数也
/// 隐掉，摘要变得看不懂 —— 而摘要看不懂，这块面板就没用了。
/// </summary>
public class McpArgumentRedactionTests
{
    [Theory]
    [InlineData("password")]
    [InlineData("Password")]
    [InlineData("api_key")]
    [InlineData("api-key")]
    [InlineData("apiKey")]
    [InlineData("accessToken")]
    [InlineData("clientSecret")]
    [InlineData("Authorization")]
    [InlineData("cookie")]
    [InlineData("privateKey")]
    public void 看着像凭据的参数名一律隐去(string name)
    {
        McpUsageService.IsSensitiveArgumentName(name).ShouldBeTrue();
    }

    [Theory]
    [InlineData("keyword")]
    [InlineData("author")]
    [InlineData("title")]
    [InlineData("clientRequestId")]
    [InlineData("storeId")]
    [InlineData("prompt")]
    public void 正常参数不许被隐掉(string name)
    {
        McpUsageService.IsSensitiveArgumentName(name).ShouldBeFalse();
    }

    [Fact]
    public void 摘要里凭据的值与长度都不透出()
    {
        var args = new System.Text.Json.Nodes.JsonObject
        {
            ["keyword"] = "周报",
            ["apiKey"] = "sk-live-0123456789abcdef",
        };

        var summary = McpUsageService.SummarizeArguments(args);

        summary.ShouldNotBeNull();
        summary!.ShouldContain("keyword=", customMessage: "正常参数照旧要看得见");
        summary.ShouldContain("apiKey=[已隐去]");
        summary.ShouldNotContain("sk-live");
    }
}

/// <summary>
/// 嵌套在对象/数组里的凭据也要隐去。
///
/// 上一轮只隐了顶层键，而 `config={ apiKey: "..." }` 这种，顶层那个键叫 config、一点也不敏感，
/// 里面那串凭据照样被原样序列化进记录、显示在接入台上 —— 判据比它该管的范围窄的那个老形状。
/// </summary>
public class McpNestedRedactionTests
{
    private static string Summarize(string json)
        => McpUsageService.SummarizeArguments(
            System.Text.Json.Nodes.JsonNode.Parse(json)!.AsObject()) ?? string.Empty;

    [Fact]
    public void 藏在对象里的凭据不许漏出来()
    {
        var summary = Summarize("""{"config":{"baseUrl":"https://x","apiKey":"sk-live-secret"}}""");

        summary.ShouldNotContain("sk-live-secret");
        summary.ShouldContain(McpUsageService.Redacted);
        // 同一个对象里不敏感的字段照旧看得见，摘要才有用
        summary.ShouldContain("baseUrl");
    }

    [Fact]
    public void 藏在数组里的对象也要走一遍()
    {
        var summary = Summarize("""{"targets":[{"name":"a","token":"tok-secret"}]}""");

        summary.ShouldNotContain("tok-secret");
        summary.ShouldContain("name");
    }

    [Fact]
    public void 深到超过上限的层级整块不再展开()
    {
        // 第七层往下一律不展开：摘要只有 600 字，深到那里的东西本来也进不了成品，
        // 而不设上限就等于让病态输入决定这一趟走多深。
        var deep = """{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"apiKey":"sk-deep-secret"}}}}}}}}""";

        Summarize(deep).ShouldNotContain("sk-deep-secret");
    }

    [Fact]
    public void 普通入参不受影响()
    {
        var summary = Summarize("""{"keyword":"周报","limit":10}""");

        summary.ShouldContain("keyword");
        summary.ShouldContain("周报");
        summary.ShouldNotContain(McpUsageService.Redacted);
    }

    [Fact]
    public void 特别宽的入参_不许被整个克隆和序列化()
    {
        // 深度早就卡在 6 层了，**宽度**没有：一个几万元素的平铺数组深度只有 2，
        // 却会被整个克隆一遍、整个序列化一遍，最后只留 120 个字符。
        // 而摘要是在限流闸门**之前**构造的 —— 已经被限流挡下的调用照样走这一遍，
        // 等于给调用方一个用自己的 body 放大服务端 CPU 与内存的杠杆。
        var summary = McpUsageService.SummarizeArguments(
            new System.Text.Json.Nodes.JsonObject { ["items"] = Wide(20_000) });
        summary.ShouldNotBeNull();
        summary!.ShouldContain("items=", customMessage: "摘要本身还得能用");

        // 判据不是耗时（跑在什么机器上都不好说），是「有没有把整棵树走完」：
        // 走完的话这两万个元素会全部出现在克隆出来的节点里。
        var redacted = McpUsageService.RedactSensitive(Wide(20_000), 0) as System.Text.Json.Nodes.JsonArray;
        redacted.ShouldNotBeNull();
        (redacted!.Count < 1000).ShouldBeTrue(
            $"整棵树被走完了（克隆出 {redacted.Count} 个元素）：两万个元素全克隆一遍，只为最后留 120 个字符");
    }

    private static System.Text.Json.Nodes.JsonArray Wide(int n)
    {
        var arr = new System.Text.Json.Nodes.JsonArray();
        for (var i = 0; i < n; i++) arr.Add(i);
        return arr;
    }

    [Fact]
    public void 单个巨大的字符串_也不许被整个克隆()
    {
        // 宽度预算按**节点数**算，而一个几 MB 的字符串只占一个节点 —— 只堵节点数
        // 堵不住它：照抄再序列化，最后仍然只留 120 个字符，整块内存白走一遍。
        var huge = new string('x', 2_000_000);
        var redacted = McpUsageService.RedactSensitive(
            System.Text.Json.Nodes.JsonValue.Create(huge), 0);

        redacted.ShouldNotBeNull();
        var text = redacted!.GetValue<string>();
        (text.Length < 1000).ShouldBeTrue($"叶子字符串没截断（留下 {text.Length} 个字符）");
    }
}
