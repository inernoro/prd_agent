using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class AuthorizationHealthControllerTests
{
    [Theory]
    [InlineData(401, null, false)]
    [InlineData(401, ErrorCodes.UNAUTHORIZED, false)]
    [InlineData(401, "AUTH_AGENT_KEY_INVALID", true)]
    [InlineData(403, null, false)]
    [InlineData(403, ErrorCodes.PERMISSION_DENIED, true)]
    public void IsClassifiedFailure_RequiresAStableDiagnosticCode(int statusCode, string? errorCode, bool expected)
    {
        var log = new ApiRequestLog
        {
            StatusCode = statusCode,
            ErrorCode = errorCode,
        };

        Assert.Equal(expected, AuthorizationHealthController.IsClassifiedFailure(log));
    }

    [Theory]
    [InlineData(401, "AUTH_UNCLASSIFIED_401")]
    [InlineData(403, "AUTH_UNCLASSIFIED_403")]
    public void ToFailure_UsesStatusSpecificFallbackCode(int statusCode, string expected)
    {
        var failure = AuthorizationHealthController.ToFailure(new ApiRequestLog
        {
            StatusCode = statusCode,
        });

        Assert.Equal(expected, failure.Code);
    }
}
