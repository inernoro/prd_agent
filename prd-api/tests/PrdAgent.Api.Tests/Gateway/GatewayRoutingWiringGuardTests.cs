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
    }

    /// <summary>
    /// 兑换所来的模型必须被**显式认出来**，不许靠「llmgw_models 查不到」顺带落进「管不着」。
    ///
    /// 两者结果都是放行，所以删掉这段判断不会有任何用例变红（形状 2）——变的是这道门
    /// 说得出说不出自己为什么放行。落进「管不着」的那种放行是漏判：下一个人读代码会以为
    /// 兑换所本来就不在门的射程内，于是给兑换所补放行标记这件事永远排不上队。
    /// </summary>
    [Fact]
    public void 兑换所来的模型必须被显式认出而不是顺带落进管不着()
    {
        var source = ResolverSource();
        var start = source.IndexOf("private async Task<CatalogVerdict> JudgeAsync(", StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, "找不到裁决本体，守卫扫错文件或方法被改名");
        // 调用点的取值范围只到辅助方法的声明为止：放宽到把声明本身包进来，
        // 删掉调用、只留下一个没人用的辅助方法，这条守卫照样绿（形状 2 的递归）。
        var helperAt = source.IndexOf("private async Task<bool> IsGatewayExchangeAsync(", start, StringComparison.Ordinal);
        helperAt.ShouldBeGreaterThan(start, "找不到兑换所判定辅助，守卫的取值范围需要跟着改");
        source[start..helperAt].ShouldContain(
            "IsGatewayExchangeAsync(",
            customMessage: "名录门没有认出兑换所来的模型：它们会静默落进「管不着」，放行却说不出依据");

        // 判据必须真去查兑换所集合，而不是把「PlatformId 长得像兑换所 id」当证据（形状 8）。
        var end = source.IndexOf("\n    private static bool IsAllowedOutsideCatalog", helperAt, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(helperAt, "辅助方法与放行标记读取的相邻关系变了，守卫的取值范围需要跟着改");
        source[helperAt..end].ShouldContain(
            "llmgw_model_exchanges",
            customMessage: "认兑换所要真去查那张表；靠 id 前缀之类的形状猜，换个 id 生成方式就静默失效");
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

        // 补标记的那次写入必须落在「认领成功」的分支里，不能挂在启动路径上无条件执行。
        const string stamp = "\"AllowedOutsideCatalogBy\", \"存量迁移（名录门上线前已入库，未经人工审阅）\"";
        var stampAt = console.IndexOf(stamp, StringComparison.Ordinal);
        stampAt.ShouldBeGreaterThanOrEqualTo(0, "找不到存量放行的盖戳写入，守卫的取值范围需要跟着改");

        var claimAt = console.IndexOf("if (grandfatherClaimed)", StringComparison.Ordinal);
        claimAt.ShouldBeGreaterThanOrEqualTo(0, "存量放行迁移没有认领判断，等于每次启动都跑一遍");
        claimAt.ShouldBeLessThan(stampAt, "盖戳写入必须在认领判断之内，否则每次重启都会把新塞进来的模型一并放行");

        // 只许有这一处盖戳：再抄一份出去，标记守卫就形同虚设。
        console.Split(stamp).Length.ShouldBe(2, "存量放行的盖戳只允许出现在迁移这一处");
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
