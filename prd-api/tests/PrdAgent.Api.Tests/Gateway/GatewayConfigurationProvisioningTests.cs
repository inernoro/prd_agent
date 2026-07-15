using MongoDB.Bson;
using PrdAgent.LlmGw.ModelPools;
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

    [Fact]
    public void Exchange_RequiresCommunicationKeyAndAtLeastOneUniqueModelMapping()
    {
        var missingKey = new CreateExchangeRequest
        {
            Name = "教程原生中继",
            TargetUrl = "https://provider.example.com/v1/models/{model}:generate",
            Models = [new ExchangeModelWriteRequest { ModelId = "tutorial-chat", ModelType = "chat" }],
        };
        GatewayConfigurationProvisioning.TryNormalizeExchange(missingKey, out _, out var missingKeyError).ShouldBeFalse();
        missingKeyError.ShouldContain("通讯密钥");

        missingKey.ApiKey = "test-secret";
        missingKey.Models.Add(new ExchangeModelWriteRequest { ModelId = "TUTORIAL-CHAT", ModelType = "vision" });
        GatewayConfigurationProvisioning.TryNormalizeExchange(missingKey, out _, out var duplicateError).ShouldBeFalse();
        duplicateError.ShouldContain("重复");
    }

    [Theory]
    [InlineData("provider.example.com/v1")]
    [InlineData("file:///tmp/upstream")]
    [InlineData("https://user:password@provider.example.com/v1")]
    [InlineData("https://provider.example.com/v1?api_key=must-not-leak")]
    [InlineData("wss://provider.example.com/v1?token=must-not-leak")]
    [InlineData("https://provider.example.com/v1?access-token=must-not-leak")]
    [InlineData("https://provider.example.com/v1?X-Amz-Signature=must-not-leak")]
    [InlineData("https://provider.example.com/v1#secret-must-not-be-stored")]
    public void Exchange_RejectsUnsafeOrIncompleteUrls(string targetUrl)
    {
        GatewayConfigurationProvisioning.TryNormalizeExchange(new CreateExchangeRequest
        {
            Name = "教程原生中继",
            TargetUrl = targetUrl,
            ApiKey = "test-secret",
            Models = [new ExchangeModelWriteRequest { ModelId = "tutorial-chat", ModelType = "chat" }],
        }, out _, out var error).ShouldBeFalse();

        error.ShouldContain("地址");
    }

    [Fact]
    public void ExchangeDocument_TenantComesOnlyFromServerAndSecretNeverReturnsAsPlaintext()
    {
        typeof(CreateExchangeRequest).GetProperty("TenantId").ShouldBeNull();
        typeof(UpdateExchangeRequest).GetProperty("TenantId").ShouldBeNull();
        GatewayConfigurationProvisioning.TryNormalizeExchange(new CreateExchangeRequest
        {
            Name = "教程原生中继",
            TargetUrl = "wss://provider.example.com/v1/stream",
            ApiKey = "test-secret",
            TargetAuthScheme = "x-api-key",
            TransformerType = "doubao-asr-stream",
            Models =
            [
                new ExchangeModelWriteRequest { ModelId = "tutorial-asr", DisplayName = "教程语音", ModelType = "asr" },
                new ExchangeModelWriteRequest { ModelId = "tutorial-chat", ModelType = "chat", Enabled = false },
            ],
        }, out var draft, out var error).ShouldBeTrue(error);

        var document = GatewayConfigurationProvisioning.BuildExchangeDocument(
            draft!, "tenant-from-session", "gw-exchange-1", "encrypted-only", DateTime.UnixEpoch);

        document["TenantId"].AsString.ShouldBe("tenant-from-session");
        document["NameNormalized"].AsString.ShouldBe("教程原生中继");
        document["TargetAuthScheme"].AsString.ShouldBe("XApiKey");
        document["TargetApiKeyEncrypted"].AsString.ShouldBe("encrypted-only");
        document.Contains("ApiKey").ShouldBeFalse();
        document["Models"].AsBsonArray.Count.ShouldBe(2);
        document["Version"].AsInt64.ShouldBe(1);
    }

    [Fact]
    public void ExchangeUpdate_RequiresVersionAndRejectsUnknownTransformer()
    {
        var request = new UpdateExchangeRequest
        {
            Name = "教程原生中继",
            TargetUrl = "https://provider.example.com/v1/models/{model}",
            TargetAuthScheme = "Bearer",
            TransformerType = "unknown-transformer",
            Models = [new ExchangeModelWriteRequest { ModelId = "tutorial-chat", ModelType = "chat" }],
        };
        GatewayConfigurationProvisioning.TryNormalizeExchange(request, out _, out var versionError).ShouldBeFalse();
        versionError.ShouldContain("version");

        request.Version = 3;
        GatewayConfigurationProvisioning.TryNormalizeExchange(request, out _, out var transformerError).ShouldBeFalse();
        transformerError.ShouldContain("转换器");
    }

    [Theory]
    [InlineData("chat")]
    [InlineData("vision")]
    [InlineData("generation")]
    [InlineData("asr")]
    public void ExchangeModel_CanJoinItsDeclaredProgramPool(string modelType)
    {
        var exchangeModel = new BsonDocument
        {
            ["ModelId"] = $"tutorial-{modelType}",
            ["DisplayName"] = $"教程 {modelType}",
            ["ModelType"] = modelType,
            ["Enabled"] = true,
        };

        var model = GatewayConfigurationProvisioning.BuildExchangePoolModelDocument("exchange-1", exchangeModel);

        model["PlatformId"].AsString.ShouldBe("exchange-1");
        model["ModelName"].AsString.ShouldBe($"tutorial-{modelType}");
        model["SourceCollection"].AsString.ShouldBe("llmgw_model_exchanges");
        GatewayModelPoolTypeRegistry.IsCompatible(model, modelType).ShouldBeTrue();
    }
}
