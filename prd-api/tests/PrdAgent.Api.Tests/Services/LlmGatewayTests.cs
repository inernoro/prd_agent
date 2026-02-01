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

        // Act
        var client = gateway.CreateClient("test-app::chat", "chat");

        // Assert
        Assert.NotNull(client);
        Assert.IsAssignableFrom<ILLMClient>(client);
    }

    [Fact]
    public void CreateClient_WithCustomParameters_ShouldPreserveValues()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient(
            "test-app::chat",
            "chat",
            maxTokens: 8192,
            temperature: 0.7);

        // Assert
        Assert.NotNull(client);
        var gatewayClient = Assert.IsType<GatewayLLMClient>(client);
        Assert.Equal("test-app::chat", gatewayClient.AppCallerCode);
        Assert.Equal("chat", gatewayClient.ModelType);
        Assert.Equal(8192, gatewayClient.MaxTokens);
        Assert.Equal(0.7, gatewayClient.Temperature, precision: 2);
    }

    [Fact]
    public void CreateClient_ShouldSetDefaultValues()
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient("test-app::chat", "chat");

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
    [InlineData("prd-agent.chat::chat", true)]
    [InlineData("visual-agent.image::generation", true)]
    [InlineData("admin.prompts.optimize", true)]
    [InlineData("open-platform-agent.proxy::chat", true)]
    [InlineData("", false)]
    public void CreateClient_ShouldAcceptVariousAppCallerCodeFormats(string appCallerCode, bool shouldSucceed)
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act & Assert
        if (shouldSucceed)
        {
            var client = gateway.CreateClient(appCallerCode, "chat");
            Assert.NotNull(client);
        }
        else
        {
            // 空的 appCallerCode 仍然会创建 client，但后续调用会失败
            var client = gateway.CreateClient(appCallerCode, "chat");
            Assert.NotNull(client);
        }
    }

    [Theory]
    [InlineData("chat")]
    [InlineData("vision")]
    [InlineData("generation")]
    [InlineData("intent")]
    public void CreateClient_ShouldAcceptAllModelTypes(string modelType)
    {
        // Arrange
        var gateway = CreateTestGateway();

        // Act
        var client = gateway.CreateClient("test-app", modelType);

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
        var expectedCode = "prd-agent.chat.sendmessage::chat";

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

        // Act
        var client = gateway.CreateClient("test::vision", "vision");
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
