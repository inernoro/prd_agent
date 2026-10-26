using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class LlmGatewayIncidentPolicyTests
{
    [Fact]
    public void LongRequestFailureAfterShortSuccess_IsOrderedByCompletionTime()
    {
        var now = DateTime.UtcNow;
        var failure = Log("long-failure", "failed", 502, now.AddMinutes(-2));
        failure.EndedAt = now;
        var success = Log("short-success", "succeeded", 200, now.AddMinutes(-1));
        success.EndedAt = now.AddSeconds(-30);
        var signal = LlmGatewayIncidentPolicy.BuildSignals(new[] { failure, success }).ShouldHaveSingleItem();
        signal.IsFailure.ShouldBeTrue();
        signal.RequestId.ShouldBe(failure.RequestId);
        signal.ObservedAt.ShouldBe(now);
    }

    [Theory]
    [InlineData(409, PrdAgent.Core.LlmGateway.GatewayRouteFailure.AppCallerPoolUnbound)]
    [InlineData(503, PrdAgent.Core.LlmGateway.GatewayRouteFailure.ModelPoolAllUnavailable)]
    [InlineData(429, PrdAgent.Core.LlmGateway.GatewayRouteFailure.ProviderQuotaExceeded)]
    public void StructuredRouteFailure_RemainsActionableAfterHttpClassification(int status, string code)
    {
        var log = Log("route-failure", "failed", status, DateTime.UtcNow);
        log.Provider = "gateway-auth";
        log.TenantId = "test-tenant";
        log.AppCallerCode = "test.image::generation";
        log.Path = "/gw/v1/raw";
        log.Error = code;
        var signal = LlmGatewayIncidentPolicy.BuildSignals(new[] { log }).ShouldHaveSingleItem();
        signal.IsFailure.ShouldBeTrue();
        signal.FailureSummary.ShouldBe(PrdAgent.Core.LlmGateway.GatewayRouteFailure.UserMessage(code));
    }

    [Fact]
    public void ProductionDeployment_ShouldPublishIncidentNotifications()
    {
        var configuration = new ConfigurationBuilder().Build();

        LlmGatewayIncidentWatchdog.CanPublishNotifications(configuration).ShouldBeTrue();
    }

    [Fact]
    public void CdsBranchPreview_ShouldNotWriteSharedIncidentNotifications()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["CDS_PROJECT_ID"] = "preview-project",
            })
            .Build();

        LlmGatewayIncidentWatchdog.CanPublishNotifications(configuration).ShouldBeFalse();
    }

    [Fact]
    public void LatestUpstreamFailure_ShouldCreateOneDeduplicatedFailureSignal()
    {
        var startedAt = DateTime.UtcNow;
        var signals = LlmGatewayIncidentPolicy.BuildSignals(new[]
        {
            Log("r1", "failed", 502, startedAt),
            Log("r2", "failed", 502, startedAt.AddSeconds(1)),
        });

        var signal = signals.ShouldHaveSingleItem();
        signal.IsFailure.ShouldBeTrue();
        signal.RequestId.ShouldBe("r2");
        signal.FailureCount.ShouldBe(2);
        signal.FailureSummary.ShouldBe("上游返回 HTTP 502");
        signal.PlatformLabel.ShouldBe("apiyi-openai");
        signal.ModelLabel.ShouldBe("gpt-image-2-all");
    }

    [Fact]
    public void SuccessAfterFailure_ShouldCreateRecoverySignalForSameUpstream()
    {
        var startedAt = DateTime.UtcNow;
        var signals = LlmGatewayIncidentPolicy.BuildSignals(new[]
        {
            Log("failed-request", "failed", 503, startedAt),
            Log("recovered-request", "succeeded", 200, startedAt.AddSeconds(10)),
        });

        var signal = signals.ShouldHaveSingleItem();
        signal.IsFailure.ShouldBeFalse();
        signal.RequestId.ShouldBe("recovered-request");
        signal.FailureCount.ShouldBe(1);
    }

    [Fact]
    public void ClientValidationFailure_ShouldNotBecomeUpstreamIncident()
    {
        var signals = LlmGatewayIncidentPolicy.BuildSignals(new[]
        {
            Log("bad-input", "failed", 400, DateTime.UtcNow),
        });

        signals.ShouldBeEmpty();
    }

    [Fact]
    public void FailedWithoutStatusOrUpstreamEvidence_ShouldNotBecomeIncident()
    {
        var log = Log("unknown-failure", "failed", 0, DateTime.UtcNow);
        log.StatusCode = null;
        log.Error = "invalid app caller";

        var signals = LlmGatewayIncidentPolicy.BuildSignals(new[] { log });

        signals.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    public void UpstreamAccessRejected_ShouldCreateOneIncidentForRepeatedRequests(int status)
    {
        var now = DateTime.UtcNow;
        var logs = Enumerable.Range(0, 100).Select(i =>
        {
            var log = Log($"access-{i}", "failed", status, now.AddMilliseconds(i));
            log.Error = "Unauthorized IP address";
            return log;
        });
        var signal = LlmGatewayIncidentPolicy.BuildSignals(logs).ShouldHaveSingleItem();
        signal.IsFailure.ShouldBeTrue();
        signal.FailureCount.ShouldBe(100);
        signal.IsGatewayEntry.ShouldBeFalse();
        signal.FailureSummary.ShouldContain("白名单");
    }

    [Fact]
    public void EntryRejectedBurst_ShouldNotHideIndependentUpstreamFailure()
    {
        var logs = Enumerable.Range(0, 100).Select(i => EntryLog($"entry-{i}")).ToList();
        logs.Add(Log("upstream-access", "failed", 401, DateTime.UtcNow));
        var signals = LlmGatewayIncidentPolicy.BuildSignals(logs);
        signals.Count.ShouldBe(2);
        signals.ShouldAllBe(x => x.IsFailure);
        signals.Single(x => x.IsGatewayEntry).FailureCount.ShouldBe(100);
        signals.Single(x => !x.IsGatewayEntry).FailureCount.ShouldBe(1);
    }

    [Fact]
    public void EntryFailure_ShouldNotRecoverFromAnotherAppOrPath()
    {
        var failed = EntryLog("entry-failed");
        var otherApp = Log("other-app-success", "succeeded", 200, failed.StartedAt.AddSeconds(1));
        otherApp.Path = failed.Path;
        otherApp.AppCallerCode = "different-business::generation";
        var otherPath = Log("other-path-success", "succeeded", 200, failed.StartedAt.AddSeconds(2));
        otherPath.Path = "/another/entry";
        var before = LlmGatewayIncidentPolicy.BuildSignals(new[] { failed }).ShouldHaveSingleItem();
        var after = LlmGatewayIncidentPolicy.BuildSignals(new[] { failed, otherApp, otherPath });
        after.Single(x => x.Fingerprint == before.Fingerprint).IsFailure.ShouldBeTrue();
    }

    [Fact]
    public void EntrySuccess_ShouldRecoverTheSameBusinessEntryWithoutModelIdentity()
    {
        var failed = EntryLog("entry-failed");
        var success = Log("entry-success", "succeeded", 200, failed.StartedAt.AddSeconds(1));
        success.Path = failed.Path;
        var signals = LlmGatewayIncidentPolicy.BuildSignals(new[] { failed, success });
        var recovery = signals.Single(x => x.IsGatewayEntry);
        recovery.IsFailure.ShouldBeFalse();
        recovery.RequestId.ShouldBe("entry-success");
        recovery.FailureCount.ShouldBe(1);
    }

    [Fact]
    public void EntryFailures_FromDifferentBusinesses_ShouldRemainIndependent()
    {
        var one = EntryLog("one");
        var two = EntryLog("two");
        two.AppCallerCode = "different-business::generation";
        LlmGatewayIncidentPolicy.BuildSignals(new[] { one, two }).Count.ShouldBe(2);
    }

    [Theory]
    [InlineData(400)]
    [InlineData(409)]
    [InlineData(422)]
    public void EntryValidationFailure_ShouldNotPage(int status)
    {
        var log = EntryLog("invalid-input");
        log.StatusCode = status;
        LlmGatewayIncidentPolicy.BuildSignals(new[] { log }).ShouldBeEmpty();
    }

    [Fact]
    public void ProbesAndUnattributedEntryFailures_ShouldNotPage()
    {
        var probe = EntryLog("probe");
        probe.IsHealthProbe = true;
        var unattributed = EntryLog("unattributed");
        unattributed.AppCallerCode = null;
        LlmGatewayIncidentPolicy.BuildSignals(new[] { probe, unattributed }).ShouldBeEmpty();
    }

    private static LlmRequestLog EntryLog(string requestId)
    {
        var log = Log(requestId, "failed", 404, DateTime.UtcNow);
        log.Provider = "gateway-auth";
        log.PlatformId = null;
        log.PlatformName = null;
        log.Model = "";
        log.RequestType = null;
        log.Path = "/gateway/image-generation";
        log.Error = "GATEWAY_REQUEST_REJECTED";
        return log;
    }

    private static LlmRequestLog Log(string requestId, string status, int statusCode, DateTime startedAt)
        => new()
        {
            TenantId = "map-internal",
            RequestId = requestId,
            AppCallerCode = "literary-agent.illustration.text2img::generation",
            AppCallerCodeDisplayName = "文学创作配图",
            RequestType = "generation",
            PlatformId = "apiyi-openai-id",
            PlatformName = "apiyi-openai",
            Provider = "openai",
            Model = "gpt-image-2-all",
            Status = status,
            StatusCode = statusCode,
            StartedAt = startedAt,
        };
}
