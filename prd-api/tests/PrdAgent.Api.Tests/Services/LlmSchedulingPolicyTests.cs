using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Shouldly;
using Xunit;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Tests.Services;

public class LlmSchedulingPolicyTests
{
    [Fact]
    public async Task AIGapDetector_AnalyzeQuestion_UsesGatewayAndWritesContext()
    {
        var ctx = new LLMRequestContextAccessor();
        var gateway = new FakeGateway(ctx);
        var detector = new AIGapDetector(gateway, ctx, new FakePromptManager());

        var result = await detector.AnalyzeQuestionAsync(
            prdContent: "doc",
            question: "q",
            aiResponse: "a",
            groupId: "g1",
            userId: "u1",
            viewRole: "ADMIN",
            cancellationToken: CancellationToken.None);

        gateway.LastAppCallerCode.ShouldBe(Desktop.Gap.DetectionChat);
        gateway.LastModelType.ShouldBe("chat");
        gateway.CapturedContext.ShouldNotBeNull();
        gateway.CapturedContext!.RequestPurpose.ShouldBe(Desktop.Gap.DetectionChat);
        result.ShouldNotBeNull();
        result!.HasGap.ShouldBeFalse();
    }

    [Fact]
    public async Task AIGapDetector_GenerateSummaryReport_UsesGatewayAndWritesContext()
    {
        var ctx = new LLMRequestContextAccessor();
        var gateway = new FakeGateway(ctx);
        var detector = new AIGapDetector(gateway, ctx, new FakePromptManager());

        var report = await detector.GenerateSummaryReportAsync(
            prdContent: "doc",
            gaps: new List<ContentGap>(),
            groupId: "g1",
            userId: "u1",
            viewRole: "ADMIN",
            cancellationToken: CancellationToken.None);

        gateway.LastAppCallerCode.ShouldBe(Desktop.Gap.SummarizationChat);
        gateway.LastModelType.ShouldBe("chat");
        gateway.CapturedContext.ShouldNotBeNull();
        gateway.CapturedContext!.RequestPurpose.ShouldBe(Desktop.Gap.SummarizationChat);
        report.ShouldBe("report");
    }

    private sealed class FakeGateway : ILlmGateway
    {
        private readonly ILLMRequestContextAccessor _ctx;

        public FakeGateway(ILLMRequestContextAccessor ctx)
        {
            _ctx = ctx;
        }

        public string? LastAppCallerCode { get; private set; }
        public string? LastModelType { get; private set; }
        public LlmRequestContext? CapturedContext { get; private set; }

        public ILLMClient CreateClient(
            string appCallerCode,
            string modelType,
            int maxTokens = 4096,
            double temperature = 0.2,
            bool includeThinking = false)
        {
            LastAppCallerCode = appCallerCode;
            LastModelType = modelType;
            return new FakeClient(_ctx, c => CapturedContext = c);
        }
    }

    private sealed class FakeClient : ILLMClient
    {
        private readonly ILLMRequestContextAccessor _ctx;
        private readonly Action<LlmRequestContext?> _capture;

        public FakeClient(ILLMRequestContextAccessor ctx, Action<LlmRequestContext?> capture)
        {
            _ctx = ctx;
            _capture = capture;
        }

        public string Provider => "fake";

        public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
            string systemPrompt,
            List<LLMMessage> messages,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            _capture(_ctx.Current);
            yield return new LLMStreamChunk { Type = "delta", Content = BuildContent(systemPrompt) };
            await Task.CompletedTask;
        }

        public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
            string systemPrompt,
            List<LLMMessage> messages,
            bool enablePromptCache,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            _capture(_ctx.Current);
            yield return new LLMStreamChunk { Type = "delta", Content = BuildContent(systemPrompt) };
            await Task.CompletedTask;
        }

        private static string BuildContent(string systemPrompt)
        {
            if ((systemPrompt ?? string.Empty).Contains("产品文档分析师"))
            {
                return "report";
            }
            return "{\"hasGap\":false,\"gapType\":\"MISSING\",\"severity\":\"LOW\",\"suggestion\":\"x\"}";
        }
    }

    private sealed class FakePromptManager : IPromptManager
    {
        public string BuildSystemPrompt(UserRole role, string prdContent) => string.Empty;
        public string BuildPrdContextMessage(string prdContent) => string.Empty;
        public List<GuideOutlineItem> GetGuideOutline(UserRole role) => new();
        public string BuildGapDetectionPrompt(string prdContent, string question) => string.Empty;
    }
}
