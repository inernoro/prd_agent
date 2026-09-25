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
    private static GatewayModelResolution NotInCatalog(string model) => new()
    {
        Success = false,
        ErrorMessage = $"没有对外模型能接住这次请求；请确认 {model} 在对外模型目录里",
        FailureCode = GatewayRouteFailure.AppCallerPoolUnbound,
        FailureStage = MdToPptPageModelChoice.NotInCatalogStage,
    };

    private static GatewayModelResolution GatewayDefault() => new()
    {
        Success = true,
        LogicalModelPublicId = "default-chat-curated",
        ActualModel = "gpt-5.6-sol",
    };

    [Fact]
    public void PageModel_ImplicitProfileNotInGatewayCatalog_PinsGatewayDefaultInsteadOfRawPoolName()
    {
        // 事故现场：默认运行配置「池 · gpt-5.6-sol」是旧 MAP 模型池物化出来的，网关只认对外模型。
        var choice = MdToPptPageModelChoice.Choose("gpt-5.6-sol", explicitlySelected: false,
            NotInCatalog("gpt-5.6-sol"), GatewayDefault());

        choice.Outcome.ShouldBe(MdToPptPageModelOutcome.UseGatewayDefault);
        choice.ExpectedModel.ShouldBe("default-chat-curated");
        choice.DisplayModel.ShouldBe("gpt-5.6-sol");
        choice.Notice.ShouldNotBeNull();
        choice.Notice.ShouldContain("gpt-5.6-sol", customMessage: "改判必须说清原来点名的是谁");
        choice.Notice.ShouldContain("default-chat-curated", customMessage: "改判必须说清这次实际用的是谁");

        var wire = MdToPptController.BuildGatewayPageRequest(
            new InfraAgentRuntimeProfile { Model = "gpt-5.6-sol" }, "sys", "usr",
            AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate, modelChoice: choice);
        wire.ExpectedModel.ShouldBe("default-chat-curated");
    }

    [Fact]
    public void PageModel_ExplicitProfileNotInGatewayCatalog_RejectsOnceInsteadOfDegradingEveryPage()
    {
        var choice = MdToPptPageModelChoice.Choose("gpt-5.6-sol", explicitlySelected: true,
            NotInCatalog("gpt-5.6-sol"), GatewayDefault());

        choice.Outcome.ShouldBe(MdToPptPageModelOutcome.Reject);
        choice.Notice.ShouldNotBeNull();
        choice.Notice.ShouldContain("gpt-5.6-sol");
        choice.Notice.ShouldContain("MAP 默认模型", customMessage: "拒绝必须给出下一步");
    }

    [Fact]
    public void PageModel_NoGatewayDefault_RejectsWithNextStep()
    {
        var choice = MdToPptPageModelChoice.Choose("gpt-5.6-sol", explicitlySelected: false,
            NotInCatalog("gpt-5.6-sol"), new GatewayModelResolution { Success = false });

        choice.Outcome.ShouldBe(MdToPptPageModelOutcome.Reject);
        choice.Notice.ShouldNotBeNull();
    }

    [Theory]
    [InlineData(true, null)]
    [InlineData(false, GatewayRouteFailure.GatewayConfigUnavailable)]
    [InlineData(false, GatewayRouteFailure.ProviderUnavailable)]
    public void PageModel_KnownModelOrUnrelatedFailure_KeepsProfilePin(bool success, string? failureCode)
    {
        var resolution = new GatewayModelResolution
        {
            Success = success,
            FailureCode = failureCode,
            FailureStage = success ? null : "gateway-config-plane",
        };

        var choice = MdToPptPageModelChoice.Choose("qwen-max", explicitlySelected: false, resolution, GatewayDefault());

        choice.Outcome.ShouldBe(MdToPptPageModelOutcome.UseProfileModel);
        choice.ExpectedModel.ShouldBe("qwen-max");
    }

    [Fact]
    public void PageModel_ProfileWithoutModel_StaysAuto()
    {
        var choice = MdToPptPageModelChoice.Choose("  ", explicitlySelected: false, null, null);

        choice.Outcome.ShouldBe(MdToPptPageModelOutcome.UseProfileModel);
        choice.ExpectedModel.ShouldBeNull();
    }

    [Fact]
    public void GatewayPageRequests_AllCarryTheRunModelChoice()
    {
        // 接线守卫：判定只算一次，每一条走网关的页面请求都必须带上它。
        // 漏掉任何一处，那条路径会照旧钉旧池模型名、在解析阶段被拒——而且不会有别的测试变红。
        var source = File.ReadAllText(ControllerPath());
        var callSites = CallSites(source, "RunPageOnceAsync(", "private async Task<PageGenerationResult> RunPageOnceAsync(");
        callSites.Count.ShouldBeGreaterThanOrEqualTo(4);
        foreach (var call in callSites)
            call.ShouldContain("modelChoice", customMessage: $"页面请求没有带运行级模型判定：{call}");

        var builders = CallSites(source, "BuildGatewayPageRequest(", "internal static GatewayRequest BuildGatewayPageRequest(");
        builders.Count.ShouldBeGreaterThanOrEqualTo(2);
        foreach (var call in builders)
            call.ShouldContain("modelChoice", customMessage: $"网关页面请求没有带运行级模型判定：{call}");
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
