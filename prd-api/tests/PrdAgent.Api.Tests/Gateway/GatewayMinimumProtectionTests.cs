using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using PrdAgent.Api.Services;
using Microsoft.AspNetCore.Http;
using PrdAgent.Core.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayMinimumProtectionTests
{
    [Theory]
    [InlineData(null, "automatic")]
    [InlineData("interactive", "general")]
    [InlineData("agent", "automatic")]
    [InlineData("scheduled", "automatic")]
    public void OriginUsesServerVerifiedPermitAndNeverSelfReportedHeaders(string? origin, string expected)
    {
        var http = new DefaultHttpContext();
        http.Request.Headers["X-Gateway-Execution-Origin"] = "interactive";
        http.Request.Headers["X-Gateway-Source-Deployment"] = "forged-deployment";
        http.Request.Headers["X-Gateway-User-Id"] = "business-owner";
        var authorization = new GatewayKeyAuthorization(true, true, 200, "", "",
            TenantId: "tenant", LegacySharedKey: true, ClientCode: "map-internal");
        if (origin is not null)
            http.Items[GatewayTaskAdmission.HttpContextPermitKey] = new GatewayTaskPermitRecord
                { Origin = origin, SourceDeployment = "cds:branch-one/rev-a" };

        var identity = GatewayMinimumRequestIdentity.Resolve(http, authorization, "map", "gw-native");

        identity.Origin.ShouldBe(expected);
        identity.SourceDeployment.ShouldBe(expected == "automatic" && origin is not null ? "cds:branch-one/rev-a" : null);
    }

    [Fact]
    public void UnauthenticatedOriginAndArbitraryDeploymentTextAreNotTrusted()
    {
        var http = new DefaultHttpContext();
        http.Request.Headers["X-Gateway-Execution-Origin"] = "automatic";
        http.Request.Headers["X-Gateway-Source-Deployment"] = "arbitrary request payload";
        var authorization = new GatewayKeyAuthorization(true, false, 200, "", "", LegacySharedKey: true, ClientCode: "map-internal");
        GatewayMinimumRequestIdentity.Resolve(http, authorization, "map", "gw-native").Automatic.ShouldBeFalse();
        var verified = authorization with { Authenticated = true };
        GatewayMinimumRequestIdentity.Resolve(http, verified, "map", "gw-native").SourceDeployment.ShouldBeNull();
    }
    [Fact]
    public void DynamicPolicyRequiresExplicitBoundedConfigurationAndEnoughCompletedSamples()
    {
        var fields = new Dictionary<string, string?>
        {
            ["Enabled"] = "true", ["WindowSeconds"] = "3600", ["SampleWindows"] = "4",
            ["MinimumSamples"] = "3", ["Multiplier"] = "2", ["MinimumCount"] = "6",
        };
        IConfiguration Config() => new ConfigurationBuilder().AddInMemoryCollection(fields
            .Select(field => new KeyValuePair<string, string?>("LlmGateway:MinimumProtection:DynamicRateBaseline:" + field.Key, field.Value))).Build();
        var policy = GatewayDynamicRatePolicy.Read(Config(), out var error);
        error.ShouldBeNull();
        policy.ShouldNotBeNull();
        policy!.Evaluate(new long[] { 2, 2 }).ShouldBeNull();
        var baseline = policy.Evaluate(new long[] { 2, 2, 2 });
        baseline!.Threshold.ShouldBe(6);
        policy.Evaluate(new long[] { 6, 6, 6 })!.Threshold.ShouldBe(12, "基线随已结束的历史变化，不固定为最小触发线");
        policy.Evaluate(new long[] { long.MaxValue, long.MaxValue, long.MaxValue }).ShouldBeNull();
        foreach (var (field, value) in new[]
        {
            ("WindowSeconds", "5"), ("SampleWindows", "1441"), ("SampleWindows", "49"),
            ("MinimumSamples", "1"), ("MinimumSamples", "5"), ("Multiplier", ""),
            ("Multiplier", "1"), ("Multiplier", "1001"), ("Multiplier", "1,5"), ("MinimumCount", "0"),
        })
        {
            var original = fields[field];
            fields[field] = value;
            GatewayDynamicRatePolicy.Read(Config(), out error).ShouldBeNull();
            error.ShouldNotBeNull();
            fields[field] = original;
        }
        fields["Enabled"] = "false";
        GatewayDynamicRatePolicy.Read(Config(), out error).ShouldBeNull();
        error.ShouldBeNull();
    }

    [Fact]
    public void DynamicNotificationKeepsWindowDedupAndNeverClaimsItChangedHardLimit()
    {
        var alert = new BsonDocument
        {
            ["_id"] = "dynamic-window", ["Kind"] = "warning", ["Metric"] = "request_rate_baseline",
            ["AppCallerCode"] = "future-business::chat", ["Count"] = 6L, ["Limit"] = 6,
            ["BaselineAverage"] = new Decimal128(2m), ["BaselineSamples"] = 3, ["RequestId"] = "local-request",
        };
        var first = LlmGatewayIncidentWatchdog.BuildConsumptionNotification(alert)!;
        var replay = LlmGatewayIncidentWatchdog.BuildConsumptionNotification(alert)!;
        first.Id.ShouldBe(replay.Id);
        first.Key.ShouldBe(replay.Key);
        first.Title!.ShouldContain("历史基线");
        first.Message!.ShouldContain("3 个已结束窗口");
        first.Message!.ShouldContain("不修改现有限额");
        first.Message!.ShouldNotContain("超额请求已在发送上游之前拒绝");
    }

}
