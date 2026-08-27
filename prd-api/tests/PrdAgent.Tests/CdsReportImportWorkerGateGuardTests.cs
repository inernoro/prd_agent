using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 每小时的 CDS 报告同步只许在生产跑，且**不能被「接管通知」那个开关放行**。
///
/// ## 守的是什么
///
/// 同一个 CDS 项目下所有分支预览共用一个 Mongo，每个分支预览也都跑着一份 MAP。
/// N 个分支同时跑这个拉取任务，既是对 CDS 的自我 DDoS，也让「这批文档是谁写的」
/// 变得不可追。所以 worker 开头有一道闸。
///
/// 问题出在**用哪个判据当这道闸**。`IsAuthoritativeDeployment` 按它自己的契约
/// 「只管通知」，而 `PlatformKeyIntegrity:ManageGlobalNotification=true` 是留给分支
/// 「临时接管全局告警行」的逃生阀。拿它当闸，等于一个为了看告警而打开开关的分支
/// 顺带获得了对共享库和 CDS 跑周期拉取的权限（Codex review P2）。
///
/// `DeploymentAuthority` 这个类自己已经立过这条纪律：软开关一票否决可以，一票放行
/// 不行（见 `CanRotateSharedCiphertext` 的注释）。这道闸要走的是同一形状的
/// `CanRunSharedScheduledWork`。
///
/// ## 为什么用源码守卫
///
/// 判据本身在 `DeploymentAuthorityTests` 里有行为用例；但「worker 真的用了它」这条
/// 接线换回 `IsAuthoritativeDeployment` 之后，那些用例照样全绿——worker 本体拖着
/// BackgroundService 与 Mongo，搬不进这个测试项目。这就是
/// predicate-and-wiring-discipline 说的「建了一半」。
/// </summary>
public class CdsReportImportWorkerGateGuardTests
{
    [Fact]
    public void 同步闸不许被接管通知的开关放行()
    {
        var path = Path.Combine(
            FindSrcRoot(), "PrdAgent.Api", "Services", "CdsReportImportWorker.cs");
        Assert.True(File.Exists(path), $"守卫要读的源文件不在了：{path}（改名了就同步改这里，别让守卫空跑）");
        var worker = File.ReadAllText(path);

        Assert.Contains("DeploymentAuthority.CanRunSharedScheduledWork(", worker, StringComparison.Ordinal);

        // 只看「有没有真的调用它」，不看注释——注释里正解释着为什么不用这个判据，
        // 散扫全文会把那段解释也算成命中，守卫从此恒绿（形状 6：读的不是生效的那个值）。
        Assert.DoesNotContain(
            "DeploymentAuthority.IsAuthoritativeDeployment(",
            worker,
            StringComparison.Ordinal);
    }

    private static string FindSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
                return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
