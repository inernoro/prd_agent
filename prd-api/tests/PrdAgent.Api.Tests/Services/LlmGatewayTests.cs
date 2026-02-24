using PrdAgent.Core.Interfaces;
using CoreGateway = PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// LLM Gateway 单元测试
/// 验证 Gateway 模式的核心功能：
/// 1. CreateClient 方法返回有效的 ILLMClient
/// 2. GatewayLLMClient 正确委托到 Gateway
/// 3. 三级模型调度逻辑正确触发
/// </summary>
public class LlmGatewayTests
{
    #region CreateClient Tests

    [Fact]
    public void CreateClient_ShouldReturnValidILLMClient()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act - Use registered appCallerCode from AppCallerRegistry
        // Act
        var client = gateway.CreateClient(AppCallerRegistry.Admin.Lab.Chat, "chat");

        // Assert
        Assert.NotNull(client);
        Assert.IsAssignableFrom<ILLMClient>(client);
    }

    [Fact]
    public void CreateClient_WithCustomParameters_ShouldPreserveValues()
    {
        // Arrange
        var gateway = CreateTestGateway();
        var appCallerCode = AppCallerRegistry.Admin.Lab.Chat;

        // Act
        var client = gateway.CreateClient(
            appCallerCode,
            AppCallerRegistry.Admin.Lab.Chat,
            "chat",
            maxTokens: 8192,
            temperature: 0.7);

        // Assert
        Assert.NotNull(client);
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);
        Assert.Equal(appCallerCode, gatewayClient.AppCallerCode);
        Assert.Equal(AppCallerRegistry.Admin.Lab.Chat, gatewayClient.AppCallerCode);
        Assert.Equal("chat", gatewayClient.ModelType);
        Assert.Equal(8192, gatewayClient.MaxTokens);
        Assert.Equal(0.7, gatewayClient.Temperature, precision: 2);
    }

    [Fact]
    public void CreateClient_ShouldSetDefaultValues()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act - Use registered appCallerCode from AppCallerRegistry
        // Act
        var client = gateway.CreateClient(AppCallerRegistry.Admin.Lab.Chat, "chat");

        // Assert
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);
        Assert.Equal(4096, gatewayClient.MaxTokens);
        Assert.Equal(0.2, gatewayClient.Temperature, precision: 2);
        Assert.True(gatewayClient.EnablePromptCache);
    }

    #endregion

    #region Interface Registration Tests

    [Fact]
    public void LlmGateway_ShouldImplementBothInterfaces()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Assert
        Assert.IsAssignableFrom<CoreGateway.ILlmGateway>(gateway);
        Assert.IsAssignableFrom<ILlmGateway>(gateway);
    }

    [Fact]
    public void LlmGateway_BothInterfaces_ShouldBeSameInstance()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var coreGateway = (CoreGateway.ILlmGateway)gateway;
        var infraGateway = (ILlmGateway)gateway;

        // Assert - 应该是同一个实例
        Assert.Same(coreGateway, infraGateway);
    }

    #endregion

    #region AppCallerCode Format Tests

    [Theory]
    // Use actual registered appCallerCodes from AppCallerRegistry with matching modelType
    [InlineData("prd-agent-desktop.chat.sendmessage::chat", "chat", true)]     // Desktop Chat
    [InlineData("visual-agent.image.text2img::generation", "generation", true)] // VisualAgent Image (generation modelType)
    [InlineData("prd-agent-web.prompts.optimize::chat", "chat", true)]         // Admin Prompts
    [InlineData("open-platform-agent.proxy::chat", "chat", true)]              // OpenPlatform Proxy
    [InlineData("", "chat", false)]
    public void CreateClient_ShouldAcceptVariousAppCallerCodeFormats(string appCallerCode, string modelType, bool shouldSucceed)
    [InlineData("prd-agent-desktop.chat.sendmessage::chat", true)]
    [InlineData("visual-agent.image.text2img::generation", true)]
    [InlineData("prd-agent-web.prompts.optimize::chat", true)]
    [InlineData("open-platform-agent.proxy::chat", true)]
    [InlineData("", false)]
    public void CreateClient_ShouldAcceptVariousAppCallerCodeFormats(string appCallerCode, bool shouldSucceed)
    {
        // Arrange
        var gateway = CreateTestGateway();
        // 从 appCallerCode 中提取 modelType（:: 后的部分）
        var modelType = "chat";
        if (!string.IsNullOrEmpty(appCallerCode) && appCallerCode.Contains("::"))
        {
            modelType = appCallerCode.Split("::").Last();
        }

        // Act & Assert
        if (shouldSucceed)
        {
            var client = gateway.CreateClient(appCallerCode, modelType);
            Assert.NotNull(client);
        }
        else
        {
            // Empty appCallerCode should throw InvalidOperationException
            Assert.Throws<InvalidOperationException>(() => gateway.CreateClient(appCallerCode, modelType));
        }
    }

    [Theory]
    [InlineData("chat", "prd-agent-web.lab::chat")]
    [InlineData("vision", "prd-agent-web.lab::vision")]
    [InlineData("generation", "prd-agent-web.lab::generation")]
    [InlineData("intent", "prd-agent-desktop.chat.sendmessage::intent")]
    [InlineData("intent", "visual-agent.image-gen.plan::intent")]
    public void CreateClient_ShouldAcceptAllModelTypes(string modelType, string appCallerCode)
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act - Use registered appCallerCode that matches the model type
        // Act
        var client = gateway.CreateClient(appCallerCode, modelType);

        // Assert
        Assert.NotNull(client);
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);
        Assert.Equal(modelType, gatewayClient.ModelType);
    }

    #endregion

    #region GatewayLLMClient Properties Tests

    [Fact]
    public void GatewayLLMClient_ShouldExposeAppCallerCode()
    {
        // Arrange
        var gateway = CreateTestGateway();
        // Use actual registered appCallerCode from AppCallerRegistry
        var expectedCode = AppCallerRegistry.Desktop.Chat.SendMessageChat;

        // Act
        var client = gateway.CreateClient(expectedCode, "chat");
        var gatewayClient = (GatewayLLMClient)client;

        // Assert
        Assert.Equal(expectedCode, gatewayClient.AppCallerCode);
    }

    [Fact]
    public void GatewayLLMClient_ShouldExposeModelType()
    {
        // Arrange
        var gateway = CreateTestGateway();
        // Use actual registered appCallerCode from AppCallerRegistry
        var appCallerCode = AppCallerRegistry.Admin.Lab.Vision;

        // Act
        var client = gateway.CreateClient(appCallerCode, "vision");
        var client = gateway.CreateClient(AppCallerRegistry.VisualAgent.Image.Vision, "vision");
        var gatewayClient = (GatewayLLMClient)client;

        // Assert
        Assert.Equal("vision", gatewayClient.ModelType);
    }

    #endregion

    #region Model Type Constants Tests

    [Fact]
    public void ModelTypes_ShouldDefineAllStandardTypes()
    {
        // Assert
        Assert.Equal("chat", ModelTypes.Chat);
        Assert.Equal("vision", ModelTypes.Vision);
        Assert.Equal("generation", ModelTypes.ImageGen);
        Assert.Equal("intent", ModelTypes.Intent);
    }

    #endregion

    #region Thinking Isolation Tests

    /// <summary>
    /// 验证 IncludeThinking 默认为 false（思考内容默认不透传）
    /// 验证点 1/8：Gateway 默认行为
    /// </summary>
    [Fact]
    public void CreateClient_DefaultIncludeThinking_ShouldBeFalse()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(AppCallerRegistry.Admin.Lab.Chat, "chat");
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);

        // Assert - 默认不包含思考
        Assert.False(gatewayClient.IncludeThinking);
    }

    /// <summary>
    /// 验证 CreateClient 传递 includeThinking=true 时正确保留
    /// 验证点 2/8：Chat 模型显式启用思考
    /// </summary>
    [Fact]
    public void CreateClient_WithIncludeThinkingTrue_ShouldPreserveValue()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(
            AppCallerRegistry.Desktop.Chat.SendMessageChat,
            "chat",
            includeThinking: true);
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);

        // Assert - 显式启用思考
        Assert.True(gatewayClient.IncludeThinking);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：IncludeThinking=false → 始终不透传
    /// 验证点 3/8：默认行为（所有 ModelType）
    /// </summary>
    [Theory]
    [InlineData("chat")]
    [InlineData("intent")]
    [InlineData("vision")]
    [InlineData("generation")]
    [InlineData("embedding")]
    [InlineData("rerank")]
    public void IsThinkingEffective_WhenIncludeThinkingFalse_ShouldAlwaysReturnFalse(string modelType)
    {
        // Act
        var result = LlmGateway.IsThinkingEffective(includeThinking: false, modelType);

        // Assert - 无论什么 ModelType，IncludeThinking=false 时始终不透传
        Assert.False(result);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：Intent 模型强制禁止思考
    /// 验证点 4/8：Intent 强制隔离（核心安全保障）
    /// </summary>
    [Theory]
    [InlineData("intent")]
    [InlineData("Intent")]
    [InlineData("INTENT")]
    public void IsThinkingEffective_WhenIntentModelType_ShouldAlwaysReturnFalse_RegardlessOfIncludeThinking(string modelType)
    {
        // Act - 即使 IncludeThinking=true，Intent 也强制禁止
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);

        // Assert
        Assert.False(result);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：Chat 模型 + IncludeThinking=true → 允许透传
    /// 验证点 5/8：推理场景正常启用思考
    /// </summary>
    [Theory]
    [InlineData("chat")]
    [InlineData("Chat")]
    public void IsThinkingEffective_WhenChatModelWithIncludeThinking_ShouldReturnTrue(string modelType)
    {
        // Act
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);

        // Assert - Chat 模型显式请求思考时允许透传
        Assert.True(result);
    }

    /// <summary>
    /// 验证 IsThinkingEffective：Vision/Generation 等模型 + IncludeThinking=true → 允许透传
    /// 验证点 6/8：非 Intent 模型类型在显式请求时均允许思考
    /// </summary>
    [Theory]
    [InlineData("vision")]
    [InlineData("generation")]
    [InlineData("embedding")]
    [InlineData("code")]
    [InlineData("long-context")]
    public void IsThinkingEffective_WhenNonIntentModelWithIncludeThinking_ShouldReturnTrue(string modelType)
    {
        // Act
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);

        // Assert - 所有非 Intent 模型在 IncludeThinking=true 时均允许
        Assert.True(result);
    }

    /// <summary>
    /// 验证所有 Intent 类型的 AppCallerCode 注册都使用 Intent ModelType
    /// 验证点 7/8：确保 AppCallerRegistry 中所有 intent 调用者都被 Gateway 保护
    /// </summary>
    [Theory]
    [InlineData(AppCallerRegistry.Desktop.Chat.SendMessageIntent)]
    [InlineData(AppCallerRegistry.Desktop.GroupName.SuggestIntent)]
    [InlineData(AppCallerRegistry.VisualAgent.Workspace.Title)]
    [InlineData(AppCallerRegistry.VisualAgent.ImageGen.Plan)]
    [InlineData(AppCallerRegistry.AiToolbox.Orchestration.Intent)]
    public void AllIntentAppCallerCodes_ShouldEndWithIntentSuffix(string appCallerCode)
    {
        // Assert - 所有 intent AppCallerCode 以 ::intent 结尾
        Assert.EndsWith("::intent", appCallerCode);

        // 验证 Gateway 会强制禁止这些调用者的思考输出
        var modelType = appCallerCode.Split("::").Last();
        var result = LlmGateway.IsThinkingEffective(includeThinking: true, modelType);
        Assert.False(result);
    }

    /// <summary>
    /// 验证唯一启用思考的 AppCallerCode 是 Desktop Chat
    /// 验证点 8/8：只有聊天推理场景启用思考，其他场景默认关闭
    /// </summary>
    [Fact]
    public void OnlyChatServiceShouldEnableThinking()
    {
        // 目前唯一使用 includeThinking=true 的是 ChatService
        // AppCallerCode: prd-agent-desktop.chat.sendmessage::chat
        var appCallerCode = AppCallerRegistry.Desktop.Chat.SendMessageChat;

        // 验证该 AppCallerCode 的 ModelType 是 chat（不是 intent）
        Assert.EndsWith("::chat", appCallerCode);

        // 验证 chat ModelType + includeThinking=true 时思考允许透传
        Assert.True(LlmGateway.IsThinkingEffective(includeThinking: true, "chat"));

        // 验证 intent 即使被误配也会被拦截
        Assert.False(LlmGateway.IsThinkingEffective(includeThinking: true, "intent"));
    }

    #endregion

    #region OpenAIGatewayAdapter.BuildEndpoint Tests

    [Theory]
    // 标准 OpenAI 格式（无版本后缀）
    [InlineData("https://api.openai.com", "chat", "https://api.openai.com/v1/chat/completions")]
    [InlineData("https://api.openai.com/", "chat", "https://api.openai.com/v1/chat/completions")]
    [InlineData("https://api.deepseek.com", "chat", "https://api.deepseek.com/v1/chat/completions")]
    [InlineData("https://api.openai.com", "generation", "https://api.openai.com/v1/images/generations")]
    [InlineData("https://api.openai.com", "embedding", "https://api.openai.com/v1/embeddings")]
    [InlineData("https://api.openai.com", "intent", "https://api.openai.com/v1/chat/completions")]
    // 火山引擎格式（/api/v3 后缀）
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "chat", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/", "chat", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "intent", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "generation", "https://ark.cn-beijing.volces.com/api/v3/images/generations")]
    // /v1 后缀
    [InlineData("https://api.example.com/v1", "chat", "https://api.example.com/v1/chat/completions")]
    [InlineData("https://api.example.com/v1/", "chat", "https://api.example.com/v1/chat/completions")]
    // /v2 后缀
    [InlineData("https://api.example.com/v2", "chat", "https://api.example.com/v2/chat/completions")]
    [InlineData("https://api.example.com/api/v2", "chat", "https://api.example.com/api/v2/chat/completions")]
    public void BuildEndpoint_ShouldHandleVersionSuffixCorrectly(string apiBase, string modelType, string expected)
    {
        // Arrange
        var adapter = new OpenAIGatewayAdapter();

        // Act
        var result = adapter.BuildEndpoint(apiBase, modelType);

        // Assert
        Assert.Equal(expected, result);
    }

    [Fact]
    public void BuildEndpoint_Volces_ShouldNotDuplicateVersionPath()
    {
        // 回归测试：确保火山引擎不会产生 /api/v3/v1/chat/completions
        var adapter = new OpenAIGatewayAdapter();
        var baseUrl = "https://ark.cn-beijing.volces.com/api/v3";

        var endpoint = adapter.BuildEndpoint(baseUrl, "chat");

        Assert.Equal("https://ark.cn-beijing.volces.com/api/v3/chat/completions", endpoint);
        Assert.DoesNotContain("/v1/", endpoint);
    }

    [Fact]
    public void BuildEndpoint_OpenAI_ShouldAddV1Prefix()
    {
        // 标准 OpenAI 应该添加 /v1 前缀
        var adapter = new OpenAIGatewayAdapter();
        var baseUrl = "https://api.openai.com";

        var endpoint = adapter.BuildEndpoint(baseUrl, "chat");

        Assert.Equal("https://api.openai.com/v1/chat/completions", endpoint);
        Assert.Contains("/v1/", endpoint);
    }

    #endregion

    #region Helper Methods

    private static LlmGateway CreateTestGateway()
    {
        // 创建一个用于测试的 Gateway 实例
        // 使用 InMemoryModelResolver 避免外部依赖
        var resolver = new InMemoryModelResolver()
            .WithPlatform(new LLMPlatform
            {
                Id = "test-platform",
                Name = "Test Platform",
                PlatformType = "openai",
                ApiUrl = "https://api.example.com",
                Enabled = true
            }, "sk-test-key")
            .WithModelGroup(new ModelGroup
            {
                Id = "test-pool",
                Name = "Test Pool",
                Code = "test-pool",
                ModelType = "chat",
                IsDefaultForType = true,
                Priority = 0,
                Models = new List<ModelGroupItem>
                {
                    new()
                    {
                        PlatformId = "test-platform",
                        ModelId = "gpt-4o",
                        Priority = 0,
                        HealthStatus = ModelHealthStatus.Healthy
                    }
                }
            });

        var httpClientFactory = new TestHttpClientFactory();
        var logger = new TestLogger<LlmGateway>();

        return new LlmGateway(resolver, httpClientFactory, logger);
    }

    #endregion
}

#region Test Helpers

internal class TestHttpClientFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new();
}

internal class TestLogger<T> : Microsoft.Extensions.Logging.ILogger<T>
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => false;
    public void Log<TState>(
        Microsoft.Extensions.Logging.LogLevel logLevel,
        Microsoft.Extensions.Logging.EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    { }
}

#endregion
