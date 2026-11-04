using Xunit;
namespace PrdAgent.Api.Tests.Middleware;

public sealed class MiduoPlanetSsoCredentialLoggingTests
{
    [Theory]
    [InlineData("/api/v1/auth/miduo-planet/login")]
    [InlineData("/api/v1/auth/miduo-planet/options")]
    public void RawSsoBodies_ShouldBeExcludedFromGeneralLogs(string path)
        => Assert.True(RequestLogRedactionProbe.CarriesCredential(path));
}
