using System.Text.Json;
using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Authentication;
using Xunit;

namespace PrdAgent.Api.Tests.Authentication;

public sealed class AuthorizationFailureContractTests
{
    [Fact]
    public async Task WriteChallengeAsync_ReturnsClassifiedAiKeyFailureWithoutSecretMaterial()
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        AuthorizationFailureContract.Set(context, AuthorizationFailureContract.AiKeyInvalid);

        await AuthorizationFailureContract.WriteChallengeAsync(context);

        context.Response.Body.Position = 0;
        var body = await new StreamReader(context.Response.Body).ReadToEndAsync();
        using var json = JsonDocument.Parse(body);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.Equal(AuthorizationFailureContract.AiKeyInvalid, context.Response.Headers["X-Auth-Diagnosis"]);
        Assert.Equal(AuthorizationFailureContract.AiKeyInvalid, json.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.DoesNotContain("secret", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GetOrDefault_DistinguishesMissingAndInvalidUserSession()
    {
        var missing = AuthorizationFailureContract.GetOrDefault(new DefaultHttpContext(), hasBearerToken: false);
        var invalid = AuthorizationFailureContract.GetOrDefault(new DefaultHttpContext(), hasBearerToken: true);

        Assert.Equal(AuthorizationFailureContract.SessionRequired, missing.Code);
        Assert.Equal(AuthorizationFailureContract.SessionInvalid, invalid.Code);
    }

    [Theory]
    [InlineData(AuthorizationFailureContract.AgentKeyInvalid)]
    [InlineData(AuthorizationFailureContract.StableSmokeSignatureInvalid)]
    [InlineData(AuthorizationFailureContract.AiIdentityUnavailable)]
    public void Resolve_ProvidesUserReadableRecovery(string code)
    {
        var failure = AuthorizationFailureContract.Resolve(code);

        Assert.Equal(code, failure.Code);
        Assert.False(string.IsNullOrWhiteSpace(failure.Message));
        Assert.False(string.IsNullOrWhiteSpace(failure.Recovery));
    }
}
