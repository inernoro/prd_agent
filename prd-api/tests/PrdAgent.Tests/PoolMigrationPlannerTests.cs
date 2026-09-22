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
    public void 混着动作能力的池不许搬过去()
    {
        /*
          搬迁把成员能力**并**成模型的能力集。动作能力（目前只有分层）一旦落在模型上就独占这个
          模型的服务对象——能力门第二句直接短路成「只认分层那个专用调用方」。于是「普通生图 +
          分层」的混合池搬过去，模型有可用线路、搬迁报成功，而原本用这个池的每一个普通调用方
          全部被拒：存得进去、跑不起来，没有任何地方会说为什么（第 65 轮 review）。

          断言的是「这种池会被拒并给出原因」这个性质，不是某一句措辞。
        */
        BsonDocument Cap(string type) => new BsonDocument
        {
            { "ModelId", "m-" + type }, { "PlatformId", "p1" },
            { "Capabilities", new BsonArray(new[] { new BsonDocument { { "Type", type }, { "Value", true } } }) },
        };

        // 混着：一个普通生图成员 + 一个分层成员 —— 必须拒
        var mixed = Pool(members: new[] { Cap("image_generation"), Cap("image_layering") });
        var mixedReason = PoolMigrationPlanner.SkipReason(mixed);
        Assert.NotNull(mixedReason);
        Assert.Equal(mixedReason, PoolMigrationPlanner.OperationOnlyConflictReason(mixed));
        // 下一步必须是做得到的动作，不能只报「不行」
        Assert.Contains("拆", mixedReason!);

        // 历史别名走的是另一条路（kebab-case），一样要认出来——只认一种写法就漏
        var mixedAlias = Pool(members: new[] { Cap("image-gen"), Cap("image-layering") });
        Assert.NotNull(PoolMigrationPlanner.OperationOnlyConflictReason(mixedAlias));

        // 没声明能力的成员同样算「不具备分层」：它搬过去照样会被分层独占掉
        var mixedSilent = Pool(members: new[] { Member(), Cap("image_layering") });
        Assert.NotNull(PoolMigrationPlanner.OperationOnlyConflictReason(mixedSilent));

        // 整池都是分层：能力集是自洽的（模型本来就只服务分层那个调用方），照搬
        var allLayering = Pool(members: new[] { Cap("image_layering"), Cap("image_layering") });
        Assert.Null(PoolMigrationPlanner.OperationOnlyConflictReason(allLayering));
        Assert.Null(PoolMigrationPlanner.SkipReason(allLayering));

        // 普通池不受影响
        var ordinary = Pool(members: new[] { Cap("image_generation"), Member() });
        Assert.Null(PoolMigrationPlanner.OperationOnlyConflictReason(ordinary));
        Assert.Null(PoolMigrationPlanner.SkipReason(ordinary));

        // 判据必须接在唯一那道闸上：端点只调 SkipReason，冲突不进 SkipReason 就等于没接线
        var handler = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("PoolMigrationPlanner.SkipReason(pool)", handler);
    }

    /// <summary>
    /// 近期的非健康状态照搬，陈年旧账重置。
    ///
    /// 这条用例的上一版把「降权重置成健康」写成了断言——它不是在测行为，是在**要求那个缺陷存在**：
    /// 挑选判据把健康排在降级之前，一个刚刚在失败的高优先级成员搬成健康之后，切换那一刻
    /// 就重新拿到了主流量。谁修这个 bug 谁的 CI 红，于是没人敢修（形状 4a：测试反向锁死缺陷）。
    /// </summary>
    [Fact]
    public void 近期的非健康状态照搬陈年旧账重置()
    {
        var now = new DateTime(2026, 9, 14, 8, 0, 0, DateTimeKind.Utc);

        BsonDocument M(int status, DateTime? failedAt)
        {
            var m = new BsonDocument { { "ModelId", "x" }, { "HealthStatus", status } };
            if (failedAt is not null) m["LastFailedAt"] = failedAt.Value;
            return m;
        }

        // 刚刚失败的：那个状态说的是现在，原样照搬（熔断与降级同一口径）
        Assert.Equal(2, PoolMigrationPlanner.CarryHealthStatus(M(2, now.AddMinutes(-5)), now));
        Assert.Equal(2, PoolMigrationPlanner.CarryHealthStatus(M(2, now.AddHours(-23)), now));
        Assert.Equal(1, PoolMigrationPlanner.CarryHealthStatus(M(1, now.AddMinutes(-5)), now));
        Assert.Equal(1, PoolMigrationPlanner.CarryHealthStatus(M(1, now.AddHours(-23)), now));

        // 18 天前失败的：熔断冷却只有 120 秒，还停在不可用只能是这段时间没人用它，
        // 那个判断说的是过去。这正是 default-generation 的 chatgpt-image-latest 的真实处境。
        Assert.Equal(0, PoolMigrationPlanner.CarryHealthStatus(M(2, now.AddDays(-18)), now));
        Assert.Equal(0, PoolMigrationPlanner.CarryHealthStatus(M(2, now.AddHours(-25)), now));
        Assert.Equal(0, PoolMigrationPlanner.CarryHealthStatus(M(1, now.AddDays(-18)), now));

        // 本来就是健康的，没什么可搬
        Assert.Equal(0, PoolMigrationPlanner.CarryHealthStatus(M(0, now.AddMinutes(-1)), now));

        // 标了非健康却没有失败时间：说不清是什么时候的事，按过去处理而不是拿它去挡新路径
        Assert.Equal(0, PoolMigrationPlanner.CarryHealthStatus(M(2, null), now));
        Assert.Equal(0, PoolMigrationPlanner.CarryHealthStatus(M(1, null), now));
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

        // 可重复跑：同名模型只补线路，同一条线路不重复建。
        // 判重从「查一下在不在」改成了「把那条读回来」——因为重跑时已经存在的线路也要算进
        // 「有几条能接流量」，不然上一趟被停用的模型永远放不回来（第 57 轮 review）。
        Assert.Contains("existingModelRoute is not null", handler);
        Assert.Contains("plannedOfferingKeys.Contains(modelRouteKey) || existingModelRoute is not null", handler);
        Assert.Contains("result.LinkedToExisting++", handler);

        // 近期的非健康状态照搬、陈年旧账重置：全搬会让新路径带着过期判断少一条候选，
        // 全不搬会让新路径去用一个池正在主动避开的上游。两种都在真实数据上见过。
        //
        // 断言的是「写进去的那个状态来自共享判据」，不是某一次的三元写法——上一版逐字要求
        // `carryUnavailable ? 2 : 0`，而那个写法本身就只认熔断一档，守卫等于替它背书。
        Assert.Contains("PoolMigrationPlanner.CarryHealthStatus(member, now)", handler);
        Assert.Matches(@"\{ ""HealthStatus"", carried\w+ \}", handler);
        Assert.Contains("PoolMigrationPlanner.CarryHealthStatus(member, now)", handler);

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
    /// 「一个人都不许用」不能被翻译成「谁都能用」。
    ///
    /// poolAllowlist 的空集有两种来源，落库之后长得一模一样：这一档没人设过池级限制
    /// （本来就对所有人开放），与设过限制但没有任何调用方获准用这个池（一个人都不许用）。
    /// 后者算出来也是空集，而 AllowedAppCallerCodes 为空在运行时的含义恰恰是「对所有调用方开放」——
    /// 照直写下去，一个谁都调不到的池在搬迁之后变成整个租户都能调，一次静默的授权放大。
    /// </summary>
    [Fact]
    public void 谁都没被授权的池不搬也不落成对所有人开放()
    {
        var handler = MigrationHandler();

        // 两种空集要分开：判的是「设过限制吗」而不只是「名单空不空」。
        Assert.Contains("restrictedSameType.Count > 0 && poolAllowlist.Count == 0", handler);

        // 这道门不分新建与复用。只在 existing is null 时判的话，撞上同标识的已有模型就整个绕过去：
        // 保留那个模型原有的名单，却把「谁都没被授权」的池的成员当线路挂上去——
        // 一批原本谁都够不到的上游对所有获准使用那个模型的调用方开放，比新建那条路更糟。
        Assert.DoesNotContain("existing is null && restrictedSameType.Count > 0", handler);

        // 这一档不搬，而不是搬成一个空名单（空名单 = 对所有人开放）。
        Assert.Contains("这种「谁都不许用」落到对外模型上会变成「谁都能用」", handler);
        // 要给得出下一步：去哪儿授权、然后怎么办。
        Assert.Contains("再重跑一次搬迁", handler);
    }

    /// <summary>
    /// 认领不许写成「名单里没有它、认领里却有它」这种自相矛盾的模型。
    ///
    /// 运行时第一层按认领挑中它，第二步 SupportsAppCallerScenario 按授权名单把它拒掉，
    /// 而且**不会**回头去试用途默认——这个调用方原本还能走池，搬完直接断流。
    /// 报成功的搬迁把流量搬没了，比不转更糟。
    ///
    /// 复用已有模型时搬迁刻意不动它的授权名单（那可能是人工调过的），所以这道检查
    /// 必须落在认领这一侧：名单容不下的认领就不转，并如实报出下一步。
    /// </summary>
    [Fact]
    public void 认领必须落在生效的授权名单之内()
    {
        var handler = MigrationHandler();

        // 新建与复用两条路共用同一个「生效名单」，不许各判各的——那正是这一族缺陷的形状。
        Assert.Contains("var effectiveAllowlist = existing is null", handler);
        Assert.Contains("? poolAllowlist", handler);
        Assert.Contains("existing.AsStringList(\"AllowedAppCallerCodes\")", handler);

        // 名单非空且容不下这个调用方时，认领不转。
        Assert.Contains("effectiveAllowlist.Count > 0 && !effectiveAllowlist.Contains(code", handler);

        // 报出来的理由要说清后果与下一步，不是一句「跳过」。
        Assert.Contains("那是断流", handler);

        // 本轮索引也要带上名单：同一个标识被第二个池撞上时，dry-run 与 apply 得按同一份名单判。
        Assert.Contains("{ \"AllowedAppCallerCodes\", new BsonArray(effectiveAllowlist) }", handler);
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
        Assert.Contains("unrestrictedSameType", handler);
        Assert.Contains("poolAllowlist", handler);
        Assert.Contains("{ \"AllowedAppCallerCodes\", new BsonArray(poolAllowlist) }", handler);

        // 没人设过限制就不写名单：那才是今天的真实行为
        Assert.Contains("restrictedSameType.Count == 0", handler);

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
        Assert.Contains("document[\"IsDefaultForType\"] = false", handler);
        // 认领撞车那一档不再把整份认领清空（第 53 轮 review：那会把一次影响一个调用方的并发
        // 放大成影响这个池的全部调用方）。它现在只去掉真被占走的那几个，报告里说清是哪几个。
        // 「只去掉被抢走的」这条性质由 GatewayDataDomainGuardTests 那条同名守卫盯着位置关系。
        Assert.Contains("document[\"DefaultForAppCallerCodes\"] = new BsonArray(keptClaims)", handler);
        Assert.Contains("这个池搬过来时没有带上它们", handler);
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

    /// <summary>
    /// 同一个兑换所底下的不同别名，搬迁时必须各成一条线路。
    ///
    /// 线路真正打给上游的是哪一个别名由 UpstreamModelId 决定，所以它们是不同的线路。
    /// 去重键只到兑换所为止的话，第一个成员占住键，后面每个别名都被静默跳过——
    /// 不报错、不进 Skipped 清单，而池路由已经删了，那些别名搬完就此消失。
    /// </summary>
    [Fact]
    public void 兑换所线路的身份要带上游模型标识()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        // 计划内去重键带上游模型标识
        Assert.Contains("$\"{logicalId}::exchange::{exchangeId}::{memberModelId}\"", console);

        // 查库那一侧同口径：只按 (模型, 兑换所) 查会把不同别名判成已存在。
        // 断言的是这条查询把上游模型标识也算进了身份，而不是某一行的写法。
        var dupAt = console.IndexOf("var existingExchangeRoute", StringComparison.Ordinal);
        Assert.True(dupAt > 0, "兑换所去重那一段找不到了，守卫取值口径需要更新");
        var dupEnd = console.IndexOf("plannedOfferingKeys.Add(exchangeRouteKey);", dupAt, StringComparison.Ordinal);
        Assert.True(dupEnd > dupAt);
        var dupBody = console[dupAt..dupEnd];
        // 身份必须带上「打给兑换所的是哪一个别名」这一维，且走那份共享判据——
        // 上一版逐字要求 `fb.Eq("UpstreamModelId", memberModelId)`，那是把当时的写法钉死：
        // 判据收敛成共享函数之后它会红，谁收敛谁的 CI 红（形状 4a），而收敛正是要做的事。
        Assert.Contains("OfferingIdentityPolicy.SameUpstreamFilter(\"exchange\", memberExchange, memberModelId)", dupBody);
    }

    /// <summary>
    /// 还在接不点名请求的对外模型不许直接删。
    ///
    /// 池退场之后，不点名的请求全靠「用途默认」与「按调用方认领」接住。删掉默认，
    /// 那个用途一个默认都不剩，所有不点名的请求当场失败；删掉认领方更隐蔽——
    /// 被认领的调用方不报错，它们会悄悄改走用途默认，换了个模型还没人知道。
    /// </summary>
    [Fact]
    public void 还在接流量的对外模型不许直接删()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        // 服务端拦：两种身份都要判，且回的是可识别的冲突码而不是笼统失败。
        Assert.Contains("MODEL_STILL_CATCHES_TRAFFIC", console);
        var deleteAt = console.IndexOf("app.MapDelete(\"/gw/logical-models/{id}\"", StringComparison.Ordinal);
        Assert.True(deleteAt > 0);
        var deleteEnd = console.IndexOf("logical-model.delete", deleteAt, StringComparison.Ordinal);
        Assert.True(deleteEnd > deleteAt);
        var deleteBody = console[deleteAt..deleteEnd];
        Assert.Contains("IsDefaultForType", deleteBody);
        Assert.Contains("DefaultForAppCallerCodes", deleteBody);
        // 拦必须发生在删线路之前：先删后拦等于把线路删了再说不许删。
        var blockAt = deleteBody.IndexOf("MODEL_STILL_CATCHES_TRAFFIC", StringComparison.Ordinal);
        var deleteOfferingsAt = deleteBody.IndexOf("gwModelOfferings.DeleteManyAsync", StringComparison.Ordinal);
        Assert.True(
            blockAt > 0 && deleteOfferingsAt > blockAt,
            "拦截必须排在删线路之前，否则拒绝的那次删除已经把线路删掉了");

        // 光靠「先读一遍再删」挡不住竞态：读完到删之间，另一个管理员完全可能刚把它设成默认、
        // 或者把一个调用方的认领转给它。真正的闸要长在删除语句的谓词上，没删到就回冲突。
        Assert.Contains("Builders<BsonDocument>.Filter.Ne(\"IsDefaultForType\", true)", deleteBody);
        Assert.Contains("Builders<BsonDocument>.Filter.Size(\"DefaultForAppCallerCodes\", 0)", deleteBody);
        Assert.Contains("deleted.DeletedCount == 0", deleteBody);

        // 前端先行拦一道：不要把人放进「输 publicId 确认」之后再拒，那是白走一趟。
        var page = ReadRepoFile("llmgw/web/src/pages/LogicalModelsPage.tsx");
        Assert.Contains("item.isDefaultForType", page);
        Assert.Contains("item.defaultForAppCallerCodes.length", page);
    }

    /// <summary>
    /// 搬迁要保住的是「非健康」这件事本身，不只是熔断那一档。
    ///
    /// 挑选判据把健康排在降级之前。一个刚刚在失败、被池排在健康成员后面的高优先级成员，
    /// 如果搬过去变成「健康 + 零失败」，切换的那一刻它立刻重新拿到主流量——这正是
    /// 影子比对当初抓熔断那一条时的同一个形状，只是换了个档位。
    /// </summary>
    [Fact]
    public void 搬迁保住近期的降级而不只是熔断()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var planner = ReadRepoFile("llmgw/console-api/Provisioning/PoolMigrationPlanner.cs");

        // 判据返回的是状态而不是布尔：调用方要写的本来就是状态，返回布尔逼着每个调用方
        // 自己拼一次 `? 2 : 0`，加第二个档位时漏掉哪一个都不会报错。
        Assert.Contains("public static int CarryHealthStatus(", planner);
        Assert.DoesNotContain("ShouldCarryUnavailable", planner);
        Assert.DoesNotContain("ShouldCarryUnavailable", console);

        // 降级与熔断两档都要认。
        Assert.Contains("status is not (1 or 2)", planner);

        // 两个写入点（物理模型线路、兑换所线路）都直接写这个状态，不再各自折算。
        var writes = System.Text.RegularExpressions.Regex
            .Matches(console, @"\{ ""HealthStatus"", carried\w+ \}").Count;
        Assert.True(writes >= 2, $"两条线路写入都要直接写搬过来的状态，实际只有 {writes} 处");
    }

    /// <summary>
    /// 成员自己配的输出上限在搬迁里会丢，必须如实报出来。
    ///
    /// 线路没有这个字段：走线路解析时输出上限取的是物理模型上的那个。成员上配过一个不一样的值时，
    /// 搬过去之后那条限制就不存在了——请求可能超过成员原本的上限，或者继承一个完全不同的全局上限，
    /// 而这件事不会有任何地方报错。给线路加覆盖层是新语义，先报出来，与价格丢失同一口径。
    /// </summary>
    [Fact]
    public void 搬迁如实报出会丢掉的成员输出上限()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("static string? DescribeLostMemberMaxTokens(", console);
        // 目标模型上已经是同一个值就不算丢，报出来只是噪音——与价格那一支同口径。
        Assert.Contains("physicalValue.Equals(memberValue)", console);
        // 两条线路都要报：兑换所那一侧没有物理模型可回落，成员配了就一定丢。
        var reported = System.Text.RegularExpressions.Regex
            .Matches(console, @"DescribeLostMemberMaxTokens\(member,").Count;
        Assert.True(reported >= 2, $"物理模型与兑换所两条线路都要报，实际只有 {reported} 处");
    }

    /// <summary>
    /// 搬迁的授权名单要按用途分开算。
    ///
    /// 一个调用方在不同用途下是不同的记录，各有各的池限制。全租户一锅算的话，它那条
    /// 「对话没设限制」的记录会让它进到一个**生图**池搬过来的模型的授权名单里，
    /// 而它那条生图记录其实把自己限制在别的池上——边界不是搬过去了，是被搬宽了。
    /// </summary>
    [Fact]
    public void 搬迁的授权名单按用途分开算()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        // 取数要带上用途，不带就没法分。
        Assert.Contains("Include(\"RequestType\")", console);
        // 两张表都按用途索引，翻译某个池时只看同用途的那些记录。
        Assert.Contains("restrictedCallersByType", console);
        Assert.Contains("unrestrictedCallerCodesByType", console);
        Assert.Contains("restrictedCallersByType.GetValueOrDefault(modelType)", console);
        Assert.Contains("unrestrictedCallerCodesByType.GetValueOrDefault(modelType)", console);
        // 旧的全租户口径不许残留。
        Assert.DoesNotContain("var unrestrictedCallerCodes = poolBoundCallers", console);
    }

    /// <summary>
    /// 三条唯一索引撞车各有各的处置，公开名那一条不许落进「默认冲突」那个 else。
    ///
    /// 公开名撞车重插必然再抛一次（带着同一个公开名），而这一趟前面几个池可能已经搬好了——
    /// 一次可报告的并发变成 500 加半批产物。正确处置是认下对方那一条，把线路挂上去。
    /// </summary>
    [Fact]
    public void 公开名撞车认下对方那一条而不是重插()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("uniq_llmgw_logical_model_tenant_public_id", console);
        Assert.Contains("linkedByRace", console);
        // 认下对方之前要复核用途：同名不同用途合成一条的话，原来那个用途一条路都没搬到，
        // 而赢家收了一批它根本用不了的上游。
        Assert.Contains("winnerType", console);
        Assert.Contains("同名不同用途不能合成一条", console);
        // 这个池的 id 也要记进赢家，否则还带着 model_policy=pool 的存量客户端点名时一律查不到。
        Assert.Contains("AddToSet(\"MigratedFromPoolIds\", poolId)", console);
        // 认下对方之后，后面的线路要挂到它的 id 上，而不是那条根本没插进去的。
        Assert.Contains("logicalId = winner.GetStringOrEmpty(\"_id\")", console);
        // 这一趟不算「建了一个模型」。
        Assert.Contains("if (linkedByRace) result.LinkedToExisting++;", console);

        // 三条索引都要被点名判：少认一条，它就落进一个与它无关的处置。
        var catchAt = console.IndexOf("两条唯一索引都可能在这里撞上", StringComparison.Ordinal);
        Assert.True(catchAt > 0 || console.Contains("uniq_llmgw_logical_claim_per_type", StringComparison.Ordinal));
        Assert.Contains("uniq_llmgw_logical_claim_per_type", console);
    }

    /// <summary>
    /// 聚合花费要认存量日志。
    ///
    /// 2026-09 之前的日志没有 CostStatus 字段，而聚合里写 `$eq CostStatus priced` 时
    /// Mongo 对缺字段判 false——那批算出过钱的日志一律记 0，模型卡与账本在上线当天
    /// 就把历史花费报少了一截。`/gw/logs/summary` 那条路早就用 ResolveLogCostStatus 回填了。
    /// </summary>
    [Fact]
    public void 聚合花费认存量日志且判据只有一份()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");

        Assert.Contains("static class LogCostAggregation", console);
        // 两个聚合点都走它，没人自己再拼一遍 $eq CostStatus priced。
        var usdUses = System.Text.RegularExpressions.Regex
            .Matches(console, @"LogCostAggregation\.UsdSum\(\)").Count;
        var unpricedUses = System.Text.RegularExpressions.Regex
            .Matches(console, @"LogCostAggregation\.UnpricedCount\(\)").Count;
        Assert.True(usdUses >= 2, $"两个聚合点都要走共享表达式，实际只有 {usdUses} 处");
        Assert.True(unpricedUses >= 2, $"未计价计数同上，实际只有 {unpricedUses} 处");
        Assert.DoesNotContain(
            "new BsonDocument(\"$eq\", new BsonArray { \"$CostStatus\", GatewayCostStatusNames.Priced })",
            console);
    }

    /// <summary>
    /// 调用全貌的落点判定要过「这个模型服不服务这个调用方」。
    ///
    /// 运行时在选中模型之后还要过授权名单与场景能力这道判据。面板不判的话，它会指着一条
    /// 运行时必拒的路说「会落到这里」——排障的人照着它去查，查的是一条根本走不到的路。
    /// </summary>
    [Fact]
    public void 调用全貌的落点判定过授权与能力()
    {
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        var policy = ReadRepoFile("llmgw/console-api/LogicalModels/LogicalModelCapabilityPolicy.cs");

        Assert.Contains("LogicalModelCapabilityPolicy.SupportsAppCallerScenario(", console);
        Assert.Contains("var usable = item.Enabled && hasEligibleRoute && serves;", console);

        // 镜像的顺序要与权威侧逐条相同，少一步就是一种输入被判反。
        Assert.Contains("RequiredScenarioCapability", policy);
        Assert.Contains("ImageLayeringAppCallerCode", policy);
        // 权威侧不写字面量、引的是注册表常量；镜像这边没有那个注册表，只能写字面量，
        // 所以断言的是「两处指的是同一个码」——注册表里那条常量的值必须与镜像逐字相同。
        var registry = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs");
        Assert.Contains("Layering = \"visual-agent.image.layering::generation\"", registry);
        Assert.Contains("visual-agent.image.layering::generation", policy);
        var authority = ReadRepoFile("prd-api/src/PrdAgent.Core/Models/GatewayCapabilityContract.cs");
        Assert.Contains("AppCallerRegistry.VisualAgent.Image.Layering", authority);
    }
}
