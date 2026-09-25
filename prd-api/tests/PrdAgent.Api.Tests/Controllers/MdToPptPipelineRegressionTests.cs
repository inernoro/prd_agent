using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 2026-09-25 MD 转 PPT 两条 P1 的回归守卫：
/// N1 每一页都退化成兜底版式（页面请求钉了网关不认识的旧池模型名）；
/// N2 刚生成的演示稿「发布为网页」「重绘本页」一律 409（done 事件下发的不是落库那份正文）。
/// </summary>
public class MdToPptPipelineRegressionTests
{
    private const string PoolUnbound = GatewayRouteFailure.AppCallerPoolUnbound;

    [Fact]
    public void PageModelRoute_ImplicitProfileRejectedByGateway_SwitchesOnceToGatewayDefault()
    {
        // 事故现场：默认运行配置「池 · gpt-5.6-sol」是旧 MAP 模型池物化出来的，网关只认对外模型，
        // 页面请求在解析阶段被以 APPCALLER_POOL_UNBOUND 拒绝。
        var route = new MdToPptPageModelRoute("gpt-5.6-sol", explicitlySelected: false);
        route.ExpectedModelFor(route.Outcome).ShouldBe("gpt-5.6-sol");

        var first = route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, PoolUnbound);
        first.ShouldBe((MdToPptPageModelOutcome.UseGatewayDefault, true));
        route.ExpectedModelFor(route.Outcome).ShouldBeNull("改道后不点名，交给网关按该用途的默认对外模型选");
        var notice = route.SubstitutionNotice("gpt-5.6-sol-2026");
        notice.ShouldContain("gpt-5.6-sol", customMessage: "改判必须说清原来点名的是谁");
        notice.ShouldContain("gpt-5.6-sol-2026", customMessage: "改判必须说清这次实际用的是谁");

