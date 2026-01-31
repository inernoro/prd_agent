using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 模型池调度逻辑测试
/// </summary>
public class ModelPoolSchedulingTests
{
    #region Code 与优先级测试

    [Fact]
    public void ModelGroup_Code_AllowsDuplicates()
    {
        // Arrange: 创建多个相同 Code 的模型池
        var pool1 = new ModelGroup { Id = "1", Name = "Pool1", Code = "deepseek", Priority = 10 };
        var pool2 = new ModelGroup { Id = "2", Name = "Pool2", Code = "deepseek", Priority = 20 };
        var pool3 = new ModelGroup { Id = "3", Name = "Pool3", Code = "deepseek", Priority = 30 };

        // Assert: Code 可以重复
        Assert.Equal(pool1.Code, pool2.Code);
        Assert.Equal(pool2.Code, pool3.Code);
    }

    [Fact]
    public void ModelGroup_SelectByPriority_ReturnsLowestPriorityFirst()
    {
        // Arrange: 模拟多个相同 Code 的模型池
        var pools = new List<ModelGroup>
        {
            new() { Id = "1", Name = "Low Priority", Code = "gpt", Priority = 100 },
            new() { Id = "2", Name = "High Priority", Code = "gpt", Priority = 10 },
            new() { Id = "3", Name = "Medium Priority", Code = "gpt", Priority = 50 },
        };

        // Act: 按优先级排序（数字越小越优先）
        var sortedPools = pools.OrderBy(p => p.Priority).ToList();

        // Assert: 优先级最小的在前
        Assert.Equal("2", sortedPools[0].Id);  // Priority = 10
        Assert.Equal("3", sortedPools[1].Id);  // Priority = 50
        Assert.Equal("1", sortedPools[2].Id);  // Priority = 100
    }

    [Fact]
    public void ModelGroup_DefaultPriority_Is50()
    {
        // Arrange & Act
        var pool = new ModelGroup();

        // Assert
        Assert.Equal(50, pool.Priority);
    }

    #endregion

    #region ModelGroupIds 数组测试

    [Fact]
    public void AppModelRequirement_ModelGroupIds_DefaultsToEmptyList()
    {
        // Arrange & Act
        var requirement = new AppModelRequirement();

        // Assert
        Assert.NotNull(requirement.ModelGroupIds);
        Assert.Empty(requirement.ModelGroupIds);
    }

    [Fact]
    public void AppModelRequirement_SupportsMultipleModelGroupIds()
    {
        // Arrange
        var requirement = new AppModelRequirement
        {
            ModelType = "chat",
            ModelGroupIds = new List<string> { "pool1", "pool2", "pool3" }
        };

        // Assert
        Assert.Equal(3, requirement.ModelGroupIds.Count);
        Assert.Contains("pool1", requirement.ModelGroupIds);
        Assert.Contains("pool2", requirement.ModelGroupIds);
        Assert.Contains("pool3", requirement.ModelGroupIds);
    }

    [Fact]
    public void AppModelRequirement_LegacyModelGroupId_MigratedToModelGroupIds()
    {
        // Arrange: 使用旧的 ModelGroupId 字段设置值
        var requirement = new AppModelRequirement
        {
            ModelType = "chat"
        };

        // Act: 通过旧字段设置值
#pragma warning disable CS0618 // 使用已废弃的成员
        requirement.ModelGroupId = "legacy-pool";
#pragma warning restore CS0618

        // Assert: 值应该被迁移到 ModelGroupIds
        Assert.Contains("legacy-pool", requirement.ModelGroupIds);
        Assert.Single(requirement.ModelGroupIds);
    }

    [Fact]
    public void AppModelRequirement_ModelGroupId_ReturnsFirstFromModelGroupIds()
    {
        // Arrange
        var requirement = new AppModelRequirement
        {
            ModelType = "chat",
            ModelGroupIds = new List<string> { "first-pool", "second-pool" }
        };

        // Act & Assert
#pragma warning disable CS0618
        Assert.Equal("first-pool", requirement.ModelGroupId);
#pragma warning restore CS0618
    }

    [Fact]
    public void AppModelRequirement_ModelGroupId_ReturnsNullWhenEmpty()
    {
        // Arrange
        var requirement = new AppModelRequirement
        {
            ModelType = "chat",
            ModelGroupIds = new List<string>()
        };

        // Act & Assert
#pragma warning disable CS0618
        Assert.Null(requirement.ModelGroupId);
#pragma warning restore CS0618
    }

    #endregion

    #region 模型池内模型选择测试

