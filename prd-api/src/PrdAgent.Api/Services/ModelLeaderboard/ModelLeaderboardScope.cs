using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ModelLeaderboard;

/// <summary>
/// 榜单快照的部署作用域：谁写的、谁看得见。
///
/// ## 为什么需要它
///
/// 一个榜单在库里只有一条文档，而这个库被同项目的**所有分支预览容器共享**
/// （.claude/rules/cross-project-isolation.md 通道 4：dbScope 默认 shared）。
/// 周期同步已经刻意只在权威部署跑（<c>DeploymentAuthority.CanRunSharedScheduledWork</c>），
/// 但手动同步入口没有这道判断——任一条预览上点一次「立即同步」，就把所有兄弟分支
/// 正在读的那条文档换成了**本分支这份未合并解析器**的产物。
///
/// 后果不是「打坏生产」（2026-08-21 用户已明确 CDS 上没有生产），而是**把别人的验收
/// 变成谎话**：兄弟分支打开页面看到一份不是它自己代码产出的数据，却以为是——
/// 这正是 2026-07-19 视觉创作那次「修了像没修」的形状（同规则通道 8）。
///
/// ## 判据
///
/// 作用域取**分支级**（<see cref="DeploymentScope.CurrentDurable"/>，不含 commit），
/// 不是 run 队列那种带 revision 的：run 怕的是滚动发布期间旧容器抢新任务，而快照怕的
/// 是跨分支互相覆盖。带上 revision 的话，同一条分支每推一次就丢掉自己刚同步的快照，
/// 而预览上又没有周期 worker 来补——页面会在每次部署后变空。
///
/// 读取是**自己的优先、权威的兜底**：预览没自己同步过时照样显示权威部署那份
/// （否则每条新预览都是空页，验收无从下手）；自己点过同步之后就看自己那份。
/// 生产（作用域 null）的行为与本类落地前**逐字节相同**：它的文档就是权威文档，
/// 存量文档没有这个字段、读作 null，无需迁移。
/// </summary>
public static class ModelLeaderboardScope
{
    /// <summary>本部署的作用域。生产/本地为 null，CDS 分支预览为 "{projectId}::{branch}"。</summary>
    public static string? Current => DeploymentScope.CurrentDurable;

    /// <summary>这条文档是不是本部署自己写的。生产读 null 文档时为 true。</summary>
    public static bool IsOwnDocument(string? deploymentSlug)
        => IsOwnDocument(deploymentSlug, Current);

    /// <summary>本部署看不看得见它：自己的，或权威部署的（存量文档无该字段 = null）。</summary>
    public static bool IsVisible(string? deploymentSlug)
        => IsVisible(deploymentSlug, Current);

    // 每个判据都另有一个把作用域收成显式参数的重载，供守卫测试直接断言（下面几个 internal，
    // 以及 VisibleFilter / PickVisible 各自那个）。
    //
    // 不这样拆的话，这套判据只有真的跑在 CDS 分支预览容器里才走得到——测试得去改进程
    // 环境变量，并行跑还会互相干扰，最后大概率写成一条永远跳过的绿灯
    // （predicate-and-wiring-discipline 形状 4：不会红的证据比没有证据更糟）。
    // 同 DeploymentScope 自己的 Compose 那样：env 读取留在薄薄一层属性里，判据是纯函数。

    internal static bool IsOwnDocument(string? deploymentSlug, string? scope)
        => string.Equals(deploymentSlug, scope, StringComparison.Ordinal);

    internal static bool IsVisible(string? deploymentSlug, string? scope)
        => deploymentSlug is null || IsOwnDocument(deploymentSlug, scope);

    /// <summary>
    /// 本部署该写哪条文档的 Id：由「榜名 + 作用域」派生，同一个榜在同一个部署上永远
    /// 算出同一个 Id，首次写的并发因此收敛到一条文档。
    ///
    /// 用哈希而不是拼字符串：榜名带连字符（`text-to-image`）、作用域带冒号，而库里其它
    /// 集合的 Id 一律是 32 位十六进制（见 AGENTS.md 规则 7 的 Id 约定），保持同一个形状。
    ///
    /// <paramref name="scope"/> 为 null（权威部署）时**种子与作用域落地前逐字相同**，
    /// 所以生产那条文档的 Id 不变、不需要迁移；预览各自算出不同的 Id，于是各写各的文档，
    /// 不再互相覆盖。
    ///
    /// 放在本类而不是留在同步服务里：「谁写哪条文档」与「谁看得见哪条文档」是同一个判据的
    /// 两面，分开放必然各自漂移（predicate-and-wiring-discipline 形状 3）。
    /// 顺带它在这里才测得动——同步服务那一整片依赖（HttpClientFactory / Mongo 上下文 /
    /// 配置）不值得为一个哈希拖进测试项目。
    /// </summary>
    public static string DocumentId(string board, string? scope)
    {
        var seed = "model-leaderboard:" + board.ToLowerInvariant();
        if (scope is not null) seed += "::" + scope;
        var bytes = System.Security.Cryptography.MD5.HashData(
            System.Text.Encoding.UTF8.GetBytes(seed));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>
    /// 把「看得见」下推到 Mongo，少读几条。**它只是粗筛**：判据仍由
    /// <see cref="PickVisible{TDoc}"/> 兜底，两者不一致时以后者为准。
    /// </summary>
    public static FilterDefinition<ModelLeaderboardSnapshot> VisibleFilter()
        => VisibleFilter(Current);

    internal static FilterDefinition<ModelLeaderboardSnapshot> VisibleFilter(string? scope)
    {
        // 显式写出 string? 而不是裸 null：裸 null 在 Eq 的几个重载之间靠推断挑，
        // 换个驱动版本就可能挑到别的那个。
        var authoritative = Builders<ModelLeaderboardSnapshot>.Filter
            .Eq(x => x.DeploymentSlug, (string?)null);
        return scope is null
            ? authoritative
            : Builders<ModelLeaderboardSnapshot>.Filter.Or(
                authoritative,
                Builders<ModelLeaderboardSnapshot>.Filter.Eq(x => x.DeploymentSlug, scope));
    }

    /// <summary>
    /// 从同一个榜的若干候选文档里挑出本部署该展示的那份：
    /// **自己的优先，其次取最新**。
    ///
    /// 写成一个泛型函数而不是让四个读取点各自 <c>OrderByDescending</c> 两把：
    /// 这个排序口径此前就在四处各写了一遍，前几轮 review 连着四轮才把「取最新」补齐
    /// （predicate-and-wiring-discipline 形状 3：判据分裂成多份然后各自漂移）。
    /// 现在加了作用域这一层，两键排序再抄四遍必然漂——所以只留这一个入口。
    /// </summary>
    public static TDoc? PickVisible<TDoc>(
        IEnumerable<TDoc> candidates,
        Func<TDoc, string?> deploymentSlug,
        Func<TDoc, DateTime> fetchedAt)
        where TDoc : class
        => PickVisible(candidates, deploymentSlug, fetchedAt, Current);

    internal static TDoc? PickVisible<TDoc>(
        IEnumerable<TDoc> candidates,
        Func<TDoc, string?> deploymentSlug,
        Func<TDoc, DateTime> fetchedAt,
        string? scope)
        where TDoc : class
        => candidates
            .Where(d => IsVisible(deploymentSlug(d), scope))
            .OrderByDescending(d => IsOwnDocument(deploymentSlug(d), scope))
            .ThenByDescending(fetchedAt)
            .FirstOrDefault();
}
