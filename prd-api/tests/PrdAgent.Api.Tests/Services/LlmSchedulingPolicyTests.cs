using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Shouldly;
using Xunit;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Tests.Services;

public class LlmSchedulingPolicyTests
{
    [Fact]
    public async Task AIGapDetector_AnalyzeQuestion_UsesSchedulerAndWritesContext()
    {
        var ctx = new LLMRequestContextAccessor();
        var scheduler = new FakeScheduler(ctx, ModelResolutionType.DefaultPool, "group-1", "Default Pool");
        var detector = new AIGapDetector(scheduler, ctx, new FakePromptManager());

        var result = await detector.AnalyzeQuestionAsync(
            prdContent: "doc",
            question: "q",
            aiResponse: "a",
            groupId: "g1",
            userId: "u1",
            viewRole: "ADMIN",
            cancellationToken: CancellationToken.None);

        scheduler.LastAppCallerCode.ShouldBe(Desktop.Gap.DetectionChat);
        scheduler.LastModelType.ShouldBe("chat");
        scheduler.CapturedContext.ShouldNotBeNull();
        scheduler.CapturedContext!.RequestPurpose.ShouldBe(Desktop.Gap.DetectionChat);
        scheduler.CapturedContext!.ModelResolutionType.ShouldBe(ModelResolutionType.DefaultPool);
        scheduler.CapturedContext!.ModelGroupId.ShouldBe("group-1");
        scheduler.CapturedContext!.ModelGroupName.ShouldBe("Default Pool");
        result.ShouldNotBeNull();
        result!.HasGap.ShouldBeFalse();
    }

    [Fact]
    public async Task AIGapDetector_GenerateSummaryReport_UsesSchedulerAndWritesContext()
    {
        var ctx = new LLMRequestContextAccessor();
        var scheduler = new FakeScheduler(ctx, ModelResolutionType.DedicatedPool, "group-9", "Dedicated Pool");
        var detector = new AIGapDetector(scheduler, ctx, new FakePromptManager());

        var report = await detector.GenerateSummaryReportAsync(
            prdContent: "doc",
            gaps: new List<ContentGap>(),
            groupId: "g1",
            userId: "u1",
            viewRole: "ADMIN",
            cancellationToken: CancellationToken.None);

        scheduler.LastAppCallerCode.ShouldBe(Desktop.Gap.SummarizationChat);
        scheduler.LastModelType.ShouldBe("chat");
        scheduler.CapturedContext.ShouldNotBeNull();
        scheduler.CapturedContext!.RequestPurpose.ShouldBe(Desktop.Gap.SummarizationChat);
        scheduler.CapturedContext!.ModelResolutionType.ShouldBe(ModelResolutionType.DedicatedPool);
        scheduler.CapturedContext!.ModelGroupId.ShouldBe("group-9");
        scheduler.CapturedContext!.ModelGroupName.ShouldBe("Dedicated Pool");
        report.ShouldBe("report");
    }

    private sealed class FakeScheduler : ISmartModelScheduler
    {
        private readonly ILLMRequestContextAccessor _ctx;
        private readonly ModelResolutionType _resolutionType;
        private readonly string _groupId;
        private readonly string _groupName;

        public FakeScheduler(ILLMRequestContextAccessor ctx, ModelResolutionType resolutionType, string groupId, string groupName)
        {
            _ctx = ctx;
            _resolutionType = resolutionType;
            _groupId = groupId;
            _groupName = groupName;
        }

        public string? LastAppCallerCode { get; private set; }
        public string? LastModelType { get; private set; }
        public LlmRequestContext? CapturedContext { get; private set; }

        public Task<ILLMClient> GetClientAsync(string appCallerCode, string modelType, CancellationToken ct = default)
        {
            return Task.FromResult<ILLMClient>(CreateClient(appCallerCode, modelType));
        }

        public Task<ScheduledClientResult> GetClientWithGroupInfoAsync(string appCallerCode, string modelType, CancellationToken ct = default)
        {
            var client = CreateClient(appCallerCode, modelType);
            var result = new ScheduledClientResult(client, _resolutionType, _groupId, _groupName);
            return Task.FromResult(result);
        }

        public Task RecordCallResultAsync(string groupId, string modelId, string platformId, bool success, string? error = null, CancellationToken ct = default)
            => Task.CompletedTask;

        public Task HealthCheckAsync(CancellationToken ct = default) => Task.CompletedTask;

        public Task<LLMAppCaller> GetOrCreateAppCallerAsync(string appCallerCode, CancellationToken ct = default)
            => Task.FromResult(new LLMAppCaller { AppCode = appCallerCode });

        public Task<ModelGroup?> GetModelGroupForAppAsync(string appCallerCode, string modelType, CancellationToken ct = default)
            => Task.FromResult<ModelGroup?>(null);

        public Task<ResolvedModelInfo?> ResolveModelAsync(string appCallerCode, string modelType, CancellationToken ct = default)
            => Task.FromResult<ResolvedModelInfo?>(null);

        public Task<ResolvedModelInfo?> ResolveModelAsync(string appCallerCode, string modelType, string? expectedModelCode, CancellationToken ct = default)
            => Task.FromResult<ResolvedModelInfo?>(null);

        private ILLMClient CreateClient(string appCallerCode, string modelType)
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
