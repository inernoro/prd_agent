using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 模型池退场的反向守卫。
///
/// 2026-09-15 断流完成后，模型池只剩三个只读/搬迁入口：`GET /gw/pool-types`、`GET /gw/pools`、
/// `POST /gw/pools/migrate-to-models`。页面、11 个写入端点、解析器里的池分支全部删除。
///
/// 删除本身不会让任何测试变红，所以必须有一条反向断言钉住它——否则下一个人按旧记忆
/// 「补回」一个写入端点或页面，全量照样全绿（predicate-and-wiring-discipline 形状 2）。
///
/// 对外模型的线路层面有等价能力：线路停用 / 目标模型被停用会在「调用全貌」里逐条标出
/// 跳过原因，不需要单独一套池清扫入口。
/// </summary>
public sealed class GatewayLegacySweepGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    [Fact]
    public void 模型池管理页面不许回来()
    {
        Assert.False(
            File.Exists(Path.Combine(RepoRoot(), "llmgw/web/src/pages/ModelPoolsPage.tsx")),
            "模型池页面又回来了：它已于 2026-09-15 随断流一起删除，回来说明有人在重建旧那套");
    }

    [Fact]
    public void 模型池只剩只读与搬迁入口()
    {
        var console = File.ReadAllText(Path.Combine(RepoRoot(), "llmgw/console-api/Program.cs"));

        // 保留的三条：两条只读（调用方页的池筛选、实体详情的池展示还在读）+ 一条搬迁
        // （正式环境的存量池还没搬过，删了就再也搬不了）。
        Assert.Contains("app.MapGet(\"/gw/pool-types\"", console);
        Assert.Contains("app.MapGet(\"/gw/pools\"", console);
        Assert.Contains("app.MapPost(\"/gw/pools/migrate-to-models\"", console);

        // 删掉的 11 个写入端点，逐条钉死。判据是路由字面量而不是某段实现，
        // 所以它只在「端点真的被加回来」时才红。
        foreach (var route in new[]
                 {
                     "app.MapPost(\"/gw/pools\",",
                     "app.MapPut(\"/gw/pools/{id}\"",
                     "app.MapDelete(\"/gw/pools/{id}\"",
                     "app.MapPost(\"/gw/pools/bulk-claim\"",
                     "app.MapPost(\"/gw/pools/price-currency/bulk-calibrate\"",
                     "app.MapPost(\"/gw/pools/{id}/models/bulk-import\"",
                     "app.MapPut(\"/gw/pools/{id}/models\"",
                     "app.MapPost(\"/gw/pools/{id}/models/recover\"",
                     "app.MapDelete(\"/gw/pools/{id}/models\"",
                     "app.MapPut(\"/gw/pools/{id}/default\"",
                     "app.MapPut(\"/gw/pools/{id}/claim\"",
                     "app.MapPost(\"/gw/pool-types/ensure\"",
                 })
        {
            Assert.DoesNotContain(route, console);
        }
    }
}
