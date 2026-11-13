using MongoDB.Bson;
using PrdAgent.LlmGw.Governance;
using Xunit;

namespace PrdAgent.Tests;

public sealed class PlatformRecentCallPolicyTests
{
    [Theory]
    [InlineData(429, "You have no credits remaining. Add credits to continue using the API.", "failed", "quota_exhausted")]
    [InlineData(429, "credit_balance_exhausted", "failed", "quota_exhausted")]
    [InlineData(429, "insufficient_quota", "failed", "quota_exhausted")]
    [InlineData(429, "You exceeded your current quota", "failed", "quota_exhausted")]
    [InlineData(429, "Rate limit exceeded, requests per minute", "failed", "rate_limited")]
    [InlineData(429, "", "failed", "rate_limited")]
    [InlineData(402, "", "failed", "quota_exhausted")]
    [InlineData(401, "invalid key", "failed", "rejected")]
    [InlineData(500, "server error", "failed", "service_error")]
    [InlineData(200, "", "succeeded", "succeeded")]
    public void DistinguishesQuotaFromRateLimitsAndSuccessfulRecovery(int status, string error, string state, string expected)
    {
        var log = Log(status, error, state);
        Assert.Equal(expected, PlatformRecentCallPolicy.Classify(log, null));
    }

    [Fact]
    public void RawImageBillingErrorInAnswerTextIsRecognizedWithoutExposingResponse()
    {
        var log = Log(429, "", "failed");
        log["AnswerText"] = "{\"error\":{\"code\":\"credit_balance_exhausted\",\"message\":\"quota depleted\"}}";
        Assert.Equal("quota_exhausted", PlatformRecentCallPolicy.Classify(log, null));
        log["AnswerText"] = "{\"userPrompt\":\"insufficient balance\",\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"Rate limit exceeded\"}}";
        Assert.Equal("rate_limited", PlatformRecentCallPolicy.Classify(log, null));
    }

    [Fact]
    public void OldFailureCannotDescribeTheCurrentCredentialAfterConfigurationChanges()
    {
        var log = Log(429, "insufficient_quota", "failed");
        var observedAt = log["StartedAt"].ToUniversalTime();
        Assert.Null(PlatformRecentCallPolicy.Classify(log, observedAt.AddSeconds(1)));
        Assert.Equal("quota_exhausted", PlatformRecentCallPolicy.Classify(log, observedAt));
        Assert.Null(PlatformRecentCallPolicy.Classify(null, null));
        log.Remove("StartedAt");
        Assert.Null(PlatformRecentCallPolicy.Classify(log, null));
    }

    private static BsonDocument Log(int status, string error, string state) => new()
    {
        ["StartedAt"] = DateTime.UtcNow,
        ["StatusCode"] = status,
        ["Status"] = state,
        ["Error"] = error,
    };
}
