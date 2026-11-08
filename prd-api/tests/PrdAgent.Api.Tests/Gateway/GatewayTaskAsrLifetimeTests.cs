using System.Threading.Channels;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Moq;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.LlmGateway.Asr;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayTaskAsrLifetimeTests
{
    [Fact]
    public async Task PlatformExpiryCancelsRealBatchSendAndPreventsProviderRetry()
    {
        var candidate = BatchCandidate();
        var resolver = Resolver(candidate);
        var gateway = new Mock<ILlmGateway>();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationToken vendorToken = default;
        gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Returns(async (GatewayRawRequest _, GatewayModelResolution _, CancellationToken ct) =>
            {
                vendorToken = ct; entered.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return new GatewayRawResponse { Success = true };
            });
        using var lifetime = new CancellationTokenSource();
        var events = new List<LiveAsrEvent>();
        var running = Orchestrator(resolver, gateway).ExecuteAsync(new WindowTransport(), new GatewayRequestContext(),
            evt => { events.Add(evt); return Task.CompletedTask; }, () => { }, platformCancellationToken: lifetime.Token, beforeFallbackSend: LimitedTaskPermit());
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        lifetime.Cancel();
        var result = await running.WaitAsync(TimeSpan.FromSeconds(2));
        vendorToken.IsCancellationRequested.ShouldBeTrue();
        result.Failure.ShouldNotBeNull().ShouldContain("授权已到期");
        result.ErrorCode.ShouldBe("TASK_PERMIT_EXPIRED");
        result.StatusCode.ShouldBe(403);
        events.ShouldContain(evt => evt.ErrorCode == "TASK_PERMIT_EXPIRED" && evt.Message!.Contains("重新发起"));
        gateway.Verify(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()), Times.Once);
        resolver.Verify(x => x.RecordFailureAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ClientDisconnectDoesNotCancelAnAlreadyAdmittedPaidSend()
    {
        var candidate = BatchCandidate(); var resolver = Resolver(candidate);
        var gateway = new Mock<ILlmGateway>();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource<GatewayRawResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        CancellationToken vendorToken = default;
        gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Returns((GatewayRawRequest _, GatewayModelResolution _, CancellationToken ct) =>
            { vendorToken = ct; entered.TrySetResult(); return completed.Task; });
        using var caller = new CancellationTokenSource();
        using var lifetime = new CancellationTokenSource();
        var running = Orchestrator(resolver, gateway).ExecuteAsync(new WindowTransport(), new GatewayRequestContext(),
            _ => Task.CompletedTask, () => { }, caller.Token, lifetime.Token, LimitedTaskPermit());
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); caller.Cancel();
        vendorToken.IsCancellationRequested.ShouldBeFalse();
        running.IsCompleted.ShouldBeFalse();
        completed.SetResult(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "{\"text\":\"录音内容\"}" });
        await running.WaitAsync(TimeSpan.FromSeconds(2));
        vendorToken.IsCancellationRequested.ShouldBeFalse();
    }

    private static Func<CancellationToken, Task> LimitedTaskPermit()
    {
        var remaining = GatewayTaskPermitRecord.MaximumCalls;
        return token =>
        {
            token.ThrowIfCancellationRequested();
            if (Interlocked.Decrement(ref remaining) < 0)
                throw new PrdAgent.Core.Security.TaskExecutionAdmissionException("TASK_PERMIT_EXHAUSTED", "测试任务授权次数已用尽。");
            return Task.CompletedTask;
        };
    }

    [Fact]
    public async Task NewBatchCallerOmittingPlatformCallbackCannotSendUpstream()
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var candidate = BatchCandidate(); var resolver = Resolver(candidate);
        var service = new LiveAsrBatchFallbackService(gateway.Object, resolver.Object, NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(1, Enumerable.Repeat((byte)1, LiveAsrBatchFallbackService.WindowBytes).ToArray()));
        frames.Writer.TryComplete();

        var blocked = await Assert.ThrowsAsync<PrdAgent.Core.Security.TaskExecutionAdmissionException>(() => service.TranscribeAsync(
            [candidate], frames.Reader, _ => Task.CompletedTask, null, new GatewayRequestContext()));

        blocked.Code.ShouldBe("TASK_ADMISSION_UNAVAILABLE"); gateway.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task FutureAsrBackgroundWorkerHasNoResolverOrVendorAccess()
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var resolver = new Mock<IModelResolver>(MockBehavior.Strict);
        var authority = new GatewayInvocationAuthority(new HttpContextAccessor(), new ConfigurationBuilder().Build());
        var orchestrator = new LiveAsrSessionOrchestrator(resolver.Object, new DoubaoStreamAsrService(NullLogger<DoubaoStreamAsrService>.Instance),
            new LiveAsrBatchFallbackService(gateway.Object, resolver.Object, NullLogger<LiveAsrBatchFallbackService>.Instance),
            NullLogger<LiveAsrSessionOrchestrator>.Instance, authority);
        var result = await orchestrator.ExecuteAsync(new WindowTransport(), new GatewayRequestContext(),
            _ => Task.CompletedTask, () => throw new InvalidOperationException("不得进入供应商发送"), beforeFallbackSend: LimitedTaskPermit());
        result.ErrorCode.ShouldBe("GATEWAY_INVOCATION_NOT_AUTHORIZED");
        gateway.VerifyNoOtherCalls(); resolver.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task StreamingAsrCallerOmittingCallbackCannotEnterInitialVendorSend()
    {
        var candidate = new ModelResolutionResult
        {
            Success = true, ActualPlatformId = "fixture", ActualPlatformName = "fixture", ActualModel = LiveAsrCandidatePolicy.PreferredModel,
            PlatformType = "doubao", Protocol = "doubao-asr-stream", ApiKey = "fixture-app:fixture-access",
        };
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var sends = 0;
        var result = await Orchestrator(Resolver(candidate), gateway).ExecuteAsync(new WindowTransport(), new GatewayRequestContext(),
            _ => Task.CompletedTask, () => sends++);
        result.ErrorCode.ShouldBe("TASK_ADMISSION_UNAVAILABLE"); sends.ShouldBe(0); gateway.VerifyNoOtherCalls();
    }

    private static ModelResolutionResult BatchCandidate() => new()
        { Success = true, ActualPlatformId = "fixture", ActualPlatformName = "fixture", ActualModel = "openai/gpt-audio", PlatformType = "openai", Protocol = "openrouter" };

    private static Mock<IModelResolver> Resolver(ModelResolutionResult candidate)
    {
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(candidate);
        resolver.Setup(x => x.RecordSuccessAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        resolver.Setup(x => x.RecordFailureAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        return resolver;
    }

    private static LiveAsrSessionOrchestrator Orchestrator(Mock<IModelResolver> resolver, Mock<ILlmGateway> gateway)
        => new(resolver.Object, new DoubaoStreamAsrService(NullLogger<DoubaoStreamAsrService>.Instance),
            new LiveAsrBatchFallbackService(gateway.Object, resolver.Object, NullLogger<LiveAsrBatchFallbackService>.Instance),
            NullLogger<LiveAsrSessionOrchestrator>.Instance);

    private sealed class WindowTransport : ILiveAsrSessionTransport
    {
        public Task<bool> ReceiveStartAsync(CancellationToken cancellationToken) => Task.FromResult(true);
        public async Task ReceiveFramesAsync(IReadOnlyList<ChannelWriter<LiveAsrAudioFrame>> writers, Func<LiveAsrEvent, Task> emit, CancellationToken ct)
        {
            try
            {
                var pcm = Enumerable.Repeat((byte)1, LiveAsrBatchFallbackService.WindowBytes).ToArray();
                foreach (var writer in writers) await writer.WriteAsync(new LiveAsrAudioFrame(1, pcm), ct);
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
            }
            finally { foreach (var writer in writers) writer.TryComplete(); }
        }
    }
}
