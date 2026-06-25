using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// ModelResolver 单元测试（CI 可运行）
/// 使用 InMemoryModelResolver 验证模型调度逻辑：
/// 1. DedicatedPool - AppCaller 绑定的专属模型池
/// 2. DefaultPool - ModelType 对应的默认模型池
/// 注意：legacy 解析层（IsMain/IsVision/IsImageGen 直连兜底）已移除，
/// 无池可用时直接返回 NotFound。
/// </summary>
public class ModelResolverTests
{
    #region Test Data Helpers

    private static LLMPlatform CreatePlatform(string id, string name, string type = "openai")
    {
        return new LLMPlatform
        {
            Id = id,
            Name = name,
            PlatformType = type,
            ApiUrl = "https://api.example.com",
            Enabled = true
        };
    }

    private static ModelGroup CreateModelGroup(
        string id,
        string name,
        string modelType,
        bool isDefault = false,
        int priority = 0,
        params (string platformId, string modelId, ModelHealthStatus health)[] models)
    {
        return new ModelGroup
        {
            Id = id,
            Name = name,
            Code = name.ToLower().Replace(" ", "-"),
            ModelType = modelType,
            IsDefaultForType = isDefault,
            Priority = priority,
            Models = models.Select((m, i) => new ModelGroupItem
            {
                PlatformId = m.platformId,
                ModelId = m.modelId,
                Priority = i,
                HealthStatus = m.health,
                ConsecutiveSuccesses = m.health == ModelHealthStatus.Healthy ? 10 : 0,
                ConsecutiveFailures = m.health == ModelHealthStatus.Unavailable ? 5 : 0
            }).ToList()
        };
    }

    private static LLMAppCaller CreateAppCaller(
        string appCode,
        string displayName,
        params (string modelType, List<string> groupIds)[] requirements)
    {
        return new LLMAppCaller
        {
            Id = ObjectId.GenerateNewId().ToString(),
            AppCode = appCode,
            DisplayName = displayName,
            ModelRequirements = requirements.Select(r => new AppModelRequirement
            {
                ModelType = r.modelType,
                ModelGroupIds = r.groupIds
            }).ToList()
        };
    }

    #endregion

    #region Level 1: DedicatedPool Tests

    [Fact]
    public async Task DedicatedPool_WhenAppCallerHasBinding_ShouldUseDedicatedPool()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var dedicatedPool = CreateModelGroup(
            "pool-1", "Vision Dedicated Pool", "generation",
            isDefault: false, priority: 0,
            ("plat-1", "gpt-4o-image", ModelHealthStatus.Healthy));

        var appCaller = CreateAppCaller(
            "visual-agent.image::generation", "Visual Agent Image Gen",
            ("generation", new List<string> { "pool-1" }));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test-key")
            .WithModelGroup(dedicatedPool)
            .WithAppCaller(appCaller);

        // Act
        var result = await resolver.ResolveAsync(
            "visual-agent.image::generation", "generation", "any-model");

