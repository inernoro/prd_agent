using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Provisioning;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayConfigurationProvisioningTests
{
    [Theory]
    [InlineData("openrouter", "openai")]
    [InlineData("openai-compatible", "openai")]
    [InlineData("anthropic", "claude")]
    [InlineData("claude-compatible", "claude")]
    public void Platform_NormalizesCompatibleProviderAliases(string input, string expected)
    {
        var ok = GatewayConfigurationProvisioning.TryNormalizePlatform(new CreatePlatformRequest
        {
            Name = "教程 Provider",
            PlatformType = input,
            ApiUrl = "https://provider.example.com/v1/",
            ApiKey = "test-secret",
        }, out var draft, out var error);

        ok.ShouldBeTrue(error);
        draft.ShouldNotBeNull();
        draft.PlatformType.ShouldBe(expected);
        draft.ApiUrl.ShouldBe("https://provider.example.com/v1");
    }

    [Theory]
    [InlineData("provider.example.com/v1")]
    [InlineData("file:///tmp/upstream")]
    [InlineData("https://user:password@provider.example.com/v1")]
    public void Platform_RejectsUnsafeOrIncompleteUrls(string apiUrl)
    {
        GatewayConfigurationProvisioning.TryNormalizePlatform(new CreatePlatformRequest
        {
            Name = "教程 Provider",
            PlatformType = "openai",
            ApiUrl = apiUrl,
            ApiKey = "test-secret",
        }, out _, out var error).ShouldBeFalse();

        error.ShouldContain("http");
    }

    [Fact]
    public void Platform_RequiresProviderCommunicationKey()
    {
        GatewayConfigurationProvisioning.TryNormalizePlatform(new CreatePlatformRequest
        {
            Name = "教程 Provider",
            PlatformType = "openai",
            ApiUrl = "https://provider.example.com/v1",
        }, out _, out var error).ShouldBeFalse();

        error.ShouldContain("通讯密钥");
    }

    [Fact]
    public void PlatformDocument_TenantComesOnlyFromServerArgument()
    {
        typeof(CreatePlatformRequest).GetProperty("TenantId").ShouldBeNull();
        GatewayConfigurationProvisioning.TryNormalizePlatform(new CreatePlatformRequest
        {
            Name = "同名 Provider",
            PlatformType = "openai",
            ApiUrl = "https://provider.example.com/v1",
            ApiKey = "test-secret",
        }, out var draft, out var error).ShouldBeTrue(error);

        var document = GatewayConfigurationProvisioning.BuildPlatformDocument(
            draft!, "tenant-from-session", "platform-1", "encrypted", DateTime.UnixEpoch);

        document["TenantId"].AsString.ShouldBe("tenant-from-session");
        document["NameNormalized"].AsString.ShouldBe("同名 provider");
        document.Contains("ApiKey").ShouldBeFalse();
        document["ApiKeyEncrypted"].AsString.ShouldBe("encrypted");
    }

    [Fact]
    public void Model_RequiresAtLeastOneKnownPurpose()
    {
        GatewayConfigurationProvisioning.TryNormalizeModel(new CreateModelRequest
        {
            PlatformId = "platform-1",
            ModelName = "tutorial-chat",
        }, out _, out var missingError).ShouldBeFalse();
        missingError.ShouldContain("至少选择");

        GatewayConfigurationProvisioning.TryNormalizeModel(new CreateModelRequest
        {
            PlatformId = "platform-1",
            ModelName = "tutorial-chat",
            Capabilities = ["unknown-purpose"],
        }, out _, out var unknownError).ShouldBeFalse();
        unknownError.ShouldContain("不支持");
    }

    [Fact]
    public void Model_AllowsExplicitProviderProtocolInheritance()
    {
        GatewayConfigurationProvisioning.TryNormalizeModel(new CreateModelRequest
        {
            PlatformId = "platform-1",
            ModelName = "tutorial-chat",
            Protocol = "inherit",
            Capabilities = ["chat"],
        }, out var draft, out var error).ShouldBeTrue(error);

        draft.ShouldNotBeNull();
        draft.Protocol.ShouldBeNull();
    }

    [Fact]
    public void Model_PriceRequiresCurrencyButUnknownCostStaysNull()
    {
        var priced = new CreateModelRequest
        {
            PlatformId = "platform-1",
            ModelName = "tutorial-chat",
            Capabilities = ["chat"],
            InputPricePerMillion = 1.2m,
        };
        GatewayConfigurationProvisioning.TryNormalizeModel(priced, out _, out var error).ShouldBeFalse();
        error.ShouldContain("CNY 或 USD");

        var unknown = new CreateModelRequest
        {
            PlatformId = "platform-1",
            ModelName = "tutorial-chat",
            Capabilities = ["chat"],
        };
        GatewayConfigurationProvisioning.TryNormalizeModel(unknown, out var draft, out error).ShouldBeTrue(error);
        var document = GatewayConfigurationProvisioning.BuildModelDocument(
            draft!, "tenant-a", "model-1", null, DateTime.UnixEpoch);

        document["InputPricePerMillion"].IsBsonNull.ShouldBeTrue();
        document["OutputPricePerMillion"].IsBsonNull.ShouldBeTrue();
        document["PricePerCall"].IsBsonNull.ShouldBeTrue();
        document["PriceCurrency"].IsBsonNull.ShouldBeTrue();
    }

    [Fact]
    public void ModelDocument_MapsPurposesForExistingAppendOnlyRegistry()
    {
        typeof(CreateModelRequest).GetProperty("TenantId").ShouldBeNull();
        GatewayConfigurationProvisioning.TryNormalizeModel(new CreateModelRequest
        {
            PlatformId = "platform-1",
            Name = "教程多模态模型",
            ModelName = "tutorial-multimodal",
            Capabilities = ["chat", "vision", "generation", "long-context"],
        }, out var draft, out var error).ShouldBeTrue(error);

        var document = GatewayConfigurationProvisioning.BuildModelDocument(
            draft!, "tenant-from-session", "model-1", null, DateTime.UnixEpoch);
        var capabilityTypes = document["Capabilities"].AsBsonArray
            .Select(item => item.AsBsonDocument["Type"].AsString)
            .ToList();

        document["TenantId"].AsString.ShouldBe("tenant-from-session");
        capabilityTypes.ShouldBe(["chat", "vision", "image_generation", "long_context"]);
        document["IsVision"].AsBoolean.ShouldBeTrue();
        document["IsImageGen"].AsBoolean.ShouldBeTrue();
        document.Contains("ApiKeyEncrypted").ShouldBeFalse();
    }
}
