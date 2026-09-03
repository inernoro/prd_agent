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