        // 并行的另一页也按旧路线撞了同一堵墙：不重复切换、不升级成拒绝，按新路线重试即可。
        var second = route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, PoolUnbound);
        second.ShouldBe((MdToPptPageModelOutcome.UseGatewayDefault, false));

        var wire = MdToPptController.BuildGatewayPageRequest(
            new InfraAgentRuntimeProfile { Model = "gpt-5.6-sol" }, "sys", "usr",
            AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate,
            modelRoute: route, routeOutcome: route.Outcome);
        wire.ExpectedModel.ShouldBeNull();
    }

    [Fact]
    public void PageModelRoute_AnnouncesSubstitutionOnlyOnceAndOnlyAfterSwitching()
    {
        // 改判提示只在改道后的请求真被网关接住时发一次：并行几页各自拿到 Start，也只宣布一次；
        // 没改道之前不宣布（Codex P2：网关若连不点名的请求也拒绝，提前宣布就是谎话）。
        var route = new MdToPptPageModelRoute("gpt-5.6-sol", explicitlySelected: false);
        route.TryMarkSubstitutionAnnounced().ShouldBeFalse();

        route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, PoolUnbound);
        route.TryMarkSubstitutionAnnounced().ShouldBeTrue();
        route.TryMarkSubstitutionAnnounced().ShouldBeFalse();
    }

    [Fact]
    public void PageModelRoute_GatewayDefaultAlsoRejected_RejectsTheRun()
    {
        var route = new MdToPptPageModelRoute("gpt-5.6-sol", explicitlySelected: false);
        route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, PoolUnbound);

        route.OnGatewayRejected(MdToPptPageModelOutcome.UseGatewayDefault, PoolUnbound)
            .ShouldBe((MdToPptPageModelOutcome.Reject, true));
        route.Notice.ShouldNotBeNull();
        route.Notice.ShouldContain("管理员", customMessage: "拒绝必须给出下一步");
        AssertPublicMessage(route.Notice, "gpt-5.6-sol");
    }

    [Fact]
    public void PageModelRoute_ExplicitProfileRejected_RejectsInsteadOfSwappingModels()
    {
        var route = new MdToPptPageModelRoute("gpt-5.6-sol", explicitlySelected: true);

        route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, PoolUnbound)
            .ShouldBe((MdToPptPageModelOutcome.Reject, true));
        route.Notice.ShouldNotBeNull();
        route.Notice.ShouldContain("MAP 默认模型", customMessage: "拒绝必须给出下一步");
        AssertPublicMessage(route.Notice, "gpt-5.6-sol");
    }

    // 给用户看的拒绝文案只说结果与恢复动作，模型名与网关内部细节只进日志（user-readable-errors，Codex P2）。
    private static void AssertPublicMessage(string message, string requestedModel)
    {
        message.ShouldNotContain(requestedModel);
        foreach (var internalTerm in new[] { "Gateway", "对外模型目录", "调用方", "APPCALLER", "授权" })
            message.ShouldNotContain(internalTerm, customMessage: $"用户可见文案不应暴露内部细节：{internalTerm}");
    }

    [Theory]
    [InlineData(GatewayRouteFailure.GatewayConfigUnavailable)]
    [InlineData(GatewayRouteFailure.ProviderUnavailable)]
    [InlineData(GatewayRouteFailure.ModelPoolAllUnavailable)]
    [InlineData(null)]
    public void PageModelRoute_UnrelatedGatewayFailure_KeepsProfilePin(string? code)
    {
        var route = new MdToPptPageModelRoute("qwen-max", explicitlySelected: false);

        route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, code)
            .ShouldBe((MdToPptPageModelOutcome.UseProfileModel, false));
        route.ExpectedModelFor(route.Outcome).ShouldBe("qwen-max");
        route.Notice.ShouldBeNull();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PageModelRoute_ProfileWithoutModel_RejectedByGateway_RejectsTheRun(bool explicitlySelected)
    {
        // 系统默认配置（CreateSystemGatewayProfile）没有模型名：请求本来就交给网关默认，
        // 网关没有默认对外模型或调用方被停用时，不能停在原路线让每页退化成兜底（Codex P1）。
        var profile = MdToPptController.CreateSystemGatewayProfile("user-1");
        var route = MdToPptController.CreatePageModelRoute(profile, explicitlySelected ? profile.Id : null);
        route.ExpectedModelFor(route.Outcome).ShouldBeNull();

        route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, PoolUnbound)
            .ShouldBe((MdToPptPageModelOutcome.Reject, true));
        route.Notice.ShouldNotBeNull();
        route.Notice.ShouldNotContain("改选「MAP 默认模型」", customMessage: "用户本来就在用 MAP 默认模型，不能让他改选它");
        route.TryMarkSubstitutionAnnounced().ShouldBeFalse();
    }

    [Fact]
    public void PageModelRoute_ProfileWithoutModel_UnrelatedFailure_KeepsRoute()
    {
        var route = new MdToPptPageModelRoute("  ", explicitlySelected: false);

        route.OnGatewayRejected(MdToPptPageModelOutcome.UseProfileModel, GatewayRouteFailure.ProviderUnavailable)
            .ShouldBe((MdToPptPageModelOutcome.UseProfileModel, false));
        route.ExpectedModelFor(route.Outcome).ShouldBeNull();
    }

    [Fact]
    public void PageGeneration_DoesNotPreflightResolveBeforeSending()
    {
        // ResolveModelAsync 会替熔断冷却期满的线路抢半开试探租约；预检之后不发请求，真正的页面请求
        // 反而抢不到那条线路，模型永远恢复不了（Codex P1，PR #1629）。改道只能看真实发送的结果。
        var source = File.ReadAllText(ControllerPath());
        source.ShouldNotContain("_gateway.ResolveModelAsync(",
            customMessage: "MD 转 PPT 页面生成不许在发送前单独调用 ResolveModelAsync 预检模型");
    }

    [Theory]
    [InlineData("private async Task<PageGenerationResult> RunGatewayPageOnceAsync(")]
    [InlineData("private async Task RunGatewayDeckStreamAsync(")]
    public void GatewaySendLoops_AllocateFreshRequestIdAndAnnounceOnStart(string methodSignature)
    {
        // serving 按 (租户, 调用方, requestId) 登记在途请求，改道重发复用同一个 id 会被 409 挡掉（Codex P1）；
        // 改道后的请求被接住时要把实际模型推给前端（Codex P2，ai-model-visibility）。
        var method = MethodBody(File.ReadAllText(ControllerPath()), methodSignature);
        var loop = method.IndexOf("for (var attempt = 0;", StringComparison.Ordinal);
        loop.ShouldBeGreaterThanOrEqualTo(0, $"{methodSignature} 应当有改道重发循环");
        var requestId = method.IndexOf("var requestId = Guid.NewGuid()", StringComparison.Ordinal);
        requestId.ShouldBeGreaterThan(loop, $"{methodSignature} 的 requestId 必须在每次发送时新建");
        method.ShouldContain("AnnounceSubstitutionIfFirstAsync(",
            customMessage: $"{methodSignature} 收到 Start 时要宣布改判（带实际模型）");
    }

    [Fact]
    public void SubstitutionAnnouncement_CarriesActualPlatformFromStartResolution()
    {
        // 改道后推送的 model 事件，平台必须是 Start.Resolution 给的实际平台，
        // 不许退回预先算好的「LLM Gateway」路线标签（Codex P2，PR #1629）。
        var source = File.ReadAllText(ControllerPath());
        var announces = CallSites(source, "AnnounceSubstitutionIfFirstAsync(", "private async Task AnnounceSubstitutionIfFirstAsync(");
        announces.Count.ShouldBe(2);
        announces.ShouldContain(call => call.Contains("actualPlatform"), "逐页 / 单页重绘的发送循环要把 actualPlatform 传出去");
        announces.ShouldContain(call => call.Contains("resolvedPlatform"), "整篇直出的发送循环要把 resolvedPlatform 传出去");

        var modelEventHandlers = Regex.Matches(source, @"OnSubstituted = async \(actual, actualPlatform\) =>\s*\{\s*await \w+\(""model"", new \{[^}]*\}")
            .Select(m => m.Value).ToList();
        modelEventHandlers.Count.ShouldBe(2, "并行逐页生成与单页重绘两处改判回调都要推 model 事件");
        foreach (var handler in modelEventHandlers)
            handler.ShouldContain("platform = actualPlatform ??", customMessage: $"改判的 model 事件没有用实际平台：{handler}");
    }

    [Fact]
    public void GatewayPageRequests_AllCarryTheRunModelRoute()
    {
        // 接线守卫：路线按运行共享，每一条走网关的页面请求都必须带上它。
        // 漏掉任何一处，那条路径会照旧钉旧池模型名、在解析阶段被拒——而且不会有别的测试变红。
        var source = File.ReadAllText(ControllerPath());
        var callSites = CallSites(source, "RunPageOnceAsync(", "private async Task<PageGenerationResult> RunPageOnceAsync(");
        callSites.Count.ShouldBeGreaterThanOrEqualTo(4);
        foreach (var call in callSites)
            call.ShouldContain("modelRoute", customMessage: $"页面请求没有带运行级模型路线：{call}");

        var builders = CallSites(source, "BuildGatewayPageRequest(", "internal static GatewayRequest BuildGatewayPageRequest(");
        builders.Count.ShouldBeGreaterThanOrEqualTo(2);
        foreach (var call in builders)
            call.ShouldContain("modelRoute", customMessage: $"网关页面请求没有带运行级模型路线：{call}");
    }

    [Fact]
    public void CompletedRunDoneEvent_DeliversPersistedHtmlThatPassesTheHashBinding()
    {
        var generated = MdToPptController.NormalizePresentationDocument(
            "<!DOCTYPE html><html><head><title>周会</title></head><body>"
            + "<div class=\"reveal\"><div class=\"slides\"><section><h1>本周完成</h1></section>"
            + "<section><h1>下周计划</h1></section></div></div></body></html>");
        // 与 TryPersistRunDoneAsync 同一条预处理：落库前再做一次托管改写。
        var persisted = Encoding.UTF8.GetString(
            HostedSiteService.RewritePublishedEntryHtml(Encoding.UTF8.GetBytes(generated), "index.html"));
        persisted.ShouldNotBe(generated, "托管预处理不改写正文的话，本用例证明不了任何事");
        var run = new MdToPptRun { Id = "run-1", Html = persisted, HtmlHash = MdToPptController.ComputeHtmlHash(persisted) };

        var payload = JsonSerializer.SerializeToElement(MdToPptController.CompletedRunDoneEvent(run, 0, 2));
        var delivered = payload.GetProperty("html").GetString()!;

        delivered.ShouldBe(persisted);
        MdToPptController.HtmlMatchesHash(delivered, run.HtmlHash).ShouldBeTrue();
        payload.GetProperty("degraded").GetInt32().ShouldBe(0);
        payload.GetProperty("total").GetInt32().ShouldBe(2);
        // 事故形状：下发保存前那份，发布 / 精修的哈希绑定必然不通过。
        MdToPptController.HtmlMatchesHash(generated, run.HtmlHash).ShouldBeFalse();
    }

    [Fact]
    public void DoneEvents_WithHtml_OnlyComeFromTheCompletedRunConstructor()
    {
        // 接线守卫：done 事件里的正文只许由唯一构造器取 run.Html；分支自己拼 new { html } 就会
        // 下发保存前的局部变量，N2 会原样复发。
        var source = File.ReadAllText(ControllerPath());
        var inline = Regex.Matches(source, "\"done\",\\s*new\\s*\\{[^}]*\\bhtml\\b");
        inline.Count.ShouldBe(0, "done 事件里的 html 必须经 CompletedRunDoneEvent(run) 下发："
            + string.Join(" | ", inline.Select(m => m.Value)));
        Regex.Matches(source, "\"done\",\\s*CompletedRunDoneEvent\\(run").Count.ShouldBeGreaterThanOrEqualTo(5);
    }

    private static string MethodBody(string source, string signature)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, $"找不到 {signature}");
        var next = source.IndexOf("\n    private ", start + signature.Length, StringComparison.Ordinal);
        var nextInternal = source.IndexOf("\n    internal ", start + signature.Length, StringComparison.Ordinal);
        var end = new[] { next, nextInternal, source.Length }.Where(i => i > 0).Min();
        return source[start..end];
    }

    private static List<string> CallSites(string source, string token, string definition)
    {
        var result = new List<string>();
        var index = 0;
        while ((index = source.IndexOf(token, index, StringComparison.Ordinal)) >= 0)
        {
            var lineStart = source.LastIndexOf('\n', index) + 1;
            var end = source.IndexOf(';', index);
            var call = source[index..(end < 0 ? source.Length : end)];
            if (!source[lineStart..(index + token.Length)].TrimStart().StartsWith(definition, StringComparison.Ordinal)
                && !source[lineStart..(index + token.Length)].Contains(definition, StringComparison.Ordinal))
            {
                result.Add(call);
            }
            index += token.Length;
        }
        return result;
    }

    private static string ControllerPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(dir.FullName, "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "MdToPptController.cs");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate MdToPptController.cs from test base directory.");
    }
}
