using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class LlmGatewayIncidentPolicyTests
{
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