    [Fact]
    public void ModelGroup_SelectBestModel_PrefersHealthyModels()
    {
        // Arrange
        var group = new ModelGroup
        {
            Id = "test-group",
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model1", PlatformId = "p1", Priority = 1, HealthStatus = ModelHealthStatus.Unavailable },
                new() { ModelId = "model2", PlatformId = "p1", Priority = 2, HealthStatus = ModelHealthStatus.Healthy },
                new() { ModelId = "model3", PlatformId = "p1", Priority = 3, HealthStatus = ModelHealthStatus.Degraded },
            }
        };

        // Act: 模拟选择最佳模型的逻辑
        var bestModel = SelectBestModel(group);

        // Assert: 应该选择健康的模型
        Assert.NotNull(bestModel);
        Assert.Equal("model2", bestModel.ModelId);
    }

    [Fact]
    public void ModelGroup_SelectBestModel_FallbackToDegraded()
    {
        // Arrange
        var group = new ModelGroup
        {
            Id = "test-group",
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model1", PlatformId = "p1", Priority = 1, HealthStatus = ModelHealthStatus.Unavailable },
                new() { ModelId = "model2", PlatformId = "p1", Priority = 2, HealthStatus = ModelHealthStatus.Degraded },
                new() { ModelId = "model3", PlatformId = "p1", Priority = 3, HealthStatus = ModelHealthStatus.Unavailable },
            }
        };

        // Act
        var bestModel = SelectBestModel(group);

        // Assert: 无健康模型时，选择降权模型
        Assert.NotNull(bestModel);
        Assert.Equal("model2", bestModel.ModelId);
    }

    [Fact]
    public void ModelGroup_SelectBestModel_ReturnsNullWhenAllUnavailable()
    {
        // Arrange
        var group = new ModelGroup
        {
            Id = "test-group",
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model1", PlatformId = "p1", Priority = 1, HealthStatus = ModelHealthStatus.Unavailable },
                new() { ModelId = "model2", PlatformId = "p1", Priority = 2, HealthStatus = ModelHealthStatus.Unavailable },
            }
        };

        // Act
        var bestModel = SelectBestModel(group);

        // Assert: 所有模型都不可用时返回 null
        Assert.Null(bestModel);
    }

    [Fact]
    public void ModelGroup_SelectBestModel_FollowsPriorityWithinSameHealth()
    {
        // Arrange
        var group = new ModelGroup
        {
            Id = "test-group",
            Models = new List<ModelGroupItem>
            {
                new() { ModelId = "model1", PlatformId = "p1", Priority = 30, HealthStatus = ModelHealthStatus.Healthy },
                new() { ModelId = "model2", PlatformId = "p1", Priority = 10, HealthStatus = ModelHealthStatus.Healthy },
                new() { ModelId = "model3", PlatformId = "p1", Priority = 20, HealthStatus = ModelHealthStatus.Healthy },
            }
        };

        // Act
        var bestModel = SelectBestModel(group);

        // Assert: 在同等健康状态下，选择优先级最高（数字最小）的
        Assert.NotNull(bestModel);
        Assert.Equal("model2", bestModel.ModelId);  // Priority = 10
    }

    /// <summary>
    /// 模拟 LlmGateway 中 ModelResolver 的模型选择逻辑
    /// </summary>
    private static ModelGroupItem? SelectBestModel(ModelGroup group)
    {
        // 按优先级和健康状态选择最佳模型
        var healthyModels = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Healthy)
            .OrderBy(m => m.Priority)
            .ToList();

        if (healthyModels.Count != 0)
            return healthyModels.First();

        var degradedModels = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Degraded)
            .OrderBy(m => m.Priority)
            .ToList();

        if (degradedModels.Count != 0)
            return degradedModels.First();

        return null;
    }

    #endregion

    #region 多模型池随机选择测试

    [Fact]
    public void MultiPoolSelection_RandomDistribution()
    {
        // Arrange
        var pools = new List<ModelGroup>
        {
            new() { Id = "pool1", Name = "Pool 1" },
            new() { Id = "pool2", Name = "Pool 2" },
            new() { Id = "pool3", Name = "Pool 3" },
        };

        var selectionCounts = new Dictionary<string, int>
        {
            { "pool1", 0 },
            { "pool2", 0 },
            { "pool3", 0 },
        };

        // Act: 模拟多次随机选择
        var random = new Random(42); // 固定种子以确保可重复性
        for (int i = 0; i < 1000; i++)
        {
            var selected = pools[random.Next(pools.Count)];
            selectionCounts[selected.Id]++;
        }

        // Assert: 每个池都应该被选中一定次数（统计学上约 33% 每个）
        Assert.True(selectionCounts["pool1"] > 250, $"Pool1 selected {selectionCounts["pool1"]} times, expected > 250");
        Assert.True(selectionCounts["pool2"] > 250, $"Pool2 selected {selectionCounts["pool2"]} times, expected > 250");
        Assert.True(selectionCounts["pool3"] > 250, $"Pool3 selected {selectionCounts["pool3"]} times, expected > 250");
    }

    #endregion
}
