using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class GatewayIncidentFactsTests
{
    private static readonly DateTime At = new(2026, 11, 13, 2, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void FailedRouteWithSuccessfulBackup_RemainsAnActiveIncidentForTheFailedRoute()
    {
        var log = Request("fallback", "succeeded", 200);
        log.PlatformId = "backup";
        log.PlatformName = "备用供应商";
        log.ProviderAttempts = [Attempt("primary", "failed", 402, 0), Attempt("backup", "succeeded", 200, 1)];
        var incident = Assert.Single(LlmGatewayIncidentPolicy.BuildSignals([log]), s => s.IsFailure);
        Assert.Equal("primary", incident.PlatformLabel);
        Assert.Contains("额度", incident.FailureSummary);
    }

    [Fact]
    public void DifferentFailureReasonsOnTheSameRoute_AreIndependentIncidents()
    {
        var quota = Request("quota", "failed", 402);
        quota.Error = "insufficient_balance";
        var access = Request("access", "failed", 403);
        access.StartedAt = At.AddSeconds(1);
        access.Error = "Unauthorized IP address";
        var signals = LlmGatewayIncidentPolicy.BuildSignals([quota, access]);
        Assert.Equal(2, signals.Count(s => s.IsFailure));
        Assert.Equal(2, signals.Where(s => s.IsFailure).Select(s => s.Fingerprint).Distinct().Count());
    }

    [Fact]
    public void ConfirmedFailureDuringRunningRequest_DoesNotDisappear()
    {
        var log = Request("pending-fallback", "running", 0);
        log.ProviderAttempts = [Attempt("primary", "failed", 402, 0), Attempt("backup", "selected", 0, 1)];
        Assert.Single(LlmGatewayIncidentPolicy.BuildSignals([log]), s => s.IsFailure);
    }

    [Fact]
    public void SuccessOnAnotherRoute_CannotRecoverTheFailedRoute()
    {
        var failed = Request("primary-failed", "failed", 503);
        var success = Request("backup-success", "succeeded", 200);
        success.PlatformId = "backup";
        success.StartedAt = At.AddSeconds(1);
        var before = Assert.Single(LlmGatewayIncidentPolicy.BuildSignals([failed]));
        Assert.True(LlmGatewayIncidentPolicy.BuildSignals([failed, success]).Single(s => s.Fingerprint == before.Fingerprint).IsFailure);
    }

    [Fact]
    public void SameRouteInDifferentDeployments_CannotRecoverEachOther()
    {
        var failed = Request("production-failed", "failed", 503);
        failed.SourceDeployment = "production";
        var success = Request("preview-success", "succeeded", 200);
        success.SourceDeployment = "preview";
        success.StartedAt = At.AddSeconds(1);
        var before = Assert.Single(LlmGatewayIncidentPolicy.BuildSignals([failed]));
        Assert.True(LlmGatewayIncidentPolicy.BuildSignals([failed, success]).Single(s => s.Fingerprint == before.Fingerprint).IsFailure);
    }

    internal static LlmRequestLog Request(string id, string status, int code) => new()
    {
        Id = id, RequestId = id, TenantId = "fixture-tenant", AppCallerCode = "fixture.future::generation",
        AppCallerCodeDisplayName = "未来模型创作", RequestType = "generation", Path = "/gw/v1/raw",
        PlatformId = "primary", PlatformName = "primary", Provider = "openai", Model = "future-model-z",
        Status = status, StatusCode = code, StartedAt = At,
    };

    internal static LlmProviderAttempt Attempt(string platform, string status, int code, int order) => new()
    {
        Order = order, Stage = "send", PlatformId = platform, PlatformName = platform, Provider = "openai",
        Model = "future-model-z", Status = status, StatusCode = code == 0 ? null : code,
        ReachedProvider = status != "selected", EndedAt = At.AddMilliseconds(order + 1),
        Error = code == 402 ? "insufficient_balance" : null,
    };
}
