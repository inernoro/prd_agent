using MongoDB.Bson;
using PrdAgent.LlmGw.Provisioning;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 存量模型池搬成模型的判据。
///
/// 搬迁只跑一次，跑错了拿回来的是脏数据，所以这几条用的是**行为断言**而不是字面量断言。
/// </summary>
public class PoolMigrationPlannerTests
{
    private static BsonDocument Pool(string? code = "default-generation", int strategy = 0,
        bool isDefault = false, int? priority = null, params BsonDocument[] members)
    {
        var doc = new BsonDocument
        {
            { "_id", "pool-1" }, { "Name", "图片生成默认池" }, { "ModelType", "generation" },
            { "StrategyType", strategy }, { "IsDefaultForType", isDefault },
            { "Models", new BsonArray(members) },
        };
        if (code is not null) doc["Code"] = code;
        if (priority is not null) doc["Priority"] = priority.Value;
        return doc;
    }

    private static BsonDocument Member(string modelId = "gpt-image-1", int? priority = null)
    {
        var m = new BsonDocument { { "ModelId", modelId }, { "PlatformId", "p1" } };
        if (priority is not null) m["Priority"] = priority.Value;
        return m;
    }

    [Fact]
    public void 公开名取池的Code不取Name()
    {
        // 调用方一直按 Code 请求；换成 Name 等于在搬迁这一步悄悄改了对外契约。
        Assert.Equal("default-generation", PoolMigrationPlanner.ToPublicId(Pool()));
        Assert.Equal("chat-main", PoolMigrationPlanner.ToPublicId(Pool(code: "chat-main")));
    }

