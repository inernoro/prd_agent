using System.Text.Json;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class InfraAgentSessionServiceCdsStreamRetryTests
{
    [Theory]
    [InlineData("queued")]
    [InlineData("running")]
    public void MapCdsStatus_KeepsNonTerminalExecutionStatesRunning(string cdsStatus)
    {
        InfraAgentSessionService.MapCdsStatus(cdsStatus)
            .ShouldBe(InfraAgentSessionStatuses.Running);
    }

    [Theory]
    [InlineData("network", 2)]
    [InlineData("parse", 2)]
    [InlineData("storage", 0)]
    public async Task FollowCdsStreamWithRetryAsync_ReconnectsFromPersistedWatermarkAndCompletes(
        string failureKind,
        long expectedResumeWatermark)
    {
        var persistedCdsSeq = 0L;
        var requestedWatermarks = new List<long>();
        var retryExceptions = new List<Exception?>();
        var attempt = 0;

        var result = await InfraAgentSessionService.FollowCdsStreamWithRetryAsync(
            _ =>
            {
                requestedWatermarks.Add(persistedCdsSeq);
                attempt++;
                if (attempt == 1)
                {
                    // 模拟首条 follow 流已经成功落库 seq=1..2 后才断开/遇到坏帧；若是
                    // Mongo 落库失败则水位保持 0，下一次仍从 0 重放，不能跳过未持久化事件。
                    if (failureKind != "storage") persistedCdsSeq = 2;
                    throw failureKind switch
                    {
                        "network" => new IOException("simulated CDS stream disconnect"),
                        "parse" => new JsonException("simulated malformed SSE data"),
                        _ => new InvalidOperationException("simulated Mongo event write failure")
                    };
                }

                persistedCdsSeq = 4;
                return Task.FromResult(new CdsStreamImportResult(InfraAgentSessionStatuses.Idle, null));
            },
            _ => Task.FromResult<string?>(InfraAgentSessionStatuses.Running),
            (_, exception, _) =>
            {
                retryExceptions.Add(exception);
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1),
            TimeSpan.Zero,
            CancellationToken.None);

        result.SessionStatus.ShouldBe(InfraAgentSessionStatuses.Idle);
        result.TimedOut.ShouldBeFalse();
        result.Attempts.ShouldBe(2);
        requestedWatermarks.ShouldBe([0, expectedResumeWatermark]);
        retryExceptions.Count.ShouldBe(1);
        retryExceptions[0].ShouldNotBeNull();
        persistedCdsSeq.ShouldBe(4);
    }

    [Fact]
    public async Task FollowCdsStreamWithRetryAsync_ReconnectsAfterCleanEarlyEof()
    {
        var attempts = 0;
        var cleanEofRetries = 0;

        var result = await InfraAgentSessionService.FollowCdsStreamWithRetryAsync(
            _ =>
            {
                attempts++;
                return Task.FromResult(attempts == 1
                    ? new CdsStreamImportResult(null, null)
                    : new CdsStreamImportResult(InfraAgentSessionStatuses.Idle, null));
            },
            _ => Task.FromResult<string?>(InfraAgentSessionStatuses.Running),
            (_, exception, _) =>
            {
                exception.ShouldBeNull();
                cleanEofRetries++;
                return Task.CompletedTask;
            },
            TimeSpan.FromSeconds(1),
            TimeSpan.Zero,
            CancellationToken.None);

        result.SessionStatus.ShouldBe(InfraAgentSessionStatuses.Idle);
        result.Attempts.ShouldBe(2);
        cleanEofRetries.ShouldBe(1);
    }

    [Fact]
    public async Task FollowCdsStreamWithRetryAsync_AcceptsTerminalEventPersistedBeforeProjectionFailure()
    {
        var persistedTerminalStatus = InfraAgentSessionStatuses.Running;
        var importAttempts = 0;

        var result = await InfraAgentSessionService.FollowCdsStreamWithRetryAsync(
            _ =>
            {
                importAttempts++;
                persistedTerminalStatus = InfraAgentSessionStatuses.Idle;
                throw new InvalidOperationException("assistant message projection failed after done event persisted");
            },
            _ => Task.FromResult<string?>(persistedTerminalStatus),
            (_, _, _) => Task.CompletedTask,
            TimeSpan.FromSeconds(1),
            TimeSpan.Zero,
            CancellationToken.None);

        result.SessionStatus.ShouldBe(InfraAgentSessionStatuses.Idle);
        result.Attempts.ShouldBe(1);
        importAttempts.ShouldBe(1);
    }

    [Fact]
    public async Task FollowCdsStreamWithRetryAsync_StopsAtExplicitTimeout()
    {
        var result = await InfraAgentSessionService.FollowCdsStreamWithRetryAsync(
            async ct =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return new CdsStreamImportResult(null, null);
            },
            _ => Task.FromResult<string?>(InfraAgentSessionStatuses.Running),
            (_, _, _) => Task.CompletedTask,
            TimeSpan.FromMilliseconds(25),
            TimeSpan.Zero,
            CancellationToken.None);

        result.TimedOut.ShouldBeTrue();
        result.SessionStatus.ShouldBe(InfraAgentSessionStatuses.Failed);
        result.Attempts.ShouldBe(1);
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Idle)]
    [InlineData(InfraAgentSessionStatuses.Stopped)]
    [InlineData(InfraAgentSessionStatuses.Failed)]
    public async Task FollowCdsStreamWithRetryAsync_StopsWhenPersistedSessionIsTerminal(string terminalStatus)
    {
        var importAttempts = 0;

        var result = await InfraAgentSessionService.FollowCdsStreamWithRetryAsync(
            _ =>
            {
                importAttempts++;
                return Task.FromResult(new CdsStreamImportResult(null, null));
            },
            _ => Task.FromResult<string?>(terminalStatus),
            (_, _, _) => Task.CompletedTask,
            TimeSpan.FromSeconds(1),
            TimeSpan.Zero,
            CancellationToken.None);

        result.SessionStatus.ShouldBe(terminalStatus);
        result.Attempts.ShouldBe(0);
        importAttempts.ShouldBe(0);
    }

    [Fact]
    public async Task FollowCdsStreamWithRetryAsync_PropagatesExplicitCancellation()
    {
        using var cancellation = new CancellationTokenSource();

        await Should.ThrowAsync<OperationCanceledException>(async () =>
            await InfraAgentSessionService.FollowCdsStreamWithRetryAsync(
                _ => throw new IOException("disconnect before cancellation"),
                _ => Task.FromResult<string?>(InfraAgentSessionStatuses.Running),
                (_, _, _) =>
                {
                    cancellation.Cancel();
                    return Task.CompletedTask;
                },
                TimeSpan.FromSeconds(1),
                TimeSpan.Zero,
                cancellation.Token));
    }
}
