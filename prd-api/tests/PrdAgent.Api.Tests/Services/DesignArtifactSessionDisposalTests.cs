using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// OpenDesign 每次运行独占一个 SessionContainer 会话，执行器退出时必须真的把它处置掉。
/// 登记清理账本失败后没有直接停止，就等于把远程容器留给谁也捞不回来的状态：
/// RecoverPendingStopsAsync 的候选条件是 CleanupRequestedAt != null，无账本会话它一条都不取。
/// </summary>
public sealed class DesignArtifactSessionDisposalTests
{
    [Fact]
    public async Task ScheduleReturningNull_ShouldFallBackToDirectStop()
    {
        var scheduleCalls = 0;
        var stopCalls = 0;

        var scheduled = await OpenDesignRemoteArtifactExecutor.DisposeRemoteSessionAsync(
            cleanupScheduled: false,
            completedTurnObserved: true,
            scheduleStop: _ =>
            {
                scheduleCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            stop: _ =>
            {
                stopCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            onFailure: (_, _) => { });

        scheduled.ShouldBeFalse();
        scheduleCalls.ShouldBe(1);
        stopCalls.ShouldBe(1);
    }

    [Fact]
    public async Task ScheduleThrowing_ShouldReportFailureAndStillFallBackToDirectStop()
    {
        var stopCalls = 0;
        var failures = new List<bool>();

        var scheduled = await OpenDesignRemoteArtifactExecutor.DisposeRemoteSessionAsync(
            cleanupScheduled: false,
            completedTurnObserved: true,
            scheduleStop: _ => throw new InvalidOperationException("完成事件缺少稳定会话或消息身份"),
            stop: _ =>
            {
                stopCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            onFailure: (_, scheduling) => failures.Add(scheduling));

        scheduled.ShouldBeFalse();
        stopCalls.ShouldBe(1);
        failures.ShouldBe(new[] { true });
    }

    [Fact]
    public async Task ScheduleSucceeding_ShouldLeaveStopToTheCleanupWorker()
    {
        var stopCalls = 0;

        var scheduled = await OpenDesignRemoteArtifactExecutor.DisposeRemoteSessionAsync(
            cleanupScheduled: false,
            completedTurnObserved: true,
            scheduleStop: _ => Task.FromResult<InfraAgentSessionView?>(BuildSessionView()),
            stop: _ =>
            {
                stopCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            onFailure: (_, _) => { });

        scheduled.ShouldBeTrue();
        stopCalls.ShouldBe(0);
    }

    [Fact]
    public async Task UnfinishedTurn_ShouldStopDirectlyWithoutTouchingTheLedger()
    {
        var scheduleCalls = 0;
        var stopCalls = 0;

        var scheduled = await OpenDesignRemoteArtifactExecutor.DisposeRemoteSessionAsync(
            cleanupScheduled: false,
            completedTurnObserved: false,
            scheduleStop: _ =>
            {
                scheduleCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            stop: _ =>
            {
                stopCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            onFailure: (_, _) => { });

        scheduled.ShouldBeFalse();
        scheduleCalls.ShouldBe(0);
        stopCalls.ShouldBe(1);
    }

    [Fact]
    public async Task AlreadyScheduledLedger_ShouldNotStopTheSessionAgain()
    {
        var scheduleCalls = 0;
        var stopCalls = 0;

        var scheduled = await OpenDesignRemoteArtifactExecutor.DisposeRemoteSessionAsync(
            cleanupScheduled: true,
            completedTurnObserved: true,
            scheduleStop: _ =>
            {
                scheduleCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            stop: _ =>
            {
                stopCalls++;
                return Task.FromResult<InfraAgentSessionView?>(null);
            },
            onFailure: (_, _) => { });

        scheduled.ShouldBeTrue();
        scheduleCalls.ShouldBe(0);
        stopCalls.ShouldBe(0);
    }

    [Fact]
    public async Task DirectStopThrowing_ShouldBeReportedAndSwallowed()
    {
        var failures = new List<bool>();

        var scheduled = await OpenDesignRemoteArtifactExecutor.DisposeRemoteSessionAsync(
            cleanupScheduled: false,
            completedTurnObserved: false,
            scheduleStop: _ => Task.FromResult<InfraAgentSessionView?>(null),
            stop: _ => throw new InvalidOperationException("CDS 不可达"),
            onFailure: (_, scheduling) => failures.Add(scheduling));

        scheduled.ShouldBeFalse();
        failures.ShouldBe(new[] { false });
    }

    private static InfraAgentSessionView BuildSessionView()
    {
        var now = DateTime.UtcNow;
        return new InfraAgentSessionView(
            "session-1",
            "user-1",
            "conn-1",
            "cds",
            "shared-service",
            "cds-session-1",
            null,
            null,
            "run-1",
            InfraAgentRuntimes.OpenDesign,
            null,
            null,
            null,
            null,
            null,
            null,
            2,
            4096,
            900,
            InfraAgentRuntimeNetworkPolicies.Restricted,
            30,
            InfraAgentToolPolicies.DenyAll,
            null,
            "OpenDesign 网页生成",
            InfraAgentSessionStatuses.Idle,
            false,
            false,
            null,
            null,
            null,
            now,
            now,
            null,
            null);
    }
}
