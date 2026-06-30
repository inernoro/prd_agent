using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// ModelPoolFactory 测试
/// 验证从 ModelGroup + LLMPlatform 构建 IModelPool 的桥接逻辑
/// </summary>
public class ModelPoolFactoryTests
{
    [Fact]
    public void BuildEndpoints_ShouldConvertModelGroupItems()
    {
        var platforms = new List<LLMPlatform>
        {
            new()
            {
                Id = "plat-1",
                Name = "OpenAI",
                PlatformType = "openai",
                ApiUrl = "https://api.openai.com",
                ApiKeyEncrypted = "", // 空密钥
                Enabled = true
            }
        };

        var group = new ModelGroup
        {
            Id = "pool-1",
            Name = "Test Pool",
            Models = new List<ModelGroupItem>
            {
                new()
                {
                    ModelId = "gpt-4o",
                    PlatformId = "plat-1",
                    Priority = 1,
                    MaxTokens = 4096,
                    EnablePromptCache = true
                }
            }
        };

        var endpoints = ModelPoolFactory.BuildEndpoints(group, platforms, "test-secret");

        Assert.Single(endpoints);
        Assert.Equal("plat-1:gpt-4o", endpoints[0].EndpointId);
        Assert.Equal("gpt-4o", endpoints[0].ModelId);
        Assert.Equal("plat-1", endpoints[0].PlatformId);
        Assert.Equal("openai", endpoints[0].PlatformType);
        Assert.Equal("OpenAI", endpoints[0].PlatformName);
        Assert.Equal("https://api.openai.com", endpoints[0].ApiUrl);
        Assert.Equal(1, endpoints[0].Priority);
        Assert.Equal(4096, endpoints[0].MaxTokens);
        Assert.True(endpoints[0].EnablePromptCache);
    }

    [Fact]
    public void BuildEndpoints_ShouldSkipDisabledPlatforms()
    {
        var platforms = new List<LLMPlatform>
        {
            new()
            {
                Id = "plat-1",
                Name = "Disabled",
                PlatformType = "openai",
                ApiUrl = "https://api.disabled.com",
                Enabled = false
            }
        };

        var group = new ModelGroup
        {
            Id = "pool-1",
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model-1", PlatformId = "plat-1" }
            }
        };

        var endpoints = ModelPoolFactory.BuildEndpoints(group, platforms, "test-secret");

        Assert.Empty(endpoints);
    }

    [Fact]
    public void BuildEndpoints_ShouldSkipMissingPlatforms()
    {
        var platforms = new List<LLMPlatform>(); // 无平台

        var group = new ModelGroup
        {
            Id = "pool-1",
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model-1", PlatformId = "nonexistent" }
            }
        };

        var endpoints = ModelPoolFactory.BuildEndpoints(group, platforms, "test-secret");

        Assert.Empty(endpoints);
    }

    [Fact]
    public void Create_ShouldBuildWorkingPool()
    {
        var platforms = new List<LLMPlatform>
        {
            new()
            {
                Id = "plat-1",
                Name = "Test Platform",
                PlatformType = "openai",
                ApiUrl = "https://api.example.com",
                Enabled = true
            }
        };

        var group = new ModelGroup
        {
            Id = "pool-1",
            Name = "Factory Test Pool",
            StrategyType = 2, // 存量字段保留，但调度已化简为只有 FailFast
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "gpt-4o", PlatformId = "plat-1", Priority = 1 },
                new() { ModelId = "gpt-3.5", PlatformId = "plat-1", Priority = 2 }
            }
        };

        var httpDispatcher = new MockPoolHttpDispatcher().WithDefaultSuccess();
        var factory = new ModelPoolFactory(httpDispatcher);
        var pool = factory.Create(group, platforms, "test-secret");

        var config = pool.GetConfig();
        Assert.Equal("pool-1", config.PoolId);
        Assert.Equal("Factory Test Pool", config.PoolName);
        // 工厂一律按 FailFast 构建，忽略 group.StrategyType
        Assert.Equal(PoolStrategyType.FailFast, config.Strategy);
        Assert.Equal(2, config.Endpoints.Count);
    }

    [Fact]
    public void Create_WithDefaultStrategy_ShouldUseFailFast()
    {
        var platforms = new List<LLMPlatform>
        {
            new()
            {
                Id = "plat-1", Name = "Test", PlatformType = "openai",
                ApiUrl = "https://api.example.com", Enabled = true
            }
        };

        var group = new ModelGroup
        {
            Id = "pool-1",
            Name = "Default Pool",
            StrategyType = 0, // Default = FailFast
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model-1", PlatformId = "plat-1" }
            }
        };

        var httpDispatcher = new MockPoolHttpDispatcher();
        var factory = new ModelPoolFactory(httpDispatcher);
        var pool = factory.Create(group, platforms, "test-secret");

        Assert.Equal(PoolStrategyType.FailFast, pool.GetConfig().Strategy);
    }

    [Theory]
    [InlineData(0)] // FailFast
    [InlineData(2)] // 存量 Sequential 值
    [InlineData(5)] // 存量 LeastLatency 值
    public void Create_AnyStoredStrategyType_AlwaysBuildsFailFast(int strategyInt)
    {
        // 调度已化简：无论 group.StrategyType 存的是哪个历史值，工厂一律构建 FailFast 池。
        var platforms = new List<LLMPlatform>
        {
            new()
            {
                Id = "plat-1", Name = "Test", PlatformType = "openai",
                ApiUrl = "https://api.example.com", Enabled = true
            }
        };

        var group = new ModelGroup
        {
            Id = "pool-1",
            Name = "Test Pool",
            StrategyType = strategyInt,
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model-1", PlatformId = "plat-1" }
            }
        };

        var httpDispatcher = new MockPoolHttpDispatcher();
        var factory = new ModelPoolFactory(httpDispatcher);
        var pool = factory.Create(group, platforms, "test-secret");

        Assert.Equal(PoolStrategyType.FailFast, pool.GetConfig().Strategy);
    }
}
