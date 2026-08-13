using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ImageGenerationUserErrorTests
{
    [Theory]
    [InlineData(400, "Input must have at least 1 token.", ErrorCodes.IMAGE_GEN_UNAVAILABLE)]
    [InlineData(404, "openai/gpt-5.4-image-2 was not found", ErrorCodes.IMAGE_GEN_UNAVAILABLE)]
    [InlineData(429, "rate limit exceeded", ErrorCodes.RATE_LIMITED)]
    [InlineData(408, "upstream timeout", ErrorCodes.IMAGE_GEN_TIMEOUT)]
    [InlineData(400, "blocked by safety policy", ErrorCodes.IMAGE_GEN_REQUEST_REJECTED)]
    [InlineData(403, "content_policy_violation", ErrorCodes.IMAGE_GEN_REQUEST_REJECTED)]
    [InlineData(403, "content_filter", ErrorCodes.IMAGE_GEN_REQUEST_REJECTED)]
    [InlineData(403, "moderation_blocked", ErrorCodes.IMAGE_GEN_REQUEST_REJECTED)]
    [InlineData(403, "unsafe content", ErrorCodes.IMAGE_GEN_REQUEST_REJECTED)]
    [InlineData(500, "unsafe content", ErrorCodes.IMAGE_GEN_REQUEST_REJECTED)]
    [InlineData(500, "provider internal error", ErrorCodes.IMAGE_GEN_UNAVAILABLE)]
    public void Classify_ShouldReturnUserReadableMessageWithoutRawDiagnostic(
        int statusCode,
        string diagnostic,
        string expectedCode)
    {
        var result = ImageGenerationUserError.Classify(statusCode, diagnostic);

        Assert.Equal(expectedCode, result.Code);
        Assert.DoesNotContain(diagnostic, result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HTTP", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("OpenRouter", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Vision API", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("。", result.Message);
    }

    [Fact]
    public void MissingImage_ShouldExplainOutcomeAndRecoveryAction()
    {
        var result = ImageGenerationUserError.MissingImage();

        Assert.Equal(ErrorCodes.IMAGE_GEN_UNAVAILABLE, result.Code);
        Assert.Contains("没有返回可用图片", result.Message);
        Assert.Contains("请重试", result.Message);
    }

    [Fact]
    public void FromGateway_ShouldPreserveQuotaCodeAndAdministratorRecoveryAction()
    {
        var result = ImageGenerationUserError.FromGateway(new GatewayRawResponse
        {
            Success = false,
            StatusCode = 429,
            ErrorCode = GatewayQuotaAlertPolicy.QuotaErrorCode,
            ErrorMessage = "Key limit exceeded"
        });

        Assert.Equal(GatewayQuotaAlertPolicy.QuotaErrorCode, result.Code);
        Assert.Equal(GatewayQuotaAlertPolicy.UserReadableQuotaMessage, result.Message);
        Assert.Contains("管理员需要检查服务额度或切换可用配置", result.Message);
        Assert.DoesNotContain("Key limit", result.Message, StringComparison.OrdinalIgnoreCase);
    }
}
