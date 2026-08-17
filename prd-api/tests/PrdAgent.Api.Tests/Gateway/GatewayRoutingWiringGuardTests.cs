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

    /// <summary>取从 <paramref name="start"/> 起、括号配平的完整调用文本。</summary>
    private static string CallText(string source, int start)
    {
        var open = source.IndexOf('(', start);
        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '(') depth++;
            else if (source[i] == ')')
            {
                depth--;
                if (depth == 0) return source[start..(i + 1)];
            }
        }
        throw new InvalidOperationException("括号不配平，无法截取调用文本");
    }

    [Fact]
    public void 每一处路由失败都必须带结构化错误码()
    {
        var source = ResolverSource();
        const string marker = "ModelResolutionResult.NotFound";
        var offending = new List<string>();
        var total = 0;

        for (var index = source.IndexOf(marker, StringComparison.Ordinal);
             index >= 0;
             index = source.IndexOf(marker, index + marker.Length, StringComparison.Ordinal))
        {
            total++;
            var call = CallText(source, index);
            if (!call.Contains("GatewayRouteFailure.", StringComparison.Ordinal))
                offending.Add(call.Length > 200 ? call[..200] : call);
        }

        total.ShouldBeGreaterThan(20, "Resolver 里的失败返回点数量异常，守卫可能没扫到真实文件");
        offending.ShouldBeEmpty(
            "以下失败返回没有带 GatewayRouteFailure 错误码，会退回「所有失败包装成同一个不可用」："
            + string.Join(" | ", offending));
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
