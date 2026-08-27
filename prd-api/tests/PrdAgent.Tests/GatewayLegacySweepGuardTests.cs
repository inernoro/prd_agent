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
        Assert.Contains("AreAllTargetedPoolMembersDead", handler);
        Assert.Contains("APPEND_ONLY_POOL", handler);
    }

    [Fact]
    public void 能不能摘除只许有一个判据()
    {
        // 这是本轮改动的全部意义：控制台显示的那个按钮，必须就是删除端点放行的那个条件。
        // 此前前端拿派生的「不可用」标记去重建它，连续三轮 review 抓出三处分歧
        //（上游只是停用 / 成员挂在中继上 / 成员在上游被删之前就已不健康），
        // 每处都表现为「按钮亮着、点下去必然 409」。补洞补不完，因为那是两份判据在漂移。
        Assert.Contains("static bool IsDeadPoolMember", Console);

        // 删除端点必须走同一个原语（经「覆盖到的成员全死了吗」这层），而不是另写一套
        var handler = HandlerSource("app.MapDelete(\"/gw/pools/{id}/models\"");
        Assert.Contains("AreAllTargetedPoolMembersDead(pool, normalizedModelId, normalizedPlatformId", handler);
        Assert.Contains("APPEND_ONLY_POOL", handler);
        var targeted = FunctionSource("static bool AreAllTargetedPoolMembersDead");
        Assert.Contains("IsDeadPoolMember(", targeted);

        // 列表下发的 Removable 也必须来自它
        var apply = FunctionSource("static PoolItem ApplyPoolMemberResolution");
        Assert.Contains("model.Removable = IsDeadPoolMember(", apply);

        // 判据只许有这一处定义
        Assert.Equal(1, CountOccurrences(Console, "static bool IsDeadPoolMember"));
    }

    [Fact]
    public void 按模型名删时必须解析出目标成员而不是拿空platformId硬判()
    {
        // platformId 是可选的：只给 modelId 时按模型名删。拿空 platformId 直接进逐成员判定，
        // 「判不准就保护」会让它恒为 false，托管池上这种删法一律 409——支持的契约被判死。
        // 正确做法是先从池里解析出这次覆盖到的成员，再要求它们**全都**是死成员。
        var fn = FunctionSource("static bool AreAllTargetedPoolMembersDead");
        Assert.Contains("platformId.Length == 0", fn);          // 省略时不按平台过滤
        Assert.Contains("if (targets.Count == 0) return false;", fn);  // 一个都没匹配到就拒绝
        Assert.Contains("targets.All(", fn);                     // 必须全死，剩一个活的就不放行
        Assert.DoesNotContain("targets.Any(", fn);
    }

    [Fact]
    public void 摘除标记不许跟着健康状态早退()
    {
        // 一个在上游被删**之前**就已经失败到不可用的成员，照样是死成员。
        // 让 Removable 跟着 HealthStatus==2 一起早退，它就永远拿不到标记、控制台不给按钮，
        // 而删除端点其实允许删它——能力又建了一半（形状 2）。
        var apply = FunctionSource("static PoolItem ApplyPoolMemberResolution");
        var removableAt = apply.IndexOf("model.Removable =", StringComparison.Ordinal);
        var earlyExitAt = apply.IndexOf("if (model.HealthStatus == 2) continue;", StringComparison.Ordinal);
        Assert.True(removableAt >= 0, "归一没有下发 Removable");
        Assert.True(earlyExitAt < 0 || removableAt < earlyExitAt, "Removable 必须在任何健康状态早退之前算出来");
    }

    [Fact]
    public void 死成员判定只看在不在不看启用与健康()
    {
        // 停用是可逆的临时状态，启用即恢复，不该被当成 debris 摘掉；
        // 健康状态同理与「指不指得到」无关。判据只许查存在性那三张表。
        var fn = FunctionSource("static bool IsDeadPoolMember");
        Assert.Contains("index.ExistingPlatformIds", fn);
        Assert.Contains("index.ExistingModels", fn);
        Assert.Contains("index.ExistingExchanges", fn);
        // 不许把启用过滤过的那三张表混进来
        Assert.DoesNotContain("index.PlatformIds", fn);
        Assert.DoesNotContain("index.Models", fn);
        Assert.DoesNotContain("index.Exchanges", fn);
        Assert.DoesNotContain("HealthStatus", fn);
        // 中继成员一律保护：它的 platformId 不是平台 id，拿平台表判必然误杀
        Assert.Contains("__exchange__", fn);
    }

    [Fact]
    public void 池健康统计不得把指不到东西的成员算成健康()
    {
        // 一个成员指向已删的上游或已删的模型，它的 HealthStatus 永远是 0——因为它从来没被
        // 调用失败过，它压根没被调用成功过一次。只按 HealthStatus 统计，就会把一个一次请求
        // 都发不出去的池显示成「健康」，正好骗过要靠这个数字做判断的人（形状 8）。
        var handler = PoolsListHandlerSource();

        var healthyAt = handler.IndexOf("item.HealthyMembers =", StringComparison.Ordinal);
        Assert.True(healthyAt >= 0, "找不到池健康统计，守卫的取值口径需要更新");
        // 归一必须排在计数之前：池级徽章、成员圆点、三个计数读的是同一个字段，
        // 只改计数不改字段就会出现「池标已中断、第 1 顺位却是绿点」的自相矛盾。
        var normalizeAt = handler.IndexOf("ApplyPoolMemberResolution", StringComparison.Ordinal);
        Assert.True(normalizeAt >= 0, "池列表没有按可解析性归一成员健康");
        Assert.True(normalizeAt < healthyAt, "成员健康归一必须排在计数之前");

        var fn = FunctionSource("static PoolItem ApplyPoolMemberResolution");
        Assert.Contains("model.HealthStatus = 2;", fn);
        Assert.Contains("HealthLabel(2)", fn);
        Assert.Contains("IsResolvablePoolMemberKey", fn);
    }

    [Fact]
    public void 归一必须覆盖每一个吐出池的出口()
    {
        // 只归一列表是不够的：改完成员拿回来的那份响应若还是库里的原始健康值，
        // 卡片当场翻绿、刷新又变回去 —— 正是归一本身要防的自相矛盾，换条路径复现（形状 3）。
        // 所以凡是把 PoolItem 放进响应的地方，都必须过 MapPoolResolvedAsync，不许裸 MapPool。
        Assert.DoesNotContain("ApiEnvelope<PoolItem>.Ok(MapPool(", Console);
        Assert.Contains("MapPoolResolvedAsync", Console);

        var wrapper = Console[Console.IndexOf("async Task<PoolItem> MapPoolResolvedAsync", StringComparison.Ordinal)..];
        wrapper = wrapper[..wrapper.IndexOf("\n\n", StringComparison.Ordinal)];
        Assert.Contains("ApplyPoolMemberResolution", wrapper);
        Assert.Contains("BuildPoolResolutionIndexAsync", wrapper);
    }

    [Fact]
    public void 不可用成员必须说得出为什么()
    {
        // 「连续失败 N 次」只解释得了真的被调用过并失败的成员。指向已删上游的成员
        // consecutiveFailures 恒为 0，照那个模板印就是「不可用（连续失败 0 次）」——
        // 状态对了、归因在说谎，运维拿不到任何下一步（形状 8 的文案版）。
        var fn = FunctionSource("static PoolItem ApplyPoolMemberResolution");
        Assert.Contains("UnavailableReason", fn);
        // 归因本身收在 ClassifyUnavailableReason 里（见「停用与不存在必须分开」那条），
        // 这里只钉住归一环节确实把它填上了，不重复断言取值。
        Assert.Contains("ClassifyUnavailableReason", fn);
    }

    [Fact]
    public void 可解析判定只许有一份口径()
    {
        // 「_id / ModelName / Name 三选一 + PlatformId 相等」这套匹配只许有一处定义。
        // 可解析判定与死成员判定都要用它，各抄一份必然漂移——
        // 然后一边说这成员死了、一边说它还活着（形状 3）。本轮就是被这条守卫自己抓到的。
        var matcher = "string.Equals(model.AsNullableString(\"ModelName\"), modelId, StringComparison.Ordinal)";
        Assert.Equal(1, CountOccurrences(Console, matcher));
        Assert.Equal(1, CountOccurrences(Console, "static bool PoolMemberMatchesModelDoc"));
    }

    [Fact]
    public void MAP遗留默认池不得被当成非默认删掉()
    {
        // MAP 的 model_groups 文档没有 TenantId。原实现把「TenantId 为空」也一并早退成 false，
        // 于是任何 MAP 遗留默认池对删除阻挡清单都报「不是当前默认」，只要它碰巧没有 appCaller
        // 绑定就能被直接删掉——而 ModelResolver 仍在拿它当该模型类型的兜底（形状 1）。
        var fn = FunctionSource("static async Task<bool> IsCurrentDefaultPoolAsync");

        // 早退里不许再出现 tenantId 判空：那正是把兜底短路掉的那一行
        var guardLine = fn[..fn.IndexOf("var type = await poolTypes", StringComparison.Ordinal)];
        Assert.DoesNotContain("string.IsNullOrWhiteSpace(tenantId) ||", guardLine);
        // 没有租户时必须落到自身的 IsDefaultForType，而不是无条件放行
        Assert.Contains("if (string.IsNullOrWhiteSpace(tenantId))", fn);
        Assert.Contains("return pool.AsNullableBool(\"IsDefaultForType\") == true;", guardLine);
    }

    [Fact]
    public void 摘除托管池成员必须定点且递增版本()
    {
        // 整数组覆写会吞掉并发的成员改动；不递增 Version 则让 prune 之前加载过该池的客户端
        // 之后仍能通过 PoolVersionGuard，把刚摘掉的成员原样写回来。
        var fn = FunctionSource("static async Task<List<string>> PruneManagedPoolMembersAsync");

        Assert.Contains("PullFilter(\"Models\"", fn);
        Assert.Contains("Inc(\"Version\", 1)", fn);
        // 更新的过滤必须带 memberFilter：$pull 空转时 Set/Inc 仍会生效，
        // 只按 _id 过滤会让「什么都没摘到」也算 ModifiedCount>0——并发的第二个请求
        // 把自己记成摘过了写进审计，还白白 bump 版本作废别人的句柄。
        Assert.Contains("fb.And(fb.Eq(\"_id\", pool.GetStringOrEmpty(\"_id\")), memberFilter)", fn);
        // 不许退回「读出来过滤再整个 Set 回去」
        Assert.DoesNotContain(".Set(\"Models\"", fn);
        // 只对托管池动手；人手编排的池仍由 blockers 拦下来问人
        Assert.Contains("pools.Where(IsManagedAppendOnlyPool)", fn);
        Assert.DoesNotContain("DeleteOneAsync", fn);
    }

    [Fact]
    public void 控制台必须给得出摘除死成员的入口()
    {
        // 后端专门为死成员开了摘除口子、文案也在说这个顺位永远接不到调用，
        // 但托管池整体 locked、移除按钮不渲染的话，这条清理路径在控制台里根本够不着，
        // 只能去打 API。能力建了一半等于没建（形状 2）。
        var page = ReadRepoFile("llmgw/web/src/pages/ModelPoolsPage.tsx");

        Assert.Contains("const removableDebris", page);
        Assert.Contains("locked && member.removable === true", page);
        Assert.Contains("removableDebris ? removeButton : null", page);
        // 两个分支共用同一个按钮，别再抄一份出来各自漂移
        Assert.Equal(1, CountOccurrences(page, ">移除</Button>"));

        // 受限说明不许和按钮打架：一边给得出摘除入口、一边写「不能移除成员」，
        // 运维会以为那个按钮不该按。留了例外就必须在说明里讲出来。
        var lockedNotice = page.Split('\n').Single(line => line.Contains("平台托管池：", StringComparison.Ordinal));
        Assert.Contains("死成员除外", lockedNotice);
        Assert.DoesNotContain("也不能移除成员。", lockedNotice);
    }

    [Fact]
    public void 停用与不存在必须分开且只对不存在给摘除入口()
    {
        // 可解析索引按「存在且启用」算，而后端悬空判定只查存在性。两者口径不同，
        // 拿「不可用」当摘除条件，就会给仅仅被停用的成员长出一个点了必然 409 的按钮，
        // 外加一句撒谎的归因（说「已不存在」，其实只是停用）。
        var fn = FunctionSource("static string ClassifyUnavailableReason");
        foreach (var reason in new[] { "\"upstream-missing\"", "\"model-missing\"", "\"upstream-disabled\"", "\"model-disabled\"" })
            Assert.Contains(reason, fn);
        // 判「存在不存在」必须用不带启用过滤的那套索引
        Assert.Contains("index.ExistingPlatformIds", fn);
        Assert.Contains("index.ExistingModels", fn);
        // 中继成员的「上游」是那条中继本身，不是平台
        Assert.Contains("isExchangeMember", fn);

        // 归因**可以**被读来做文案（memberFaultPhrase 就该读它），
        // 不许的是拿它当摘除按钮的开关——那正是三轮分歧的来源。
        var page = ReadRepoFile("llmgw/web/src/pages/ModelPoolsPage.tsx");
        Assert.DoesNotContain("function isDeadMember", page);
        var gateLine = page.Split('\n').Single(line => line.Contains("const removableDebris", StringComparison.Ordinal));
        Assert.DoesNotContain("unavailableReason", gateLine);
        Assert.Contains("member.removable === true", gateLine);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        for (var i = haystack.IndexOf(needle, StringComparison.Ordinal); i >= 0;
             i = haystack.IndexOf(needle, i + 1, StringComparison.Ordinal))
            count++;
        return count;
    }

    private static string PoolsListHandlerSource()
    {
        var handler = Console[Console.IndexOf("app.MapGet(\"/gw/pools\"", StringComparison.Ordinal)..];
        return handler[..handler.IndexOf("}).RequireAuthorization", StringComparison.Ordinal)];
    }

    /// <summary>按签名截出一个顶层函数的源码，到下一个 /// 文档注释为止。</summary>
    private static string FunctionSource(string signature)
    {
        var at = Console.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(at >= 0, $"找不到函数：{signature}");
        var fn = Console[at..];
        var end = fn.IndexOf("\n/// <summary>", StringComparison.Ordinal);
        return end > 0 ? fn[..end] : fn;
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
