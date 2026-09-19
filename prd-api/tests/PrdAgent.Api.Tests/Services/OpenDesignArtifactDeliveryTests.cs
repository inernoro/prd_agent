using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 产物已经在手之后，**我们这一侧的记账失败不得把它丢掉**。
///
/// Done 事件到达时 ReadResultAsync 读的是 CDS 早已提交完成的结果包——模型已经跑完、钱已经花了。
/// 此前这里若 ScheduleStopAsync 返回 null 或抛错就直接抛异常，而产出产物的 yield return 在抛点
/// 之后，于是 HostedSiteEditRunWorker 把 run 判失败、不建版本，用户什么都拿不到，
/// 只因为清理账本没记上（Codex P1，2026-09-16）。
///
/// 兜底不缺：finally 的 DisposeRemoteSessionAsync 会按「重试登记 → 直接停止」再走一遍；
/// 全兜不住的代价也只是远程容器占到 CDS 生存期上限，比丢产物轻一个量级。
/// </summary>
public sealed class OpenDesignArtifactDeliveryTests
{
    private const string RunId = "run-delivery-1";
    private const string IndexHtml = "<!doctype html><html><body>已完成的产物</body></html>";

    [Theory]
    [InlineData(false)] // 登记返回 null
    [InlineData(true)]  // 登记抛异常
    public async Task CleanupRegistrationFailure_ShouldStillDeliverTheCompletedArtifact(bool throws)
    {
        var sessions = new Mock<IInfraAgentSessionService>(MockBehavior.Loose);
        var view = BuildSessionView();
        sessions.Setup(x => x.CreateAsync(It.IsAny<string>(), It.IsAny<CreateInfraAgentSessionRequest>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(view);
        sessions.Setup(x => x.StartAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<StartInfraAgentSessionRequest>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(view with { Status = InfraAgentSessionStatuses.Idle });
        sessions.Setup(x => x.SendMessageAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<SendInfraAgentMessageRequest>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(view);
        sessions.Setup(x => x.ListPersistedEventsAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<long>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<InfraAgentEventView>
            {
                new(
                    "event-1", view.Id, 1, RunId, InfraAgentEventTypes.Done,
                    JsonSerializer.Serialize(new { clientMessageId = "message-1" }),
                    DateTime.UtcNow, view.CdsSessionId),
            });

        var scheduleCalls = 0;
        var setup = sessions.Setup(x => x.ScheduleStopAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback(() => scheduleCalls++);
        if (throws) setup.ThrowsAsync(new InvalidOperationException("登记账本时 Mongo 抖了一下"));
        else setup.ReturnsAsync((InfraAgentSessionView?)null);

        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Loose);
        broker.Setup(x => x.PrepareAsync(It.IsAny<DesignArtifactRun>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(BuildWorkspace());
        broker.Setup(x => x.ReadResultAsync(RunId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ParsedDesignWorkspaceResult(IndexHtml, Array.Empty<DesignWorkspaceFile>()));

        var connections = new Mock<IInfraConnectionService>(MockBehavior.Loose);
        connections.Setup(x => x.ListAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<InfraConnectionPublicView> { BuildConnection() });

        var executor = new OpenDesignRemoteArtifactExecutor(
            connections.Object,
            sessions.Object,
            broker.Object,
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>()).Build(),
            NullLogger<OpenDesignRemoteArtifactExecutor>.Instance);

        var chunks = new List<DesignArtifactExecutorChunk>();
        await foreach (var chunk in executor.ExecuteAsync(BuildRun(), null, CancellationToken.None))
            chunks.Add(chunk);

        // 这条是本用例的全部意义：记账失败，产物照样交付。
        var delta = chunks.SingleOrDefault(chunk => chunk.Type == "delta");
        delta.ShouldNotBeNull("清理账本登记失败不得吞掉已完成的产物——模型已经跑完、钱已经花了");
        delta!.Content.ShouldBe(IndexHtml);
        // 记账仍然被尝试过（主路径一次 + finally 兜底一次），不是干脆不记了
        scheduleCalls.ShouldBeGreaterThanOrEqualTo(1);
    }

    private static DesignArtifactRun BuildRun() => new()
    {
        Id = RunId,
        UserId = "user-1",
        Runtime = DesignArtifactRuntimes.OpenDesign,
        ArtifactType = DesignArtifactTypes.WebPage,
        Operation = DesignArtifactOperations.Generate,
        RuntimeConnectionId = "connection-1",
        Instruction = "做一个页面",
    };

    private static PreparedDesignArtifactWorkspace BuildWorkspace() => new(
        "https://map.test/input", new string('a', 64), "https://map.test/commit", "transfer-token",
        "https://map.test/gw", "model-token", "gpt-test", "revision-1",
        1024 * 1024, 6 * 1024 * 1024, ["index.html", "manifest.json", "assets/**"]);

    private static InfraConnectionPublicView BuildConnection() => new(
        "connection-1", "cds", "CDS", "cds-1", "https://cds.test", "project-1", "/api/discovery",
        ["instance:read"], "active", DateTime.UtcNow.AddDays(-1), DateTime.UtcNow, DateTime.UtcNow,
        true, null, DateTime.UtcNow.AddYears(1));

    private static InfraAgentSessionView BuildSessionView()
    {
        var now = DateTime.UtcNow;
        return new InfraAgentSessionView(
            "session-1", "user-1", "connection-1", "cds", "project-1", "cds-session-1", null, null,
            RunId, InfraAgentRuntimes.OpenDesign, null, null, null, null, null, null,
            2, 4096, 900, InfraAgentRuntimeNetworkPolicies.Restricted, 30,
            InfraAgentToolPolicies.DenyAll, null, "OpenDesign 网页生成",
            InfraAgentSessionStatuses.Idle, false, false, null, null, null, now, now, null, null);
    }
}
