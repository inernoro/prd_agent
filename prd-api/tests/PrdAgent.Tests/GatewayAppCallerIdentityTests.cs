using MongoDB.Driver;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayAppCallerIdentityTests
{
    [Fact]
    public void NormalizePart_ShouldTrimWithoutChangingStableCode()
    {
        Assert.Equal(
            "report-agent.generate::chat",
            GatewayAppCallerIdentity.NormalizePart("  report-agent.generate::chat  "));
    }

    [Fact]
    public void Collation_ShouldBeCaseInsensitiveButAccentSensitiveEnoughForIdentity()
    {
        Assert.Equal("en", GatewayAppCallerIdentity.Collation.Locale);
        Assert.Equal(CollationStrength.Secondary, GatewayAppCallerIdentity.Collation.Strength);
    }
}
