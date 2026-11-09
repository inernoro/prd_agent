using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayBillingFailureTests
{
    [Theory]
    [InlineData(403, "{\"error\":{\"code\":\"AccountOverdueError\",\"message\":\"rejected\"}}", GatewayBillingFailure.AccountOverdue)]
    [InlineData(403, "{\"error\":{\"code\":\"OperationDenied.ServiceOverdue\"}}", GatewayBillingFailure.AccountOverdue)]
    [InlineData(403, "The request failed because your account has an overdue balance.", GatewayBillingFailure.AccountOverdue)]
    [InlineData(429, "{\"error\":{\"code\":\"credit_balance_exhausted\",\"type\":\"insufficient_quota\"}}", GatewayBillingFailure.InsufficientBalance)]
    [InlineData(429, "{\"error\":{\"code\":\"organization_usage_limit_exceeded\"}}", GatewayBillingFailure.QuotaExceeded)]
    [InlineData(429, "{\"error\":{\"type\":\"insufficient_quota\"}}", GatewayBillingFailure.QuotaExceeded)]
    [InlineData(403, "{\"error\":{\"metadata\":{\"limit_source\":\"openrouter_key_limit\"}}}", GatewayBillingFailure.QuotaExceeded)]
    [InlineData(403, "Key limit exceeded (total limit). $30.01 of $30.00 used; does not reset.", GatewayBillingFailure.QuotaExceeded)]
    [InlineData(403, "user quota is not enough", GatewayBillingFailure.QuotaExceeded)]
    [InlineData(402, "Payment required", GatewayBillingFailure.PaymentRequired)]
    public void ExplicitBillingEvidence_ProducesSpecificSafeCode(int status, string body, string code)
    {
        var result = GatewayBillingFailure.Classify(status, body);
        Assert.NotNull(result); Assert.Equal(code, result.Code);
        Assert.Contains("上游 AI 服务", result.UserMessage);
        Assert.Contains("管理员", result.UserMessage);
        Assert.Contains("处理后再重试", result.UserMessage);
        Assert.DoesNotContain("http", result.UserMessage);
        Assert.DoesNotContain("$30", result.UserMessage);
    }

    [Theory]
    [InlineData(429, "Rate limit exceeded: requests per minute")]
    [InlineData(403, "requested resource not granted")]
    [InlineData(403, "{\"error\":{\"code\":\"AccessDenied\",\"message\":\"resource not authorized\"}}")]
    [InlineData(403, "{\"error\":{\"code\":\"OperationDenied.FileQuotaExceeded\",\"message\":\"file storage quota exceeded\"}}")]
    [InlineData(402, "{\"error\":{\"message\":\"insufficient credits\",\"metadata\":{\"limit_source\":\"openrouter_in_flight_budget\"}}}")]
    [InlineData(400, "{\"prompt\":\"账户欠费\",\"error\":{\"code\":\"InvalidParameter\",\"message\":\"invalid size\"}}")]
    [InlineData(200, "account has an overdue balance")]
    [InlineData(500, "connection failed")]
    [InlineData(400, "{\"error\":{\"code\":\"InvalidParameter\",\"message\":\"invalid prompt: overdue balance\"}}")]
    [InlineData(500, "upstream echoed: insufficient balance")]
    [InlineData(403, "Forbidden")]
    [InlineData(429, "limit exceeded")]
    public void NonBillingOrAmbiguousFailures_AreNotCalledOverdue(int status, string body)
        => Assert.Null(GatewayBillingFailure.Classify(status, body));

    [Theory]
    [InlineData(GatewayBillingFailure.AccountOverdue, "账户欠费")]
    [InlineData(GatewayBillingFailure.InsufficientBalance, "余额不足")]
    [InlineData(GatewayBillingFailure.QuotaExceeded, "额度已用尽")]
    [InlineData(GatewayBillingFailure.PaymentRequired, "账单或费用额度")]
    public void TaskErrors_PreserveTheCauseThroughSanitization(string code, string phrase)
    {
        var raw = new GatewayRawResponse { Success = false, StatusCode = 403, ErrorCode = code,
            ErrorMessage = "sensitive provider diagnostic https://secret.invalid/key/SECRET" };
        var image = ImageGenerationUserError.FromGateway(raw);
        var video = VideoGenerationUserError.ForPersistence(code, raw.ErrorMessage);
        Assert.Equal(code, image.Code); Assert.Contains(phrase, image.Message); Assert.Contains(phrase, video);
        Assert.DoesNotContain("SECRET", image.Message + video);
        Assert.Equal(video, VideoGenerationUserError.ForPersistence(code, video));
        Assert.Equal(video, VideoGenerationUserError.ForPersistence("VIDEOGEN_ERROR", video));
    }

    [Fact]
    public void AsrOverdue_DoesNotPromiseAutomaticRetry()
    {
        var failure = AudioTranscriptionUserError.Classify(new InvalidOperationException("上游 AI 服务账户欠费"));
        Assert.Equal(GatewayBillingFailure.AccountOverdue, failure.Code);
        Assert.False(failure.AutomaticRetryAllowed); Assert.Contains("原始音频已保留", failure.UserMessage);
    }
}
