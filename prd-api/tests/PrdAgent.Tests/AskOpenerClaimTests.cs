using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 开场问题生成的跨进程认领与冷却表守卫（Codex 第三十轮）。
///
/// 两条都只在「同一站点同一版被两个进程同时排上生成」时才现形，而那需要两个真实
/// 部署 + 共用 Mongo，单测造不出来；判据因此钉在结构上——认领必须存在、必须排在
/// 花钱的动作之前、盖戳必须要求这一版还没被盖过。
/// </summary>
public class AskOpenerClaimTests
{
    private static string Source() => File.ReadAllText(Path.Combine(
        LocateSrcRoot(), "PrdAgent.Infrastructure", "Services", "AskOpeningQuestionGenerator.cs"));

    /// <summary>
    /// 认领必须排在取快照与调模型**之前**。
    ///
    /// 进程内的 _inFlight 只挡得住同一个进程：两个 CDS 分支部署、或同一部署的两个副本
    /// 共用一个 Mongo，两边都能过那道门，于是同一版正文被调两次模型——owner 付两次钱。
    /// 认领晚于花钱的动作就没有意义，所以这里钉的是顺序，不只是「有没有」。
    /// </summary>
    [Fact]
    public void 认领必须排在调模型之前()
    {
        var src = Source();
        var run = src[src.IndexOf("private async Task<AskOpenerOutcome> RunAsync", StringComparison.Ordinal)..];

        var claim = run.IndexOf("TryClaimAsync(", StringComparison.Ordinal);
        var snapshot = run.IndexOf("snapshots.GetAsync(", StringComparison.Ordinal);

        Assert.True(claim > 0, "RunAsync 里没有跨进程认领，两个进程会各调一次模型");
        Assert.True(snapshot > 0, "找不到取快照那一步，测试该跟着改");
        Assert.True(claim < snapshot, "认领排在了花钱的动作之后，等于没拦住重复计费");
    }

    /// <summary>认领是 CAS：要么没人持有，要么租约已过期，才轮得到自己。</summary>
    [Fact]
    public void 认领是原子CAS且带租约()
    {
        var src = Source();
        var claim = src[src.IndexOf("private static async Task<bool> TryClaimAsync", StringComparison.Ordinal)..];
        var head = claim[..Math.Min(claim.Length, 1200)];

        Assert.Contains("AskOpenerClaimedAt == null", head);
        Assert.Contains("staleBefore", head);
        // 抢不到时必须让路，而不是继续往下跑
        Assert.Contains("MatchedCount > 0", head);
    }

    /// <summary>盖戳要求这一版还没被盖过——否则后到的那笔会覆盖先到的结果。</summary>
    [Fact]
    public void 盖戳不许覆盖已经盖过的同一版()
    {
        var src = Source();
        var stamp = src[src.IndexOf("private static async Task<bool> StampAsync", StringComparison.Ordinal)..];

        Assert.Contains("s.AskQuestionsGeneratedFor != version", stamp);
    }

    /// <summary>
    /// 冷却表必须清过期项。
    ///
    /// 原先只在「后来生成成功」时删条目：模型长时间不可用时每个站点都进表，而之后
    /// 再没被访问、或已被删除的站点条目就永远留着——这是个单例服务，于是随时间单调增长。
    /// </summary>
    [Fact]
    public void 冷却表读的时候清过期项()
    {
        var src = Source();
        var inCooldown = src[src.IndexOf("private bool InCooldown", StringComparison.Ordinal)..];
        var head = inCooldown[..Math.Min(inCooldown.Length, 900)];

        Assert.Contains("TryRemove", head);
        // 不只是删自己那条，还要扫掉别人留下的过期条目
        Assert.Matches(new Regex(@"foreach[\s\S]{0,200}TryRemove"), head);
    }

    private static string LocateSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln"))) return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