        // Assert
        Assert.True(result.Success);
        Assert.Equal("DedicatedPool", result.ResolutionType);
        Assert.Equal("gpt-4o-image", result.ActualModel);
        Assert.Equal("plat-1", result.ActualPlatformId);
        Assert.Equal("pool-1", result.ModelGroupId);
        Assert.Equal("Vision Dedicated Pool", result.ModelGroupName);
    }

    [Fact]
    public async Task DedicatedPool_WhenMultiplePools_ShouldUseByPriority()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var highPriorityPool = CreateModelGroup(
            "pool-high", "High Priority Pool", "generation",
            isDefault: false, priority: 1, // 较低优先级数值 = 较高优先级
            ("plat-1", "gpt-4-vision", ModelHealthStatus.Healthy));
        var lowPriorityPool = CreateModelGroup(
            "pool-low", "Low Priority Pool", "generation",
            isDefault: false, priority: 10,
            ("plat-1", "dall-e-3", ModelHealthStatus.Healthy));

        var appCaller = CreateAppCaller(
            "visual-agent.image::generation", "Visual Agent",
            ("generation", new List<string> { "pool-high", "pool-low" }));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(highPriorityPool)
            .WithModelGroup(lowPriorityPool)
            .WithAppCaller(appCaller);

        // Act
        var result = await resolver.ResolveAsync(
            "visual-agent.image::generation", "generation");

        // Assert
        Assert.True(result.Success);
        Assert.Equal("DedicatedPool", result.ResolutionType);
        Assert.Equal("gpt-4-vision", result.ActualModel);
        Assert.Equal("pool-high", result.ModelGroupId);
    }

    #endregion

    #region Level 2: DefaultPool Tests

    [Fact]
    public async Task DefaultPool_WhenNoAppCallerBinding_ShouldUseDefaultPool()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var defaultPool = CreateModelGroup(
            "pool-default", "Default Generation Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "dall-e-3", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(defaultPool);

        // Act - 使用一个没有绑定的 AppCallerCode
        var result = await resolver.ResolveAsync(
            "unknown-app::generation", "generation");

        // Assert
        Assert.True(result.Success);
        Assert.Equal("DefaultPool", result.ResolutionType);
        Assert.Equal("dall-e-3", result.ActualModel);
        Assert.Equal("pool-default", result.ModelGroupId);
    }

    [Fact]
    public async Task DefaultPool_WhenAppCallerHasNoMatchingRequirement_ShouldFallbackToDefault()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var defaultPool = CreateModelGroup(
            "pool-default", "Default Chat Pool", "chat",
            isDefault: true, priority: 0,
            ("plat-1", "gpt-4o", ModelHealthStatus.Healthy));

        // AppCaller 只绑定了 generation 类型，没有 chat
        var appCaller = CreateAppCaller(
            "visual-agent.image::generation", "Visual Agent",
            ("generation", new List<string> { "some-other-pool" }));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(defaultPool)
            .WithAppCaller(appCaller);

        // Act - 请求 chat 类型
        var result = await resolver.ResolveAsync(
            "visual-agent.image::generation", "chat");

        // Assert - 应该回退到默认 chat 池
        Assert.True(result.Success);
        Assert.Equal("DefaultPool", result.ResolutionType);
        Assert.Equal("gpt-4o", result.ActualModel);
    }

    #endregion

    #region Level 3: Legacy 路径已移除 — 无池可用即 NotFound

    // legacy 解析层（IsMain/IsIntent/IsVision/IsImageGen 直连兜底）已删除。
    // 以下用例验证：当没有 dedicated/default 池时，无论哪种 modelType，
    // 都直接返回 NotFound，不再回退到任何直连模型。

    [Theory]
    [InlineData("chat")]
    [InlineData("intent")]
    [InlineData("vision")]
    [InlineData("generation")]
    public async Task NoPool_ForAnyModelType_ShouldReturnNotFound(string modelType)
    {
        // Arrange - 只配置平台，没有任何模型池
        var platform = CreatePlatform("plat-1", "OpenAI");

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test");

        // Act
        var result = await resolver.ResolveAsync($"any-app::{modelType}", modelType);

        // Assert - legacy 路径删除后直接 NotFound
        Assert.False(result.Success);
        Assert.Equal("NotFound", result.ResolutionType);
    }

    #endregion

    #region Health Status Tests

    [Fact]
    public async Task HealthStatus_ShouldPreferHealthyModels()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "Mixed Health Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "degraded-model", ModelHealthStatus.Degraded),
            ("plat-1", "healthy-model", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        // Act
        var result = await resolver.ResolveAsync("any::generation", "generation");

        // Assert - 应该选择健康的模型，而不是优先级更高（索引更小）的降权模型
        Assert.True(result.Success);
        Assert.Equal("healthy-model", result.ActualModel);
    }

    [Fact]
    public async Task HealthStatus_ShouldSkipUnavailableModels()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "Partial Unavailable Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "unavailable-model", ModelHealthStatus.Unavailable),
            ("plat-1", "degraded-model", ModelHealthStatus.Degraded));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        // Act
        var result = await resolver.ResolveAsync("any::generation", "generation");

        // Assert - 应该跳过不可用模型，使用降权模型
        Assert.True(result.Success);
        Assert.Equal("degraded-model", result.ActualModel);
    }

    [Fact]
    public async Task HealthStatus_AllUnavailable_ShouldReturnNotFound()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "All Unavailable Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "unavailable-1", ModelHealthStatus.Unavailable),
            ("plat-1", "unavailable-2", ModelHealthStatus.Unavailable));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        // Act
        var result = await resolver.ResolveAsync("any::generation", "generation");

        // Assert - 所有模型不可用时返回失败
        Assert.False(result.Success);
        Assert.Contains("不可用", result.ErrorMessage);
    }

    [Fact]
    public async Task RecordSuccess_ShouldUpdateHealthStatus()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "Test Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "test-model", ModelHealthStatus.Degraded));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        var result = await resolver.ResolveAsync("any::generation", "generation");

        // Act
        await resolver.RecordSuccessAsync(result);

        // Assert - 再次解析应该得到 Healthy 状态
        var result2 = await resolver.ResolveAsync("any::generation", "generation");
        Assert.Equal("Healthy", result2.HealthStatus);
    }

    [Fact]
    public async Task RecordFailure_ShouldDegradeHealthStatus()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "Test Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "test-model", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        var result = await resolver.ResolveAsync("any::generation", "generation");

        // Act - 连续失败 3 次
        await resolver.RecordFailureAsync(result);
        await resolver.RecordFailureAsync(result);
        await resolver.RecordFailureAsync(result);

        // Assert - 状态应该降级
        var result2 = await resolver.ResolveAsync("any::generation", "generation");
        Assert.Equal("Degraded", result2.HealthStatus);
    }

    #endregion

    #region Not Found Tests

    [Fact]
    public async Task NotFound_WhenNoConfigAtAll_ShouldReturnNotFound()
    {
        // Arrange - 空的 resolver
        var resolver = new InMemoryModelResolver();

        // Act
        var result = await resolver.ResolveAsync("any::generation", "generation");

        // Assert
        Assert.False(result.Success);
        Assert.Equal("NotFound", result.ResolutionType);
        Assert.Contains("未找到可用模型", result.ErrorMessage);
    }

    [Fact]
    public async Task NotFound_WhenPlatformDisabled_ShouldReturnNotFound()
    {
        // Arrange
        var disabledPlatform = new LLMPlatform
        {
            Id = "plat-1",
            Name = "Disabled Platform",
            Enabled = false // 平台禁用
        };
        var pool = CreateModelGroup(
            "pool-1", "Test Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "test-model", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(disabledPlatform)
            .WithModelGroup(pool);

        // Act
        var result = await resolver.ResolveAsync("any::generation", "generation");

        // Assert - 平台禁用时应该找不到模型
        Assert.False(result.Success);
    }

    #endregion

    #region ExpectedModel Tests

    [Fact]
    public async Task ExpectedModel_ShouldBeRecordedInResult()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "Test Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "actual-model", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        // Act
        var result = await resolver.ResolveAsync(
            "any::generation", "generation", "expected-model");

        // Assert
        Assert.True(result.Success);
        Assert.Equal("expected-model", result.ExpectedModel);
        Assert.Equal("actual-model", result.ActualModel);
        Assert.False(result.MatchedExpectation); // 期望与实际不匹配
    }

    [Fact]
    public async Task ExpectedModel_WhenMatched_ShouldSetMatchedExpectation()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "Test Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "gpt-4o", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        // Act
        var result = await resolver.ResolveAsync(
            "any::generation", "generation", "gpt-4o");

        // Assert
        Assert.True(result.Success);
        Assert.Equal("gpt-4o", result.ExpectedModel);
        Assert.Equal("gpt-4o", result.ActualModel);
        Assert.True(result.MatchedExpectation); // 期望与实际匹配
    }

    #endregion

    #region GetAvailablePools Tests

    [Fact]
    public async Task GetAvailablePools_ForDedicatedApp_ShouldReturnOnlyDedicatedPools()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var dedicatedPool = CreateModelGroup(
            "pool-dedicated", "Dedicated Pool", "generation",
            isDefault: false, priority: 0,
            ("plat-1", "dedicated-model", ModelHealthStatus.Healthy));
        var defaultPool = CreateModelGroup(
            "pool-default", "Default Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "default-model", ModelHealthStatus.Healthy));

        var appCaller = CreateAppCaller(
            "visual-agent.image::generation", "Visual Agent",
            ("generation", new List<string> { "pool-dedicated" }));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform)
            .WithModelGroup(dedicatedPool)
            .WithModelGroup(defaultPool)
            .WithAppCaller(appCaller);

        // Act
        var pools = await resolver.GetAvailablePoolsAsync(
            "visual-agent.image::generation", "generation");

        // Assert - 有专属池时不返回默认池
        Assert.Single(pools);
        Assert.Equal("pool-dedicated", pools[0].Id);
        Assert.True(pools[0].IsDedicated);
        Assert.False(pools[0].IsDefault);
    }

    [Fact]
    public async Task GetAvailablePools_ForUnknownApp_ShouldReturnDefaultPools()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var defaultPool = CreateModelGroup(
            "pool-default", "Default Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "default-model", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform)
            .WithModelGroup(defaultPool);

        // Act
        var pools = await resolver.GetAvailablePoolsAsync(
            "unknown-app::generation", "generation");

        // Assert
        Assert.Single(pools);
        Assert.Equal("pool-default", pools[0].Id);
        Assert.False(pools[0].IsDedicated);
        Assert.True(pools[0].IsDefault);
    }

    #endregion

    #region ToGatewayResolution Tests

    [Fact]
    public async Task ToGatewayResolution_ShouldCorrectlyConvert()
    {
        // Arrange
        var platform = CreatePlatform("plat-1", "OpenAI");
        var pool = CreateModelGroup(
            "pool-1", "Test Pool", "generation",
            isDefault: true, priority: 0,
            ("plat-1", "gpt-4o", ModelHealthStatus.Healthy));

        var resolver = new InMemoryModelResolver()
            .WithPlatform(platform, "sk-test")
            .WithModelGroup(pool);

        // Act
        var result = await resolver.ResolveAsync("any::generation", "generation");
        var gatewayResolution = result.ToGatewayResolution();

        // Assert
        Assert.Equal(result.ResolutionType, gatewayResolution.ResolutionType);
        Assert.Equal(result.ExpectedModel, gatewayResolution.ExpectedModel);
        Assert.Equal(result.ActualModel, gatewayResolution.ActualModel);
        Assert.Equal(result.ActualPlatformId, gatewayResolution.ActualPlatformId);
        Assert.Equal(result.ActualPlatformName, gatewayResolution.ActualPlatformName);
        Assert.Equal(result.ModelGroupId, gatewayResolution.ModelGroupId);
        Assert.Equal(result.ModelGroupName, gatewayResolution.ModelGroupName);
    }

    #endregion
}

// 辅助类：简化的 ObjectId 生成
internal static class ObjectId
{
    private static int _counter = 0;
    public static string GenerateNewId() => $"oid-{Interlocked.Increment(ref _counter):D8}";
}
