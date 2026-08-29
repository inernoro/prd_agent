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

        var end = source.IndexOf("\n    private async Task<bool> IsModelAllowedAsync(", start, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(start, "名录门与放行判定的相邻关系变了，守卫的取值范围需要跟着改");
        var gate = source[start..end];

        gate.ShouldContain("GatewayRouteFailure.ModelNotInCatalog");
        gate.ShouldContain("RetryCandidates");
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
