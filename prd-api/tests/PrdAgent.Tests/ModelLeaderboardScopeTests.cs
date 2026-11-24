using PrdAgent.Api.Services.ModelLeaderboard;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 榜单快照的部署作用域守卫。
///
/// 要防的事故（.claude/rules/cross-project-isolation.md 通道 4 / 8）：一个榜在库里只有
/// 一条文档，而库被同项目所有分支预览共享。任一条预览点一次「立即同步」就换掉兄弟分支
/// 正在读的那条文档——别人的验收看到的是本分支未合并解析器的产物，而两边都看不出异常。
///
/// 判据写成纯函数（作用域是显式参数）正是为了这些用例跑得动：靠改进程 env 才能走到的
/// 判据，最后一定是一条永远跳过的绿灯（predicate-and-wiring-discipline 形状 4）。
/// </summary>
public sealed class ModelLeaderboardScopeTests
{
    private const string BranchA = "prd-agent::claude/home-model-leaderboard";
    private const string BranchB = "prd-agent::claude/other-branch";

    private sealed record Doc(string? DeploymentSlug, DateTime FetchedAt);

    private static Doc? Pick(string? scope, params Doc[] docs)
        => ModelLeaderboardScope.PickVisible(docs, d => d.DeploymentSlug, d => d.FetchedAt, scope);

    private static DateTime At(int day) => new(2026, 9, day, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void 权威部署的行为与作用域落地前完全一致_只按最新取()
    {
        // 生产/本地的作用域是 null：它自己那条就是权威文档，排序退化成「取最新」，
        // 与本字段落地前逐字相同（存量重复文档里挑最新那条，前几轮 review 修的就是它）。
        var picked = Pick(null, new Doc(null, At(1)), new Doc(null, At(3)), new Doc(null, At(2)));

        Assert.Equal(At(3), picked!.FetchedAt);
    }

    [Fact]
    public void 权威部署看不见任何分支预览写的快照()
    {
        // 反过来也要成立：预览的快照绝不能漏进权威部署的页面。
        // 这里预览那条更新，若判据写成「取最新」就会选中它。
        var picked = Pick(null, new Doc(null, At(1)), new Doc(BranchA, At(9)));

        Assert.Null(picked!.DeploymentSlug);
        Assert.Equal(At(1), picked.FetchedAt);
    }

    [Fact]
    public void 分支预览没自己同步过时兜底显示权威快照()
    {
        // 否则每条新预览都是一张空页，验收无从下手——这正是手动同步入口存在的理由。
        var picked = Pick(BranchA, new Doc(null, At(1)));

        Assert.NotNull(picked);
        Assert.Null(picked!.DeploymentSlug);
    }

    [Fact]
    public void 分支预览自己同步过之后就看自己那份_即便它更旧()
    {
        // 「自己的优先」不能退化成「最新的优先」：预览同步完之后权威部署又跑了一轮的话，
        // 页面会跳回权威那份，于是本分支的解析器改动在自己的预览上看不见——
        // 「修了像没修」（通道 8 的 2026-07-19 事故形状）。
        var picked = Pick(BranchA, new Doc(null, At(9)), new Doc(BranchA, At(2)));

        Assert.Equal(BranchA, picked!.DeploymentSlug);
    }

    [Fact]
    public void 兄弟分支的快照互相看不见()
    {
        var pickedOnA = Pick(BranchA, new Doc(BranchB, At(9)), new Doc(null, At(1)));
        var pickedOnB = Pick(BranchB, new Doc(BranchA, At(9)), new Doc(null, At(1)));

        Assert.Null(pickedOnA!.DeploymentSlug);
        Assert.Null(pickedOnB!.DeploymentSlug);
    }

    [Fact]
    public void 同一作用域内有重复文档时仍取最新()
    {
        // 作用域这一层不许把「取最新」那条判据顶掉——库里已经可能有并发首写留下的孤儿。
        var picked = Pick(BranchA, new Doc(BranchA, At(2)), new Doc(BranchA, At(5)));

        Assert.Equal(At(5), picked!.FetchedAt);
    }

    [Fact]
    public void 候选为空时返回空_不抛()
    {
        Assert.Null(Pick(BranchA));
        Assert.Null(Pick(null));
    }

    [Fact]
    public void 文档Id在权威部署上与作用域落地前逐字相同()
    {
        // 这条钉住「不需要数据迁移」这个承诺：种子必须还是 "model-leaderboard:{board}"。
        // 断言算出来的具体值，而不是「两次调用相等」——后者在种子被改掉后照样绿。
        var expected = Convert.ToHexString(
                System.Security.Cryptography.MD5.HashData(
                    System.Text.Encoding.UTF8.GetBytes("model-leaderboard:agent")))
            .ToLowerInvariant();

        Assert.Equal(expected, ModelLeaderboardScope.DocumentId("agent", scope: null));
        Assert.Equal(expected, ModelLeaderboardScope.DocumentId("AGENT", scope: null));
    }

    [Fact]
    public void 不同作用域算出不同的文档Id_所以各写各的文档()
    {
        var authoritative = ModelLeaderboardScope.DocumentId("agent", null);
        var onA = ModelLeaderboardScope.DocumentId("agent", BranchA);
        var onB = ModelLeaderboardScope.DocumentId("agent", BranchB);

        Assert.Equal(3, new HashSet<string> { authoritative, onA, onB }.Count);
        // 形状仍是 32 位十六进制（AGENTS.md 规则 7 的 Id 约定）
        Assert.All(new[] { authoritative, onA, onB }, id => Assert.Equal(32, id.Length));
    }

    [Fact]
    public void 同一作用域同一个榜永远算出同一个Id_首次写的并发才收敛()
    {
        Assert.Equal(
            ModelLeaderboardScope.DocumentId("text-to-image", BranchA),
            ModelLeaderboardScope.DocumentId("text-to-image", BranchA));
    }

    [Theory]
    [InlineData(null, null, true)]
    [InlineData(null, BranchA, false)]
    [InlineData(BranchA, BranchA, true)]
    [InlineData(BranchA, null, false)]
    [InlineData(BranchA, BranchB, false)]
    public void 自己写的那条文档的判据(string? scope, string? slug, bool expected)
    {
        Assert.Equal(expected, ModelLeaderboardScope.IsOwnDocument(slug, scope));
    }
}
