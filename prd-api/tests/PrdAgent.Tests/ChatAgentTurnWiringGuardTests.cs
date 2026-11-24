using System.IO;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 对话轮次 worker 的接线守卫（源码扫描）。
///
/// 这两条接线（启动收敛、停机等收尾）都需要真 Mongo 才能行为断言，
/// 而它们又恰恰是「删掉之后什么都不会红、只是会话开始永久卡在『在跑』」的那一类。
/// 所以在补上带库的集成用例之前，先用源码守卫钉住它们的存在。
/// </summary>
public class ChatAgentTurnWiringGuardTests
{
    [Fact]
    public void TurnWorker_ShouldReconcileOnStart_AndDrainOnStop()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepoRoot(), "prd-api", "src", "PrdAgent.Api", "Services", "ChatAgentTurnWorker.cs"));

        Assert.Contains("ReconcileInterruptedTurnsAsync", source);
        Assert.Contains("public override async Task StopAsync", source);
        // 停机必须真的等在跑的轮次把「被打断」写完，否则进程先退出，
        // 会话的在跑标记留在库里（server-authority 规则 5）。
        Assert.Contains("Task.WhenAll", source);
    }

    /// <summary>收敛必须按部署作用域过滤：共享 Mongo 里无差别清空会判死别人正在跑的轮次。</summary>
    [Fact]
    public void Reconcile_ShouldBeScopedToCurrentDeployment()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepoRoot(), "prd-api", "src", "PrdAgent.Infrastructure", "Services", "ChatAgent",
            "ChatAgentService.cs"));

        var start = source.IndexOf("ReconcileInterruptedTurnsAsync", StringComparison.Ordinal);
        Assert.True(start >= 0, "找不到 ReconcileInterruptedTurnsAsync 实现");
        var body = source[start..Math.Min(source.Length, start + 2000)];

        Assert.Contains("DeploymentScope.Current", body);
        Assert.Contains("s.DeploymentSlug", body);
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "prd-api", "src"))) return dir.FullName;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
    }
}
