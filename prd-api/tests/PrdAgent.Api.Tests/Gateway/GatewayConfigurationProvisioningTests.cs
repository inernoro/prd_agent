using MongoDB.Bson;
using PrdAgent.Core.Models;
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
    public void ImageGenerationModel_PersistsStructuredUpstreamSizeControlCapabilities()
    {
        GatewayConfigurationProvisioning.TryNormalizeModel(new CreateModelRequest
        {
            PlatformId = "platform-1",
            ModelName = "custom-image-model",
            Capabilities = ["generation"],
            ImageSizeControlMode = "field_and_prompt",
            ImageSizeFieldFormat = "aspect_ratio",
        }, out var draft, out var error).ShouldBeTrue(error);

        var document = GatewayConfigurationProvisioning.BuildModelDocument(
            draft!, "tenant-a", "model-image", null, DateTime.UnixEpoch);
        var capabilityTypes = document["Capabilities"].AsBsonArray
            .Select(item => item.AsBsonDocument["Type"].AsString)
            .ToList();

        capabilityTypes.ShouldContain("image_generation");
        capabilityTypes.ShouldContain("parameter:image_size.prompt");
        capabilityTypes.ShouldContain("parameter:image_size.field.aspect_ratio");
        capabilityTypes
            .Where(ImageSizeControlCapabilities.IsSizeControlCapability)
            .ShouldBe(ImageSizeControlCapabilities.BuildCapabilityTypes(
                ImageSizeControlModes.FieldAndPrompt,
                ImageSizeFieldFormats.AspectRatio));
    }

    [Fact]
    public void NonImageModel_RejectsImageSizeControlCapability()
    {
        GatewayConfigurationProvisioning.TryNormalizeModel(new CreateModelRequest
        {
            PlatformId = "platform-1",
            ModelName = "tutorial-chat",
            Capabilities = ["chat"],
            ImageSizeControlMode = "prompt",
        }, out _, out var error).ShouldBeFalse();

        error.ShouldContain("图片生成模型");
    }

    [Theory]
    [InlineData("parameter:image_size.none")]
    [InlineData(" PARAMETER:IMAGE_SIZE.FIELD.SIZE ")]
    [InlineData("parameter.image_size.prompt")]
    [InlineData("param:image_size.field.aspect_ratio")]
    [InlineData("param.image_size.field.width_height")]
    public void BulkCapabilityType_ReservesImageSizeNamespaceForDedicatedEndpoint(string capabilityType)
    {
        GatewayConfigurationProvisioning.TryNormalizeBulkCapabilityType(
            capabilityType, out _, out var error).ShouldBeFalse();

        error.ShouldContain("专用接口");
    }

    [Fact]
    public void BulkCapabilityType_NormalizesOrdinaryCapability()
    {
        GatewayConfigurationProvisioning.TryNormalizeBulkCapabilityType(
            " vision ", out var type, out var error).ShouldBeTrue(error);

        type.ShouldBe("vision");
    }

    [Fact]
    public void ImageSizeControlMapping_NormalizesSupportedParameterAliases()
    {
        var result = GatewayConfigurationProvisioning.MapImageSizeControl(
        [
            new BsonDocument { ["Type"] = "param.image_size.prompt", ["Value"] = true },
            new BsonDocument { ["Type"] = "parameter.image_size.field.aspect_ratio", ["Value"] = true },
        ]);

        result.Mode.ShouldBe("field_and_prompt");
        result.FieldFormat.ShouldBe("aspect_ratio");
    }

    [Theory]
    [InlineData(true, false, "inherit")]
    [InlineData(false, true, "none")]
    public void ImageSizeControlMapping_LaterAliasValueOverridesEarlierValue(
        bool canonicalValue,
        bool aliasValue,
        string expectedMode)
    {
        var result = GatewayConfigurationProvisioning.MapImageSizeControl(
        [
            new BsonDocument { ["Type"] = "parameter:image_size.none", ["Value"] = canonicalValue },
            new BsonDocument { ["Type"] = "param.image_size.none", ["Value"] = aliasValue },
        ]);

        result.Mode.ShouldBe(expectedMode);
        result.FieldFormat.ShouldBeNull();
    }

    [Fact]
    public void ContainsImageSizeControlCapability_RecognizesReservedNamespaceAliases()
    {
        GatewayConfigurationProvisioning.ContainsImageSizeControlCapability(
            ["seed", "parameter:image_size.none"]).ShouldBeTrue();
        GatewayConfigurationProvisioning.ContainsImageSizeControlCapability(
            ["param.image_size.field.size"]).ShouldBeTrue();
        GatewayConfigurationProvisioning.ContainsImageSizeControlCapability(
            ["image_generation", "parameter:seed"]).ShouldBeFalse();
    }

    [Fact]
    public void HasEnabledCapability_RequiresBooleanTrueValue()
    {
        GatewayConfigurationProvisioning.HasEnabledCapability(
        [
            new BsonDocument { ["Type"] = "image_generation", ["Value"] = false },
        ], "image_generation").ShouldBeFalse();

        GatewayConfigurationProvisioning.HasEnabledCapability(
        [
            new BsonDocument { ["Type"] = "IMAGE_GENERATION", ["Value"] = true },
        ], "image_generation").ShouldBeTrue();

        GatewayConfigurationProvisioning.HasEnabledCapability(
        [
            new BsonDocument { ["Type"] = "text_to_image", ["Value"] = true },
        ], "image_generation", "text_to_image", "image").ShouldBeTrue();

        GatewayConfigurationProvisioning.HasEnabledCapability(
        [
            new BsonDocument { ["Type"] = "image", ["Value"] = true },
        ], "image_generation", "text_to_image", "image").ShouldBeTrue();

        GatewayConfigurationProvisioning.HasEnabledCapability(
        [
            new BsonDocument { ["Type"] = "image_generation", ["Value"] = false },
            new BsonDocument { ["Type"] = "image", ["Value"] = true },
        ], "image_generation", "text_to_image", "image").ShouldBeFalse();

        GatewayConfigurationProvisioning.HasEnabledCapability(
        [
            new BsonDocument { ["Type"] = "image", ["Value"] = true },
            new BsonDocument { ["Type"] = "image_generation", ["Value"] = false },
        ], "image_generation", "text_to_image", "image").ShouldBeTrue();
    }

    [Fact]
    public void ImageSizeControlMapping_IgnoresMissingAndNonBooleanValues()
    {
        var result = GatewayConfigurationProvisioning.MapImageSizeControl(
        [
            new BsonDocument { ["Type"] = "parameter:image_size.none" },
            new BsonDocument { ["Type"] = "parameter:image_size.prompt", ["Value"] = "true" },
            new BsonDocument { ["Type"] = "parameter:image_size.field.size", ["Value"] = false },
        ]);

        result.Mode.ShouldBe("inherit");
        result.FieldFormat.ShouldBeNull();
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

    // intent 池成员资格：判据必须读运维真正能改的那个面。
    //
    // 这三条钉的是一次真实事故：上游批量导入的模型 IsIntent/IsMain 恒为 false（那两位只在建模型
    // 那一刻由能力勾选写入），而控制台唯一能维护的能力面是 Capabilities 数组——判据不读它，于是
    // intent 默认池对全部批量导入模型永久关闭，没有任何一条控制台路径能往里放模型。
    [Fact]
    public void IntentPool_AcceptsExplicitlyDeclaredIntentCapability_NotOnlyLegacyFlags()
    {
        var bulkImported = new BsonDocument
        {
            ["ModelName"] = "gpt-5.6-sol",
            ["PlatformId"] = "platform-1",
            ["IsIntent"] = false,
            ["IsMain"] = false,
            ["Capabilities"] = new BsonArray
            {
                new BsonDocument { ["Type"] = "chat", ["Source"] = "inferred", ["Value"] = true },
            },
        };

        // 只有 chat 能力时不算 intent 可用：默认池会在建模型时自动追加所有兼容模型，
        // 认了 chat 就等于把几百个对话模型无差别灌进 intent 池。
        GatewayModelPoolTypeRegistry.IsCompatible(bulkImported, "intent").ShouldBeFalse();

        bulkImported["Capabilities"].AsBsonArray.Add(
            new BsonDocument { ["Type"] = "intent", ["Source"] = "user", ["Value"] = true });

        GatewayModelPoolTypeRegistry.IsCompatible(bulkImported, "intent").ShouldBeTrue();
    }

    [Fact]
    public void IntentPool_StillAcceptsLegacyFlagsWrittenAtModelCreation()
    {
        var byIntentFlag = new BsonDocument { ["IsIntent"] = true, ["IsMain"] = false };
        var byMainFlag = new BsonDocument { ["IsIntent"] = false, ["IsMain"] = true };
        var neither = new BsonDocument { ["IsIntent"] = false, ["IsMain"] = false };

        GatewayModelPoolTypeRegistry.IsCompatible(byIntentFlag, "intent").ShouldBeTrue();
        GatewayModelPoolTypeRegistry.IsCompatible(byMainFlag, "intent").ShouldBeTrue();
        GatewayModelPoolTypeRegistry.IsCompatible(neither, "intent").ShouldBeFalse();
    }

    [Fact]
    public void IntentPool_CapabilityValueFalseDoesNotCount()
    {
        var declaredThenRevoked = new BsonDocument
        {
            ["IsIntent"] = false,
            ["IsMain"] = false,
            ["Capabilities"] = new BsonArray
            {
                new BsonDocument { ["Type"] = "intent", ["Source"] = "user", ["Value"] = false },
            },
        };

        GatewayModelPoolTypeRegistry.IsCompatible(declaredThenRevoked, "intent").ShouldBeFalse();
    }

    [Fact]
    public void FalImageLayeringBlueprint_PublishesGenericLogicalCapabilityWithoutBusinessBinding()
    {
        var draft = FalImageLayeringProvisioning.CreateExchangeDraft("fal-secret");
        var logicalModel = FalImageLayeringProvisioning.BuildLogicalModelDocument(
            "tenant-a", "logical-a", DateTime.UnixEpoch);
        var offering = FalImageLayeringProvisioning.BuildOfferingDocument(
            "tenant-a", "offering-a", "logical-a", "exchange-a", DateTime.UnixEpoch);

        draft.TargetAuthScheme.ShouldBe("Key");
        draft.TransformerType.ShouldBe("fal-image-layered");
        draft.Models.Single().ModelId.ShouldBe("fal-qwen-image-layered");
        logicalModel["PublicId"].AsString.ShouldBe("image-layering");
        logicalModel["AllowedAppCallerCodes"].AsBsonArray.ShouldBeEmpty();
        logicalModel.ToJson().ShouldNotContain("visual-agent");
        offering["LogicalModelId"].AsString.ShouldBe("logical-a");
        offering["TargetId"].AsString.ShouldBe("exchange-a");
        offering["UpstreamModelId"].AsString.ShouldBe("fal-qwen-image-layered");
        offering.Contains("AppCallerCode").ShouldBeFalse();
    }
}
