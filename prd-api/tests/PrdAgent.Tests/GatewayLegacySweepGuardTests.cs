using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 网关「MAP 遗留配置可清理」守卫。
///
/// 背景：平台与模型的删除阻挡清单一直**会数** MAP 侧的引用
///（CollectPlatformDeleteBlockersAsync / CollectModelDeleteBlockersAsync 都扫 modelGroups / mapModels），
/// 但删除历来只写 GW 集合。2026-08-25 MAP 的 `api/mds` 写接口整体退场（410）之后，
/// 这个不对称从「难看」升级成「死锁」：网关报着一串 MAP 遗留池挡路，两边都没有端点能扫掉它们。
///
/// 这组用例钉住修复后的**对称性**：凡是阻挡清单数得出来的来源，删除路径就必须够得着。
/// 谁把 MAP 分支删掉、或者把 append-only 的 dangling 例外放宽成「什么成员都能摘」，这里都会红。
/// </summary>
public class GatewayLegacySweepGuardTests
{
    private static readonly string Console = ReadRepoFile("llmgw/console-api/Program.cs");

    /// <summary>取某个 minimal-api 端点处理器的源码片段，避免整文件 Contains 误判到别处。</summary>
    private static string HandlerSource(string mapCall)
    {
        var start = Console.IndexOf(mapCall, StringComparison.Ordinal);
        Assert.True(start >= 0, $"找不到端点：{mapCall}");
        var end = Console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start, $"端点 {mapCall} 没有以 RequireAuthorization 收尾，守卫的取值口径需要更新");
        return Console[start..end];
    }

    [Fact]
    public void 删除模型池_必须能扫掉MAP遗留池()
    {
        var handler = HandlerSource("app.MapDelete(\"/gw/pools/{id}\"");

        // 落回 MAP 集合去找，而不是直接 NOT_GW_AUTHORITY 打死
        Assert.Contains("modelGroups.Find(sourceFilter)", handler);
        // 真的删到 MAP 集合上（只判「找得到」不够——找到了却仍删 GW 集合等于没修）
        Assert.Contains("modelGroups.DeleteOneAsync(sourceFilter)", handler);
        // 只有内部租户可以碰 MAP 兼容层
        Assert.Contains("TenantAccess.GetRequired(http).TenantId == internalTenantId", handler);
        // 审计要分得清扫的是哪一侧
        Assert.Contains("map_model_group", handler);
    }

    [Fact]
    public void 删除模型_必须能扫掉MAP遗留模型()
    {
        var handler = HandlerSource("app.MapDelete(\"/gw/models/{id}\"");

        Assert.Contains("models.Find(sourceFilter)", handler);
        Assert.Contains("models.DeleteOneAsync(sourceFilter)", handler);
        Assert.Contains("TenantAccess.GetRequired(http).TenantId == internalTenantId", handler);
        Assert.Contains("map_llm_model", handler);
    }

    [Fact]
    public void MAP分支不得绕过引用检查()
    {
        // 能扫 debris 不等于可以无脑级联删。两个端点都必须先算 blockers 再删，
        // 顺序错了就会把「还被别人引用的东西」也一并删掉。
        foreach (var (endpoint, blockerCall) in new[]
                 {
                     ("app.MapDelete(\"/gw/pools/{id}\"", "AppCallers"),
                     ("app.MapDelete(\"/gw/models/{id}\"", "CollectModelDeleteBlockersAsync"),
                 })
        {
            var handler = HandlerSource(endpoint);
            var blockerAt = handler.IndexOf(blockerCall, StringComparison.Ordinal);
            var deleteAt = handler.IndexOf("DeleteOneAsync", StringComparison.Ordinal);
            Assert.True(blockerAt >= 0, $"{endpoint} 里找不到引用检查 {blockerCall}");
            Assert.True(deleteAt > blockerAt, $"{endpoint} 必须先算引用阻挡再删除");
            Assert.Contains("TotalCount > 0", handler);
        }
    }

    [Fact]
    public void 平台托管默认池只对死成员放开摘除()
    {
        var handler = HandlerSource("app.MapDelete(\"/gw/pools/{id}/models\"");

        // 例外必须走那个专门的判定函数，而不是把 append-only 检查整段删掉
        Assert.Contains("IsManagedAppendOnlyPool(pool)", handler);
        Assert.Contains("IsDanglingPoolMemberAsync", handler);
        Assert.Contains("APPEND_ONLY_POOL", handler);
    }

    [Fact]
    public void 死成员判定必须两侧都查不到才算死()
    {
        var fn = DanglingMemberSource();

        // GW 侧查得到 -> 活的
        Assert.Contains("gwPlatforms.Find", fn);
        // MAP 侧查得到 -> 也是活的（只查一侧就会把 MAP 来源的活成员误判成死成员）
        Assert.Contains("mapPlatforms.Find", fn);
        // 成员不存在、platformId 为空，一律当活成员保护
        Assert.Contains("if (targets.Count == 0) return false;", fn);
        Assert.Contains("if (string.IsNullOrWhiteSpace(memberPlatformId)) return false;", fn);
        // 早退全部写成「命中即 return false」，不允许改成「都查完再取或」——
        // 那种写法一旦某条查询抛错或被短路，就会把活成员判成死成员摘掉（宁可拒绝，不可误删）。
        Assert.DoesNotContain("dangling = true", fn);
        Assert.DoesNotContain("return true;", fn[..fn.LastIndexOf("return true;", StringComparison.Ordinal)]);
    }

    [Fact]
    public void 死成员判定必须连模型一起查()
    {
        // 只判「上游还在不在」会漏掉第二种死法：上游还在、这个模型被删了。
        // 那种成员照样解析不到任何东西，却会一直挂在删除阻挡清单里，
        // 而 append-only 又不让手工摘 —— 与本文件第一条守卫要解的是同一个死锁。
        var fn = DanglingMemberSource();
        Assert.Contains("gwModels.Find", fn);
        Assert.Contains("mapModels.Find", fn);
        Assert.Contains("PoolMemberModelFilter", fn);

        // 模型匹配的口径必须与 IsResolvableGatewayPoolMember 一致：_id / ModelName / Name 三个都认。
        // 两处用不同口径，就会一边说这成员死了、一边说它还活着。
        var filter = Console[Console.IndexOf("static FilterDefinition<BsonDocument> PoolMemberModelFilter", StringComparison.Ordinal)..];
        filter = filter[..filter.IndexOf("\nstatic ", StringComparison.Ordinal)];
        foreach (var key in new[] { "\"_id\"", "\"ModelName\"", "\"Name\"" })
            Assert.Contains(key, filter);
        Assert.Contains("fb.Eq(\"PlatformId\", platformId)", filter);
    }

    [Fact]
    public void 中继成员不得被平台表判死()
    {
        // 中继成员的 PlatformId 是 __exchange__ 或某条中继的 id，压根不是平台 id。
        // 拿平台表去查必然「两侧都查不到」——不特判就会把活的中继成员判成死成员放行摘除（形状 1）。
        var fn = DanglingMemberSource();
        Assert.Contains("__exchange__", fn);
        Assert.Contains("gwExchanges.Find", fn);
        Assert.Contains("mapExchanges.Find", fn);
    }

    private static string DanglingMemberSource()
    {
        var fn = Console[Console.IndexOf("static async Task<bool> IsDanglingPoolMemberAsync", StringComparison.Ordinal)..];
        return fn[..fn.IndexOf("\n/// <summary>", StringComparison.Ordinal)];
    }

    [Fact]
    public void 托管默认池不得否决它自己派生出来的模型()
    {
        // 托管默认池的成员是按用途自动收进来的派生结果。让派生引用去阻挡源模型的删除，
        // 会和 APPEND_ONLY_POOL（不许手工摘成员）形成死锁——退役一条上游时两头堵死。
        var collector = Console[Console.IndexOf("static async Task<ModelDeleteBlockers> CollectModelDeleteBlockersAsync", StringComparison.Ordinal)..];
        collector = collector[..collector.IndexOf("\nstatic ", StringComparison.Ordinal)];
        Assert.Contains("poolDocs.Where(p => !IsManagedAppendOnlyPool(p))", collector);

        // 放行的前提是删除路径会同步摘掉成员，否则会留下解析不到任何东西的悬空成员
        var handler = HandlerSource("app.MapDelete(\"/gw/models/{id}\"");
        var pruneAt = handler.IndexOf("PruneManagedPoolMembersAsync", StringComparison.Ordinal);
        var deleteAt = handler.IndexOf("DeleteOneAsync", StringComparison.Ordinal);
        Assert.True(pruneAt >= 0, "删除模型必须同步摘掉托管池成员");
        Assert.True(pruneAt < deleteAt, "必须先摘成员再删模型，顺序反了会留下悬空引用");
        Assert.Contains("prunedManagedPools", handler);
    }

    [Fact]
    public void 摘除托管池成员只动托管池()
    {
        var fn = Console[Console.IndexOf("static async Task<List<string>> PruneManagedPoolMembersAsync", StringComparison.Ordinal)..];
        fn = fn[..fn.IndexOf("\n/// <summary>", StringComparison.Ordinal)];
        // 只对托管池动手；人手编排的池仍由 blockers 拦下来问人
        Assert.Contains("pools.Where(IsManagedAppendOnlyPool)", fn);
        Assert.Contains("UpdateOneAsync", fn);
        Assert.DoesNotContain("DeleteOneAsync", fn);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }
}