    [Fact]
    public void 没有合法Code的池不搬()
    {
        // 搬过去也没有调用方能请求到它，只会在白名单里多一条死记录
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: null)));
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: "")));
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: "a")));
        // 首字符必须是字母或数字，与逻辑模型 PublicId 的校验一致
        Assert.Equal(string.Empty, PoolMigrationPlanner.ToPublicId(Pool(code: "-bad")));
    }

    [Fact]
    public void 只有加权随机映射成weighted其余都是priority()
    {
        // 池有六种策略，逻辑模型只有两种。真正跑在请求链路上的只有「按优先级挑、挂了换下一个」
        // 与「按权重分流」，另外四种是那套生产上没人调的调度空壳里的枚举。
        Assert.Equal("weighted", PoolMigrationPlanner.ToRoutingStrategy(Pool(strategy: 4)));
        foreach (var other in new[] { 0, 1, 2, 3, 5 })
            Assert.Equal("priority", PoolMigrationPlanner.ToRoutingStrategy(Pool(strategy: other)));
    }

    [Fact]
    public void 兜底标记原样搬过去()
    {
        Assert.True(PoolMigrationPlanner.IsDefaultForType(Pool(isDefault: true)));
        Assert.False(PoolMigrationPlanner.IsDefaultForType(Pool(isDefault: false)));
        // 字段缺失按「不是默认」——不能猜，猜错就是悄悄换掉兜底模型
        var noField = Pool();
        noField.Remove("IsDefaultForType");
        Assert.False(PoolMigrationPlanner.IsDefaultForType(noField));
    }

    [Fact]
    public void 成员优先级缺失按100不按0()
    {
        Assert.Equal(3, PoolMigrationPlanner.MemberPriority(Member(priority: 3)));
        // 0 会让这条线路无声地抢到发送队列首位，那不是「没配」该有的后果
        Assert.Equal(100, PoolMigrationPlanner.MemberPriority(Member()));
        Assert.Equal(100, PoolMigrationPlanner.MemberPriority(Member(priority: 0)));
    }

    [Fact]
    public void 能力从池成员快照里取不能是空集合()
    {
        // 这个洞是影子比对在真实环境上抓出来的：搬过去的模型能力为空，能力门一律不放行，
        // 于是搬迁报成功、调用方却调不到它，请求默默回落到池。
        var withCaps = Pool(members: new BsonDocument
        {
            { "ModelId", "gpt-image-1" }, { "PlatformId", "p1" },
            { "Capabilities", new BsonArray(new[]
                {
                    new BsonDocument { { "Type", "image_generation" }, { "Value", true } },
                    // Value=false 是「明确不具备」，不是「没说」，不能当成具备
                    new BsonDocument { { "Type", "video_generation" }, { "Value", false } },
                }) },
        });
        var caps = PoolMigrationPlanner.CollectCapabilities(withCaps);
        Assert.Contains("image_generation", caps);
        Assert.DoesNotContain("video_generation", caps);

        // 成员一条快照都没有时退到这个用途的基线能力，而不是交出空集合
        Assert.Equal(new[] { "image_generation" }, PoolMigrationPlanner.CollectCapabilities(Pool(members: Member())));
        var chat = Pool(members: Member());
        chat["ModelType"] = "chat";
        Assert.Equal(new[] { "chat" }, PoolMigrationPlanner.CollectCapabilities(chat));
    }

    [Fact]
    public void 近期的不可用照搬陈年旧账重置()
    {
        var now = new DateTime(2026, 9, 14, 8, 0, 0, DateTimeKind.Utc);

        BsonDocument M(int status, DateTime? failedAt)
        {
            var m = new BsonDocument { { "ModelId", "x" }, { "HealthStatus", status } };
            if (failedAt is not null) m["LastFailedAt"] = failedAt.Value;
            return m;
        }

        // 刚刚失败的：那个「不可用」说的是现在，照搬
        Assert.True(PoolMigrationPlanner.ShouldCarryUnavailable(M(2, now.AddMinutes(-5)), now));
        Assert.True(PoolMigrationPlanner.ShouldCarryUnavailable(M(2, now.AddHours(-23)), now));

        // 18 天前失败的：熔断冷却只有 120 秒，还停在不可用只能是这段时间没人用它，
        // 那个判断说的是过去。这正是 default-generation 的 chatgpt-image-latest 的真实处境。
        Assert.False(PoolMigrationPlanner.ShouldCarryUnavailable(M(2, now.AddDays(-18)), now));
        Assert.False(PoolMigrationPlanner.ShouldCarryUnavailable(M(2, now.AddHours(-25)), now));

        // 健康与降权都不是「不可用」，一律从健康起步
        Assert.False(PoolMigrationPlanner.ShouldCarryUnavailable(M(0, now.AddMinutes(-1)), now));
        Assert.False(PoolMigrationPlanner.ShouldCarryUnavailable(M(1, now.AddMinutes(-1)), now));

        // 标了不可用却没有失败时间：说不清是什么时候的事，按过去处理而不是拿它去挡新路径
        Assert.False(PoolMigrationPlanner.ShouldCarryUnavailable(M(2, null), now));
    }

    [Fact]
    public void 搬迁默认试运行且不动旧表也能重复跑()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = console.IndexOf("app.MapPost(\"/gw/pools/migrate-to-models\"", StringComparison.Ordinal);
        Assert.True(start >= 0, "搬迁端点不存在");
        var end = console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start);
        var handler = console[start..end];

        // 默认试运行：搬迁只跑一次，不该由一次手滑决定
        Assert.Contains("var dryRun = apply != true;", handler);
        Assert.Contains("if (!dryRun)", handler);

        // 只读旧表：llmgw_model_pools 一个字节都不动，回退就是把新建的删掉
        Assert.DoesNotContain("gwModelPools.UpdateOne", handler);
        Assert.DoesNotContain("gwModelPools.DeleteOne", handler);
        Assert.DoesNotContain("gwModelPools.InsertOne", handler);
        Assert.Contains("gwModelPools.Find(", handler);

        // 可重复跑：同名模型只补线路，同一条线路不重复建
        Assert.Contains("if (duplicate) continue;", handler);
        Assert.Contains("result.LinkedToExisting++", handler);

        // 近期的不可用照搬、陈年旧账重置：全搬会让新路径带着过期判断少一条候选，
        // 全不搬会让新路径去用一个池正在主动避开的上游。两种都在真实数据上见过。
        Assert.Contains("carryUnavailable ? 2 : 0", handler);
        Assert.Contains("PoolMigrationPlanner.ShouldCarryUnavailable(member, now)", handler);

        // 跳过要给原因，不能静默吞掉
        Assert.Contains("result.Skipped.Add", handler);

        // 能力必须从池成员快照里取：传 null 得到空集合，空能力的模型能力门不放行
        Assert.Contains("PoolMigrationPlanner.CollectCapabilities(pool)", handler);
        Assert.DoesNotContain("NormalizeDetailed(modelType, null)", handler);

        // 已有模型能力为空时要补上。空能力从来不是合法状态，而「重跑不会重复建」修不回来。
        Assert.Contains("entry.RepairedCapabilities = true;", handler);
        // 只补空的，不覆盖已有能力——那些可能是人工调过的
        Assert.Contains("if (isEmpty)", handler);

        // 同用途最多一个默认：搬迁是直接 Insert，绕过了 PUT 端点那条互斥。
        // 不在这里再走一遍同一条规则，就是判据分裂成两份各自漂移——这一整项工程要消灭的正是它。
        Assert.Contains("fb.Eq(\"IsDefaultForType\", true)", handler);
        Assert.Contains("entry.IsDefaultForType = false;", handler);
        Assert.Contains("同用途只能有一个默认", handler);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }

    [Fact]
    public void 空池与无名池都要报出跳过原因()
    {
        // 静默跳过等于让人以为都搬完了
        Assert.Null(PoolMigrationPlanner.SkipReason(Pool(members: Member())));

        var noCode = PoolMigrationPlanner.SkipReason(Pool(code: null, members: Member()));
        Assert.NotNull(noCode);
        Assert.Contains("对外标识", noCode);

        var empty = PoolMigrationPlanner.SkipReason(Pool());
        Assert.NotNull(empty);
        Assert.Contains("一个成员都没有", empty);
    }

    /// <summary>
    /// 搬迁的两条不变量，都只在「同一批里有两个池指向同一个标识」时才显形。
    ///
    /// 一、复用已有模型时也要搬兜底标记。一个**默认**池映射到已存在的对外模型，
    ///     不设 IsDefaultForType 的话，池退场后不点名的请求就不会落到它——那条流量
    ///     原本是池在接的，搬完反而接不住（要么整个失败，要么换了个模型）。
    ///
    /// 二、dry-run 必须把本轮已规划的行算进来。它自己从不插库，只查已持久化的，
    ///     于是第二个同 Code 的池照样被报成「新建」，而 apply 那一趟第一个已经进去了，
    ///     第二个走的是复用 / 线路去重 / 跨用途拒绝——预览说的和真写的是两回事，
    ///     而 dry-run 的全部价值就是让人在写之前看清会发生什么。
    /// </summary>
    [Fact]
    public void 搬迁复用已有模型时搬兜底标记且dryrun认本轮已规划的行()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = console.IndexOf("app.MapPost(\"/gw/pools/migrate-to-models\"", StringComparison.Ordinal);
        Assert.True(start >= 0, "找不到搬迁端点，判据的取值口径需要更新");
        var end = console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start);
        var handler = console[start..end];

        // 一：复用分支设兜底标记
        Assert.Contains("reuseUpdate.Set(\"IsDefaultForType\", true)", handler);

        // 二：本轮索引三件——标识、用途默认、线路
        Assert.Contains("plannedByNormalizedPublicId", handler);
        Assert.Contains("plannedDefaultByModelType", handler);
        Assert.Contains("plannedOfferingKeys", handler);

        // 三处消费点都要真的查它，不能只建不用（形状 2：建了一半）
        Assert.Contains("plannedByNormalizedPublicId.TryGetValue(normalized", handler);
        Assert.Contains("plannedDefaultByModelType.TryGetValue(modelType", handler);
        Assert.Contains("plannedOfferingKeys.Contains(exchangeRouteKey)", handler);
        Assert.Contains("plannedOfferingKeys.Contains(modelRouteKey)", handler);
    }

    /// <summary>
    /// 调用方对池的专属绑定要转成模型这一侧的认领。
    ///
    /// 绑定写在调用方那一侧（`ModelPoolId` / `DefaultModelPoolId`），而新解析器只看
    /// 模型这一侧的 `DefaultForAppCallerCodes`。不转的话，一个绑了专属池的调用方在池退场后，
    /// 不点名的请求会落到用途默认上——换了一个模型，而且没有任何提示。
    /// 这正是这次搬迁要防的那种静默改变。
    ///
    /// 同时钉住不许硬抢：同用途下那个调用方已经被别的模型认领时，如实报出来，不覆盖。
    /// 抢过来的话，别人的流量会被夺走，比不转更糟。
    /// </summary>
    [Fact]
    public void 搬迁把调用方对池的专属绑定转成模型的认领()
    {
        var handler = MigrationHandler();

        // 两个绑定字段都要认：专属绑定与「不点名时用它」，对新解析器是同一件事
        Assert.Contains("\"ModelPoolId\"", handler);
        Assert.Contains("\"DefaultModelPoolId\"", handler);
        Assert.Contains("boundCallerCodes", handler);

        // 创建与复用两条路都要写进去；复用用 AddToSetEach，覆盖会把已有认领悄悄摘掉
        Assert.Contains("{ \"DefaultForAppCallerCodes\", new BsonArray(claimsToTransfer) }", handler);
        Assert.Contains("AddToSetEach(\"DefaultForAppCallerCodes\", claimsToTransfer)", handler);

        // 被别人认领的不硬抢，如实报出来
        Assert.Contains("plannedClaims", handler);
        Assert.Contains("认领没有转过来", handler);
    }

    /// <summary>
    /// 搬迁要扫两个数据域的池，MAP 原生的成员要给出可执行的下一步。
    ///
    /// 只读的 `GET /gw/pools` 对内部租户把 MAP 的 `model_groups` 与网关自己的池表并起来，
    /// 因为运行时（池退场之前）两边都认。搬迁只读网关那张表的话，MAP 原生的池一个都不会被搬，
    /// 而池分支已经从解析路上删掉——那些路由直接消失，搬迁报告却显示「全部搬完」。
    ///
    /// 成员那一侧同理：线路只能指向网关自己的模型文档，MAP 域的成员要说清「先认领再重跑」，
    /// 而不是报一句「模型库里找不到」——那是假话，而且没有下一步。
    /// </summary>
    [Fact]
    public void 搬迁扫两个数据域且MAP原生成员给出下一步()
    {
        var handler = MigrationHandler();

        Assert.Contains("mapPools", handler);
        Assert.Contains("modelGroups.Find", handler);
        Assert.Contains("gatewayPoolIds.Contains", handler);
        Assert.Contains("FromMapDomain", handler);

        Assert.Contains("mapNative", handler);
        Assert.Contains("还在 MAP 域", handler);
        Assert.Contains("再重跑一次搬迁", handler);
    }

    /// <summary>
    /// 池级授权边界也要搬，而且要说清它被冻结了。
    ///
    /// 旧世界 AllowedModelPoolIds 非空 = 这个调用方只能用这几个池，是一道硬边界；
    /// 新世界的对应物挂在模型那一侧。搬迁此前只写空名单——空 = 对所有人开放，
    /// 于是一个原本被限制在池 A 的调用方，搬完就能点名调用从池 B 搬来的模型：边界没了。
    ///
    /// 翻译方向相反，只能按当前这批调用方算一次，名单因此冻结在搬迁那一刻；
    /// 而没有任何人设过限制时不许凭空造名单——那是用「更严」替换「没限制」，同样改了行为。
    /// </summary>
    [Fact]
    public void 搬迁把池级授权限制翻译成模型的授权名单()
    {
        var handler = MigrationHandler();

        Assert.Contains("\"AllowedModelPoolIds\"", handler);
        Assert.Contains("restrictedCallers", handler);
        Assert.Contains("unrestrictedCallerCodes", handler);
        Assert.Contains("poolAllowlist", handler);
        Assert.Contains("{ \"AllowedAppCallerCodes\", new BsonArray(poolAllowlist) }", handler);

        // 没人设过限制就不写名单：那才是今天的真实行为
        Assert.Contains("restrictedCallers.Count == 0", handler);

        // 复用已有模型时不动它的名单，但**任何不一致**都要报出来。
        // 只报「已有名单为空」那一种的话，两边都非空且不等时两个方向的偏差同时存在
        // 且都没有提示：多出来的调用方越权用到本池线路，缺少的调用方够不到它本有权用的上游。
        Assert.Contains("搬迁没有改它的授权名单", handler);
        Assert.Contains("allowlistMatches", handler);
        Assert.Contains("这些调用方将能用到本池的线路", handler);
        Assert.Contains("这些调用方将用不到它们本来有权用的上游", handler);
    }

    /// <summary>
    /// 两条唯一索引都可能在插入时撞上，处置不一样，所以必须先看是哪一条。
    ///
    /// 把所有 duplicate key 都当默认冲突处理的话，认领撞车时会带着**同一份认领数组**重插，
    /// 必然再抛一次——一次可报告的并发冲突变成 500，而前面几个池可能已经搬完了。
    /// </summary>
    [Fact]
    public void 搬迁按索引名区分默认冲突与认领冲突()
    {
        var handler = MigrationHandler();
        Assert.Contains("uniq_llmgw_logical_claim_per_type", handler);
        Assert.Contains("document[\"DefaultForAppCallerCodes\"] = new BsonArray()", handler);
        Assert.Contains("document[\"IsDefaultForType\"] = false", handler);
        Assert.Contains("没有带上认领", handler);
    }

    /// <summary>
    /// 池成员自带的价格覆盖搬不过去，但必须逐条报出来，不许静默。
    ///
    /// 池路由按池成员计价，而线路没有价格字段——搬过来之后计价只看物理模型文档。
    /// 成员上配过、模型文档上没有或不一样的，搬完就换了个价；兑换所成员更彻底，
    /// 它没有物理模型可回落，直接判成未计价、掉出用量与限额。
    /// 给线路加价格覆盖层是新语义（新增字段 + 解析优先级），不在这一刀里做，已记台账；
    /// 这里钉住的是「不让它悄悄发生」。
    /// </summary>
    [Fact]
    public void 搬迁报出会丢掉的池成员价格覆盖()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("DescribeLostMemberPrices", console);
        // 五项价格都要看，漏一项就是漏一种改价
        foreach (var field in new[]
                 {
                     "InputPricePerMillion", "OutputPricePerMillion",
                     "CachedInputPricePerMillion", "CacheWritePricePerMillion", "PricePerCall",
                 })
        {
            Assert.Contains($"(\"{field}\"", console);
        }

        var handler = MigrationHandler();
        // 两条路径都要报：物理模型成员（回落到模型文档）与兑换所成员（无处可回落）
        Assert.Contains("DescribeLostMemberPrices(member, physical)", handler);
        Assert.Contains("DescribeLostMemberPrices(member, null)", handler);
        Assert.Contains("会被判成未计价", handler);
    }

    /// <summary>
    /// 池数超上限时那句「按 modelType 分批」必须真的做得到。
    ///
    /// 上一版只有 apply 一个参数，池多于上限的租户永远收到 TOO_MANY——而池路由已经删了，
    /// 那个租户再也没有办法把存量搬过来。一句做不到的下一步比没有下一步更糟。
    /// </summary>
    [Fact]
    public void 池数超上限时能按用途分批搬()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        // 对外的 query key 必须就是错误信息里让人加的那个
        Assert.Contains("[FromQuery(Name = \"modelType\")]", console);

        var handler = MigrationHandler();
        Assert.Contains("modelTypeFilter", handler);
        Assert.Contains("poolScopeFilter", handler);
        // 两个数据域都要跟着筛，只筛一个域等于分批分了一半
        Assert.Contains("gwModelPools.Find(TenantAccess.Filter(http, poolScopeFilter))", handler);
        Assert.Contains("modelGroups.Find(poolScopeFilter)", handler);
        // 超限时要说清有哪些用途可选，否则「分批」仍然是句猜谜
        Assert.Contains("availableTypes", handler);
    }

    private static string MigrationHandler()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = console.IndexOf("app.MapPost(\"/gw/pools/migrate-to-models\"", StringComparison.Ordinal);
        Assert.True(start >= 0, "找不到搬迁端点，判据的取值口径需要更新");
        var end = console.IndexOf("}).RequireAuthorization", start, StringComparison.Ordinal);
        Assert.True(end > start);
        return console[start..end];
    }
}
