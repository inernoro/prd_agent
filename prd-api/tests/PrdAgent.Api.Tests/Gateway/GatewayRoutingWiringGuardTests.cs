using System.Text.RegularExpressions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 接线守卫（predicate-and-wiring-discipline 形状 2 / 形状 3 / 形状 7）。
///
/// 这几件事「删掉之后编译照过、全量测试照绿」，所以必须有源码级守卫：
/// 1. Resolver 的每一处失败返回都带结构化错误码——漏一处就又回到「所有失败长一个样」；
/// 2. Resolver 不许再自带一份能力字面量清单；
/// 3. readiness 必须真的调用生产判据，而不是自写一套近似逻辑；
/// 4. 事故止血的历史别名兼容不许被静默撤销。
/// </summary>
public sealed class GatewayRoutingWiringGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "CLAUDE.md"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new InvalidOperationException("找不到仓库根：向上没有同时含 CLAUDE.md 与 prd-api 的目录");
    }

    private static string ResolverSource() => File.ReadAllText(Path.Combine(
        RepoRoot(), "prd-api", "src", "PrdAgent.Infrastructure", "LlmGateway", "ModelResolver.cs"));

    private static string ReadinessSource() => File.ReadAllText(Path.Combine(
        RepoRoot(), "llmgw", "serving", "GatewayServingReadinessProbe.cs"));

    /// <summary>
    /// 「每一处路由失败都必须带结构化错误码」由**编译器**保证：
    /// <c>ModelResolutionResult.NotFound</c> 的 failureCode 是必填参数，漏一处直接编译不过。
    ///
    /// 这里守的是「有人把它改回可选」——那一刻编译器就不再兜底，
    /// 而漏带错误码是静默退化（编译过、测试绿、只是所有失败又长成一个样）。
    ///
    /// 为什么不用源码扫描逐个调用点找 <c>GatewayRouteFailure.</c> 字面量：
    /// 「空池 vs 全熔断」那处的错误码是按情况算出来的变量，字面量判据会误报；
    /// 放宽成「认识几个变量名」又会让真正忘带的溜过去——两头都不成立（形状 1）。
    /// 必填参数是唯一不靠拼写的判据。
    /// </summary>
    [Fact]
    public void 路由失败的错误码是编译期必填参数()
    {
        var contract = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Core", "LlmGateway", "IModelResolver.cs"));

        contract.ShouldContain(
            "string failureCode,",
            customMessage: "NotFound 的 failureCode 必须是必填参数；一旦带上默认值，漏带错误码就变成静默退化");
        contract.ShouldNotContain(
            "string? failureCode = null",
            customMessage: "failureCode 不得回退成可选参数");
    }

    [Fact]
    public void Resolver_的失败返回点仍然存在且数量正常()
    {
        var source = ResolverSource();
        const string marker = "ModelResolutionResult.NotFound";
        var total = 0;

        for (var index = source.IndexOf(marker, StringComparison.Ordinal);
             index >= 0;
             index = source.IndexOf(marker, index + marker.Length, StringComparison.Ordinal))
        {
            total++;
        }

        // 判据不是恒真：扫错文件或 Resolver 被掏空时这里会红。
        total.ShouldBeGreaterThan(20, "Resolver 里的失败返回点数量异常，守卫可能没扫到真实文件");
    }

    [Fact]
    public void Resolver_不再自带能力字面量清单()
    {
        var source = ResolverSource();

        // 只允许出现在转发给契约的那一行注释里；判定用的字面量一个都不许留。
        source.ShouldNotContain("\"image_generation\"");
        source.ShouldNotContain("\"text2img\"");
        source.ShouldNotContain("\"img2img\"");
        source.ShouldNotContain("\"vision_generation\"");
        source.ShouldNotContain(".EndsWith(\".text2img::generation\"");
        source.ShouldContain("GatewayCapabilityContract.SupportsAppCallerScenario");
    }

    [Fact]
    public void Readiness_使用生产同款场景判据()
    {
        var source = ReadinessSource();

        source.ShouldContain(
            "GatewayCapabilityContract.SupportsAppCallerScenario",
            customMessage: "readiness 必须跑 MAP 运行时真正用的判据；只看池在不在，就是 2026-08-13 那次「全绿但功能死了」");
        source.ShouldContain("GatewayCapabilityContract.RequiredScenarioCapability");
        source.ShouldContain("scenario-capability");
    }

    /// <summary>
    /// 名录门必须罩住 <c>IModelResolver</c> 的**每一个**解析入口。
    ///
    /// 这条接线删掉之后编译照过、全量测试照绿——只是白名单在数据面静默失效，
    /// 名录外的模型又能被打出去，而唯一的症状是「本该被拦的请求成功了」（形状 2）。
    ///
    /// 判据从接口反推而不是写死两个方法名：日后接口新增第三个解析入口时，
    /// 它要么也走这道门，要么这条用例红——不会像现在这样悄悄多出一条没设防的路。
    /// </summary>
    [Fact]
    public void 每个解析入口都必须过名录门()
    {
        var contract = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Core", "LlmGateway", "IModelResolver.cs"));
        var source = ResolverSource();

        var entryPoints = System.Text.RegularExpressions.Regex
            .Matches(contract, @"Task<ModelResolutionResult>\s+(\w+)\s*\(")
            .Select(m => m.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        // 判据不是恒真：接口被掏空或正则失配时这里先红。
        entryPoints.Count.ShouldBeGreaterThanOrEqualTo(2, "IModelResolver 的解析入口数量异常，守卫可能没扫到真实契约");

        foreach (var entry in entryPoints)
        {
            var signature = $"public async Task<ModelResolutionResult> {entry}(";
            var start = source.IndexOf(signature, StringComparison.Ordinal);
            start.ShouldBeGreaterThanOrEqualTo(0, $"ModelResolver 里找不到 {entry} 的实现，守卫扫错文件或方法被改名");

            // 薄壳的边界：下一个 private 声明。壳体内必须出现名录门的调用。
            var end = source.IndexOf("\n    private ", start, StringComparison.Ordinal);
            var body = end > start ? source[start..end] : source[start..];

            body.ShouldContain(
                "ApplyCatalogGateAsync(",
                customMessage: $"{entry} 没有经过名录门：白名单在数据面会静默失效，名录外的模型照样能被打出去");
        }
    }

    /// <summary>
    /// 门内的两件事同样「删掉不会红」：拒绝要用专属错误码（否则退化成又一个「服务不可用」），
    /// 重试候选要一起过门（否则主选被拦下、第一次失败后换条路照样打出去）。
    /// </summary>
    [Fact]
    public void 名录门拒绝时点名错误码且重试候选一并过门()
    {
        var source = ResolverSource();
        var start = source.IndexOf("private async Task<ModelResolutionResult> ApplyCatalogGateAsync(", StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, "找不到名录门本体");

        var end = source.IndexOf("\n    private enum CatalogVerdict", start, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(start, "名录门与裁决枚举的相邻关系变了，守卫的取值范围需要跟着改");
        var gate = source[start..end];

        gate.ShouldContain("GatewayRouteFailure.ModelNotInCatalog");
        gate.ShouldContain("RetryCandidates");
        // 「管不着」必须与「拦下」分开：合成一档就会把运维配的应急兜底一起判死。
        gate.ShouldContain("CatalogVerdict.Blocked");

        // 批量取回只许省往返，不许长出第二个判据：放行判定在全文件只能有这一处。
        // 抄一份进批量分支，两条取值路径就会各判各的，而它们本该是同一道门（形状 3）。
        Regex.Matches(source, Regex.Escape("docs.Any(IsAllowedOutsideCatalog)")).Count.ShouldBe(
            1,
            "名录门的放行判定只允许有一处；批量与单条两条路径必须喂给同一个判据");
        // 两条路径的每对判定还必须共用同一个条数上限——一边看 20 条、另一边看全部，
        // 同一对输入会在两条路径上得到不同结论。
        Regex.Matches(source, Regex.Escape("CatalogPairDocumentCap")).Count.ShouldBeGreaterThanOrEqualTo(
            3,
            "单条查询与批量筛选都要按同一个上限截断（常量定义 + 两处使用）");
    }

    /// <summary>
    /// 兑换所来的模型必须被**显式认出来**，而且判的是**这一条别名**、不是「它来自兑换所」。
    ///
    /// 两层都「删掉不会红」：
    /// - 不认出来 → 静默落进「管不着」，结果同样是放行，只是这道门说不出自己为什么放行（形状 2）；
    /// - 认容器不认条目 → 往兑换所里加一个从没被人看过的别名照样过，正是名录门要拦的形态，
    ///   只是换了个集合（形状 1：判据比它该管的范围宽）。
    /// </summary>
    [Fact]
    public void 兑换所来的模型必须逐条判放行而不是认整个兑换所()
    {
        var source = ResolverSource();
        var start = source.IndexOf("private async Task<CatalogVerdict> JudgeAsync(", StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, "找不到裁决本体，守卫扫错文件或方法被改名");
        // 调用点的取值范围只到辅助方法的声明为止：放宽到把声明本身包进来，
        // 删掉调用、只留下一个没人用的辅助方法，这条守卫照样绿（形状 2 的递归）。
        var helperAt = source.IndexOf("private async Task<CatalogVerdict?> JudgeExchangeModelAsync(", start, StringComparison.Ordinal);
        helperAt.ShouldBeGreaterThan(start, "找不到兑换所判定辅助，守卫的取值范围需要跟着改");
        source[start..helperAt].ShouldContain(
            "JudgeExchangeModelAsync(",
            customMessage: "名录门没有认出兑换所来的模型：它们会静默落进「管不着」，放行却说不出依据");

        var end = source.IndexOf("\n    private static bool IsAllowedOutsideCatalog", helperAt, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(helperAt, "辅助方法与放行标记读取的相邻关系变了，守卫的取值范围需要跟着改");
        var helper = source[helperAt..end];

        // 判据必须真去查兑换所集合，而不是把「PlatformId 长得像兑换所 id」当证据（形状 8）。
        helper.ShouldContain(
            "llmgw_model_exchanges",
            customMessage: "兑换所判定必须真的查那个集合");
        // 并且必须判到条目这一层：声明过这条别名 + 这条别名带着放行标记。
        helper.ShouldContain(
            "AllowedOutsideCatalog",
            customMessage: "认「它来自兑换所」就放行等于认容器：往兑换所加一个没人看过的别名照样过门");
        helper.ShouldContain(
            "ModelId",
            customMessage: "必须核对兑换所里确实声明过这条别名，否则别处拼一个 PlatformId 就能借道");
    }

    /// <summary>
    /// 存量放行迁移只许跑一次，且必须由库里的迁移标记记住跑没跑过。
    ///
    /// 「只改没有这个字段的文档」看着幂等，其实判据太窄（形状 1）：它认的是「此刻缺标记」，
    /// 要表达的却是「名录门上线前就已入库」。两者只在第一次启动时重合——此后绕过控制台
    /// 直接写库塞进来的模型（正是这道门要拦的那一种）同样缺标记，下次重启就被自动放行，
    /// 门每重启一次自己开一道缝，而且全程不会有任何测试变红。
    /// </summary>
    [Fact]
    public void 存量放行迁移必须由持久标记守住只跑一次()
    {
        var console = File.ReadAllText(Path.Combine(RepoRoot(), "llmgw", "console-api", "Program.cs"));

        console.ShouldContain("llmgw_migrations", customMessage: "迁移标记要落库，跑过就永不再跑");
        console.ShouldContain("model-catalog-grandfather-v1");
        // 归一化口径收紧会把一批「旧口径判成名录内、因而导入时没盖过标记」的存量模型变成名录外，
        // 而上一条迁移早跑完了——它们没有补戳的时机。所以口径收紧要自带它自己的一次性窗口。
        console.ShouldContain(
            "model-catalog-grandfather-v2-strict-vendor-prefix",
            customMessage: "归一化口径收紧没有配套的一次性窗口，存量模型会在 enforce 档下当场开始被拒");
        // 兑换所改判逐条放行标记，同样要给存量一个一次性窗口——存量兑换所是在盖戳之前建的。
        console.ShouldContain(
            "exchange-model-allowance-v1",
            customMessage: "兑换所逐条放行没有配套的一次性窗口，存量兑换所的别名会集体开始被拒");

        // 补标记的那次写入必须落在「认领成功」的分支里，不能挂在启动路径上无条件执行。
        // 判据（「此刻缺标记」）本身太窄，全靠认领把它限定在某一个时刻。
        var runnerAt = console.IndexOf(
            "async Task<long> RunCatalogGrandfatherAsync(", StringComparison.Ordinal);
        runnerAt.ShouldBeGreaterThanOrEqualTo(0, "找不到存量放行的执行体，守卫的取值范围需要跟着改");
        var runnerEnd = console.IndexOf("\n/*", runnerAt, StringComparison.Ordinal);
        runnerEnd.ShouldBeGreaterThan(runnerAt, "执行体与随后的注释相邻关系变了，守卫的取值范围需要跟着改");
        var runner = console[runnerAt..runnerEnd];

        const string stamp = "\"AllowedOutsideCatalog\", true)";
        var stampAt = runner.IndexOf(stamp, StringComparison.Ordinal);
        stampAt.ShouldBeGreaterThanOrEqualTo(0, "找不到存量放行的盖戳写入，守卫的取值范围需要跟着改");

        var claimAt = runner.IndexOf("if (claimedAt is null) return -1;", StringComparison.Ordinal);
        claimAt.ShouldBeGreaterThanOrEqualTo(0, "存量放行迁移没有认领判断，等于每次启动都跑一遍");
        claimAt.ShouldBeLessThan(stampAt, "盖戳写入必须在认领判断之后，否则每次重启都会把新塞进来的模型一并放行");

        // 只许有这一处盖戳：再抄一份出去，标记守卫就形同虚设。
        console.Split(stamp).Length.ShouldBe(2, "存量放行的盖戳只允许出现在迁移执行体这一处");
    }

    /// <summary>
    /// 系统级密钥的「退役旧 key」必须同时带两个条件：不碰设置指向的胜者、也不碰刚签出来的新 key。
    ///
    /// 只判胜者不够：两个并发请求各自回读到自己那把当胜者，接着互相把对方停用，
    /// 最后两把都是停用的、设置还指着其中一把——回读与停用之间没有原子性。
    /// 加上「只停用够老的」之后，谁也够不着对方那把刚签出来的 key，不需要锁。
    /// 删掉任一条件，这条用例都该红。
    /// </summary>
    [Fact]
    public void 系统密钥退役必须避开胜者与新签的那把()
    {
        var console = File.ReadAllText(Path.Combine(RepoRoot(), "llmgw", "console-api", "Program.cs"));
        var start = console.IndexOf("async Task RetireStaleSystemKeysAsync(", StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, "找不到共享的退役判定，守卫的取值范围需要跟着改");
        var end = console.IndexOf("\n/// <summary>", start, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(start, "退役判定与下一个成员的相邻关系变了，守卫的取值范围需要跟着改");
        var retire = console[start..end];

        retire.ShouldContain(
            "Eq(\"SystemManaged\", true)",
            customMessage: "归属要认标记不认名字：只按名字扫，用户那把同名 key 会被每次系统调用连坐撤销");
        retire.ShouldContain("Ne(\"_id\", winnerKeyId)", customMessage: "必须放过设置指向的那把，否则设置会指着一把已停用的密钥");
        retire.ShouldContain("Lt(\"CreatedAt\", retireBefore)", customMessage: "必须放过刚签出来的 key，否则两个并发请求会互相把对方停用");

        // 两条路径都要扫：签发路径扫完就返回，复用路径（库里那把还能用，直接 return）不扫的话，
        // 并发落败的那把此后永远等不到下一次签发，「只多留 5 分钟」就成了空话。
        console.Split("await RetireStaleSystemKeysAsync(").Length.ShouldBe(
            3,
            "退役必须在签发路径与复用路径各调一次——少一处就会攒下永不退役的系统密钥");
    }

    /// <summary>
    /// 作废系统密钥前必须确认「设置里现在这把，就是刚才失败的那把」。
    ///
    /// 并发下两个请求可能都拿着 A 去调：第一个失败后已经重签成 B，第二个再进来时
    /// 设置里已经是 B——不比对就会把好端端的 B 撤掉，第一个请求的重试反而拿到一把
    /// 刚被撤销的 key，凭据自愈变成互相拆台。删掉比对不会有任何用例变红，只是自愈
    /// 在并发下变成自伤（形状 5：拿变更后的状态去撤销一个已经不成立的判断）。
    /// </summary>
    [Fact]
    public void 作废系统密钥必须认准刚才失败的那一把()
    {
        var console = File.ReadAllText(Path.Combine(RepoRoot(), "llmgw", "console-api", "Program.cs"));
        var start = console.IndexOf("async Task InvalidateSystemCredentialAsync(", StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, "找不到系统密钥作废逻辑，守卫的取值范围需要跟着改");
        // 取值范围只到这个顶层局部函数的收尾大括号为止——放宽到「下一段注释」的话，
        // 底下几万行里随便一处 StringComparison.Ordinal 都能把守卫喂饱（形状 6）。
        var end = console.IndexOf("\n}\n", start, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(start, "作废逻辑的收尾大括号找不到，守卫的取值范围需要跟着改");
        var invalidate = console[start..end];

        invalidate.ShouldContain(
            "failedKey",
            customMessage: "作废必须点名是哪一把失败了，否则并发下会撤掉别的请求刚签好的密钥");
        invalidate.ShouldContain(
            "ServiceKeyEncrypted",
            customMessage: "比对要拿设置里当前那把的明文比，只比 keyId 之类的旁证不算");
        invalidate.ShouldContain(
            "StringComparison.Ordinal",
            customMessage: "密钥比对必须逐字，不许大小写不敏感或文化相关比较");
        // 比对完到清设置之间还有一段空档：这期间别人可能已经重签并写进了新的那把。
        // 清设置只按租户 id 过滤，就会把新的一起抹掉——比对白做。谓词里必须带上密文，
        // 让库自己判「还是不是刚才那把」（形状 5：拿变更前的判断去执行变更后的动作）。
        invalidate.ShouldContain(
            "Eq(\"ServiceKeyEncrypted\", staleEncrypted)",
            customMessage: "清设置必须带上刚才那把的密文做条件，否则并发下会抹掉别人刚签好的密钥");

        // 两个调用点都要把失败的那把传进来；少传一处，那条路径就退回旧的「见失败就撤」。
        var callSites = console.Split("await InvalidateSystemCredentialAsync(");
        callSites.Length.ShouldBe(
            3,
            "测试连接与推导草稿两条路径都要作废刚才失败的那把——数量变了说明有路径漏改或多出一条没设防的");
        foreach (var tail in callSites.Skip(1))
        {
            tail[..Math.Min(tail.Length, 80)].ShouldContain(
                "access.Key",
                customMessage: "调用点必须把这次真正用出去的那把 key 传进来，不能让作废逻辑自己猜");
        }
    }

    /// <summary>
    /// 系统调用钉池时必须同时声明策略，且设置页存下去的选择必须是运行时解析得到的那一种。
    ///
    /// 两件事都「删掉不会红」，症状却是同一个：设置页说着 A，实际跑的是 B。
    /// - 只发池 id 不发策略：serving 按 body 的 model 推策略，而这两条请求的 model 恒是
    ///   「auto」（非空）→ 推成 pinned；池 id 只在策略为 pool 时才顶替 ExpectedModel 进解析，
    ///   于是选中的池只进了日志上下文，真正跑的是 appCaller 绑定或默认池。
    /// - 写端点的校验比运行时松：页面加载后被停用/改了类型的模型仍能存进去，
    ///   下一次系统调用解析不到它就静默落回默认池，而「测试连接」还会报成功。
    /// </summary>
    [Fact]
    public void 系统调用钉池要声明策略且存的选择必须是运行时认的那一种()
    {
        var console = File.ReadAllText(Path.Combine(RepoRoot(), "llmgw", "console-api", "Program.cs"));

        // 每一处发池 id 的地方都要配一处声明策略；数量对不上就是有一条路径漏了。
        var poolHeaders = console.Split("\"X-Gateway-Model-Pool-Id\"").Length - 1;
        var policyHeaders = console.Split("\"X-Gateway-Model-Policy\"").Length - 1;
        poolHeaders.ShouldBeGreaterThanOrEqualTo(2, "系统调用的钉池请求数量异常，守卫可能没扫到真实文件");
        policyHeaders.ShouldBe(
            poolHeaders,
            "每一处发 X-Gateway-Model-Pool-Id 的系统调用都必须同时发 X-Gateway-Model-Policy: pool，"
            + "否则 serving 会按 body 的 model 把策略推成 pinned，选中的池根本不参与解析");

        // 存设置时的校验谓词必须与读端点、运行时同口径：本租户 + chat + 未停用。
        var saveAt = console.IndexOf("MODEL_POOL_REQUIRED", StringComparison.Ordinal);
        saveAt.ShouldBeGreaterThanOrEqualTo(0, "找不到设置写端点的校验段，守卫的取值范围需要跟着改");
        var saveEnd = console.IndexOf("system_settings.update", saveAt, StringComparison.Ordinal);
        saveEnd.ShouldBeGreaterThan(saveAt, "写端点校验与审计写入的相邻关系变了，守卫的取值范围需要跟着改");
        var save = console[saveAt..saveEnd];

        save.ShouldContain(
            "Eq(\"ModelType\", \"chat\")",
            customMessage: "存池/存模型时要判类型，否则钉一个非对话类的进去，运行时解析不到就静默落回默认池");
        save.ShouldContain(
            "Ne(\"Enabled\", false)",
            customMessage: "存模型时要判未停用：页面加载后被停用的模型仍能存进去，下一次系统调用就落回默认池了");
    }

    /// <summary>
    /// 系统 appCaller 的归属认标记、不认码；推导端点认失败帧、且有 completion 上限。
    ///
    /// 三件事都「删掉不会红」：
    /// - 只按码认归属，租户自助登记的同码 appCaller 会被搬进系统团队，其团队级密钥随后 403；
    /// - 不认失败帧，模型在失败前吐出可解析 JSON 时，端点会对一次失败且计费的调用回 ok:true；
    /// - 没有 completion 上限，一次注入式长 intent 就能让模型生成到 40 秒 deadline，花的是平台的钱。
    /// </summary>
    [Fact]
    public void 系统调用方认标记且推导端点认失败帧并有上限()
    {
        var console = File.ReadAllText(Path.Combine(RepoRoot(), "llmgw", "console-api", "Program.cs"));

        // 一、接管别人的同码 appCaller 是唯一会动到用户既有数据的路径，必须先判归属再搬。
        var ensureAt = console.IndexOf("var existingCaller = await gwAppCallers.Find(callerFilter)", StringComparison.Ordinal);
        ensureAt.ShouldBeGreaterThanOrEqualTo(0, "找不到系统 appCaller 的登记段，守卫的取值范围需要跟着改");
        // 取值范围要盖住 if/else 两支：先查到的那支判 callerIsOurs，新建那支撞唯一索引后回读复判
        // winnerIsOurs。只切到 else 之前就只剩一条路径可查，另一条默默接管别人的 appCaller 也不会红。
        var ensureEnd = console.IndexOf(
            "var keyId = settings.AsNullableString(\"ServiceKeyId\");", ensureAt, StringComparison.Ordinal);
        ensureEnd.ShouldBeGreaterThan(ensureAt, "登记段与随后的密钥自愈段相邻关系变了，守卫的取值范围需要跟着改");
        var ensure = console[ensureAt..ensureEnd];
        ensure.ShouldContain(
            "callerIsOurs",
            customMessage: "搬迁前必须先判这条是不是系统自建的；只按码搬会把租户自助登记的同码 appCaller 搬进系统团队");
        ensure.ShouldContain(
            "SystemManaged",
            customMessage: "归属认标记，不认码——码没有被任何地方保留，租户可以自助登记同名的一条");
        // 插入撞唯一索引那一支同样要复判：赢的可能是用户刚登记的业务文档，
        // 假定「赢的是我们」会让后面签出来的系统密钥一路 403，而凭据自愈修不好归属。
        ensure.ShouldContain(
            "winnerIsOurs",
            customMessage: "撞唯一索引后必须回读胜者并复判归属，不能假定赢的那条是系统自己建的");
        // 两条归属拒绝路径（先查到 / 撞索引后回读）都要给同一套说得出原因的失败。
        Regex.Matches(ensure, "系统功能不会接管它").Count.ShouldBe(
            2,
            "两条归属判定路径都要拒绝并说明原因；少一条就是有一条路径会默默接管别人的 appCaller");

        // 二、推导端点的读流段：既要认流里夹着的失败帧，也要认「流根本没读完」。
        // 取值范围限定在读流到解析之间——放宽到全文件的话，底下那个辅助方法的定义
        // 就能把断言喂饱，删掉调用点照样绿（建了一半的接线正是这么活下来的）。
        var drainAt = console.IndexOf("var streamCompleted = false;", StringComparison.Ordinal);
        drainAt.ShouldBeGreaterThanOrEqualTo(0, "推导端点必须跟踪完成标记；没有它，EOF 就等于「收完了」");
        var drainEnd = console.IndexOf("var parsed = ParseIntentDraft(", drainAt, StringComparison.Ordinal);
        drainEnd.ShouldBeGreaterThan(drainAt, "读流段与解析段的相邻关系变了，守卫的取值范围需要跟着改");
        var drain = console[drainAt..drainEnd];
        drain.ShouldContain(
            "TryReadIntentDraftStreamError(",
            customMessage: "推导端点不认失败帧的话，会对一次失败且计费的调用回 ok:true");
        // 认失败帧还不够：serving 的取消路径既不发失败帧也不发 [DONE]，直接把响应关掉。
        // 只认「有没有失败帧」的话，EOF 就等于收完了——模型在断流前恰好吐出一段可解析 JSON 时，
        // 一次被取消/截断的计费调用会被当成成功的推导结果交出去。
        drain.ShouldContain(
            "payload == \"[DONE]\") { streamCompleted = true;",
            customMessage: "收到结束标记才算收完；只 continue 掉它等于没有完成判据");
        drain.ShouldContain(
            "if (!streamCompleted)",
            customMessage: "没有完成标记就不许把这段文本交给解析器——那是一次被截断的计费调用");
        // 二'、钉池不只是发个头：候选池只来自这条 appCaller 的绑定，
        // 不把选中的池绑上去，跑的仍是默认池，而设置页写着「只在这个池里调度」。
        // 非 pool 档位要摘掉绑定，否则改回「交给网关挑」之后还钉在上次那个池上。
        console.ShouldContain(
            "Set(\"ModelPoolId\", poolId)",
            customMessage: "选中的池必须绑到系统 appCaller 上；只发策略头的话解析器根本看不到这个池");
        console.ShouldContain(
            "Unset(\"ModelPoolId\")",
            customMessage: "非「钉一个池」档位必须摘掉绑定，否则改回交给网关挑之后还钉在上次那个池上");

        // 三、成本闸：上限本身 + 累积体积上限，两道都要在。
        console.ShouldContain(
            "max_tokens = IntentDraftMaxCompletionTokens",
            customMessage: "推导请求必须带紧的 completion 上限：系统 appCaller 没有预算闸，花的是平台的钱");
        console.ShouldContain(
            "IntentDraftMaxRawChars",
            customMessage: "上游若无视 max_tokens，累积体积仍需第二道闸");
    }

    /// <summary>
    /// 视觉类测试用内嵌图时，问题仍然要用**用户写的那句**。
    ///
    /// 写死一句不会有任何用例变红——输入框照常显示他写的内容，发出去的却是别的。
    /// 这里守的是「无附件那一支把算出来的 prompt 传下去」这条接线本身。
    /// </summary>
    [Fact]
    public void 视觉类无附件时仍用用户写的那句()
    {
        var page = File.ReadAllText(Path.Combine(
            RepoRoot(), "llmgw", "web", "src", "pages", "QuickstartPage.tsx"));

        var branchAt = page.IndexOf("if (!attachment) {", StringComparison.Ordinal);
        branchAt.ShouldBeGreaterThanOrEqualTo(0, "找不到视觉类无附件分支，守卫的取值范围需要跟着改");
        var branchEnd = page.IndexOf("}", page.IndexOf("return visionOpenAiContent", branchAt, StringComparison.Ordinal), StringComparison.Ordinal);
        branchEnd.ShouldBeGreaterThan(branchAt, "无附件分支的结构变了，守卫的取值范围需要跟着改");
        var branch = page[branchAt..branchEnd];

        foreach (var helper in new[] { "visionClaudeContent", "visionGeminiParts", "visionOpenAiContent" })
        {
            branch.ShouldContain(
                $"{helper}(prompt)",
                customMessage: $"{helper} 必须收下算出来的 prompt；不传就等于输入框里写一句、发出去另一句");
        }
    }

    [Fact]
    public void 历史别名兼容不得被静默撤销()
    {
        var contract = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Core", "Models", "GatewayCapabilityContract.cs"));

        contract.ShouldContain(
            "[\"image-gen\"] = ImageGeneration",
            customMessage: "正式数据迁移完成并有回滚方案前，image-gen 兼容不得撤销（任务书明确禁止）");
    }
}
