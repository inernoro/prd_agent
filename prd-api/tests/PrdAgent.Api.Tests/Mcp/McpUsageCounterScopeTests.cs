using System;
using System.IO;
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
        var source = ReadSource("prd-api/src/PrdAgent.Api/Services/Mcp/McpUsageService.cs");

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
        var script = ReadSource("scripts/mongodb-indexes.js");
        var begin = script.IndexOf("// collection: mcp_usage_counters", StringComparison.Ordinal);
        var end = script.IndexOf("// end collection: mcp_usage_counters", StringComparison.Ordinal);
        (begin >= 0 && end > begin).ShouldBeTrue("计数器的索引段落不在脚本里（段落标记别改名，守卫按它定位）");

        var section = script[begin..end];
        section.ShouldContain("db.mcp_usage_counters.createIndex");
        section.ShouldContain("expireAfterSeconds", customMessage: "回收靠 TTL，删了它这个集合就再没有回收路径");
        section.ShouldContain("\"DayUtc\": 1", customMessage: "TTL 必须挂在 DayUtc 上：那是这一行属于哪一天的唯一依据");
    }

    private static string ReadSource(string repoRelativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))) dir = dir.Parent;
        dir.ShouldNotBeNull("找不到仓库根，无法做源码守卫");
        var full = Path.Combine(dir!.FullName, repoRelativePath);
        File.Exists(full).ShouldBeTrue($"被守的文件不在了：{repoRelativePath}（改名了就同步改这里，别把断言删掉）");
        return File.ReadAllText(full);
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
