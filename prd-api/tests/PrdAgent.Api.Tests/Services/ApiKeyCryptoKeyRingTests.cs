using Microsoft.Extensions.Configuration;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Security;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ApiKeyCryptoKeyRingTests
{
    [Fact]
    public void Decrypt_ShouldReadDedicatedSecretCipher()
    {
        var config = BuildConfig(primary: "primary-secret-for-api-key-crypto-2026", jwt: "jwt-secret-for-login-token-2026-only");
        var cipher = ApiKeyCryptoKeyRing.Encrypt("sk-test-primary", config);

        var result = ApiKeyCryptoKeyRing.Decrypt(cipher, config);

        result.Success.ShouldBeTrue();
        result.PlainText.ShouldBe("sk-test-primary");
        result.UsedLegacySecret.ShouldBeFalse();
    }

    [Fact]
    public void Decrypt_ShouldFallbackToLegacyJwtSecret()
    {
        var legacyJwt = "legacy-jwt-secret-for-old-cipher-2026";
        var config = BuildConfig(primary: "primary-secret-for-api-key-crypto-2026", jwt: legacyJwt);
        var legacyCipher = ApiKeyCrypto.Encrypt("sk-test-legacy", legacyJwt);

        var result = ApiKeyCryptoKeyRing.Decrypt(legacyCipher, config);

        result.Success.ShouldBeTrue();
        result.PlainText.ShouldBe("sk-test-legacy");
        result.UsedLegacySecret.ShouldBeTrue();
    }

    [Fact]
    public void Decrypt_ShouldFallbackToConfiguredLegacySecrets()
    {
        var oldSecret = "old-data-secret-for-imported-cipher-2026";
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ApiKeyCrypto:Secret"] = "primary-secret-for-api-key-crypto-2026",
                ["ApiKeyCrypto:LegacySecrets"] = $"unused-secret;{oldSecret}",
                ["Jwt:Secret"] = "jwt-secret-for-login-token-2026-only",
            })
            .Build();
        var legacyCipher = ApiKeyCrypto.Encrypt("sk-test-configured-legacy", oldSecret);

        var result = ApiKeyCryptoKeyRing.Decrypt(legacyCipher, config);

        result.Success.ShouldBeTrue();
        result.PlainText.ShouldBe("sk-test-configured-legacy");
        result.UsedLegacySecret.ShouldBeTrue();
    }

    [Fact]
    public void Decrypt_ShouldKeepSymbolRichApiKey()
    {
        var config = BuildConfig(primary: "primary-secret-for-api-key-crypto-2026", jwt: "jwt-secret-for-login-token-2026-only");
        var plainText = "sk-test_ABC+123/xyz==";
        var cipher = ApiKeyCryptoKeyRing.Encrypt(plainText, config);

        var result = ApiKeyCryptoKeyRing.Decrypt(cipher, config);

        result.Success.ShouldBeTrue();
        result.PlainText.ShouldBe(plainText);
        result.UsedLegacySecret.ShouldBeFalse();
    }

    [Theory]
    [InlineData("Stub 开发桩", "openai", "https://example.com/v1", true)]
    [InlineData("Local Stub", "stub", "https://example.com/v1", true)]
    [InlineData("Local Dev", "openai", "https://example.com/api/v1/stub", true)]
    [InlineData("OpenAI", "openai", "https://api.openai.com/v1", false)]
    public void PlatformApiKeyPolicy_ShouldTreatStubPlatformAsOptional(
        string name,
        string providerId,
        string apiUrl,
        bool expected)
    {
        var platform = new LLMPlatform
        {
            Name = name,
            ProviderId = providerId,
            ApiUrl = apiUrl
        };

        PlatformApiKeyPolicy.IsApiKeyOptional(platform).ShouldBe(expected);
    }

    private static IConfiguration BuildConfig(string primary, string jwt)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ApiKeyCrypto:Secret"] = primary,
                ["Jwt:Secret"] = jwt,
            })
            .Build();
}
