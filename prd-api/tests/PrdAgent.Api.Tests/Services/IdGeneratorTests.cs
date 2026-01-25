using PrdAgent.Infrastructure.Services;
using Moq;
using StackExchange.Redis;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class IdGeneratorTests
{
    private static IdGenerator CreateGenerator(bool useReadableIds)
    {
        // 单元测试必须无外部依赖：这里用内存计数器模拟 Redis INCR（线程安全）
        var sequences = new System.Collections.Concurrent.ConcurrentDictionary<string, long>();

        var db = new Mock<IDatabase>(MockBehavior.Strict);
        db.Setup(x => x.StringIncrementAsync(It.IsAny<RedisKey>(), It.IsAny<long>(), It.IsAny<CommandFlags>()))
            .ReturnsAsync((RedisKey key, long value, CommandFlags _) =>
            {
                var k = key.ToString();
                return sequences.AddOrUpdate(k, value, (_, current) => current + value);
            });

        var redis = new Mock<IConnectionMultiplexer>(MockBehavior.Strict);
        redis.Setup(x => x.GetDatabase(It.IsAny<int>(), It.IsAny<object?>()))
            .Returns(db.Object);

        return new IdGenerator(redis.Object, useReadableIds);
    }

    [Fact]
    public async Task GenerateIdAsync_Development_ReturnsReadableId()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        
        // Act
        var id1 = await generator.GenerateIdAsync("user");
        var id2 = await generator.GenerateIdAsync("user");
        var groupId = await generator.GenerateIdAsync("group");
        
        // Assert
        Assert.Equal("user1", id1);
        Assert.Equal("user2", id2);
        Assert.Equal("group1", groupId);
    }

    [Fact]
    public async Task GenerateIdAsync_Production_ReturnsGuid()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: false);
        
        // Act
        var id = await generator.GenerateIdAsync("user");
        
        // Assert
        Assert.True(Guid.TryParse(id, out _));
        Assert.Equal(32, id.Length); // GUID without dashes
    }

    [Fact]
    public async Task GenerateIdAsync_Platform_StartsFromOne()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        
        // Act
        var id1 = await generator.GenerateIdAsync("platform");
        var id2 = await generator.GenerateIdAsync("platform");
        
        // Assert
        Assert.Equal("platform1", id1);
        Assert.Equal("platform2", id2);
    }

    [Fact]
    public async Task GenerateIdAsync_Model_StartsFromOne()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        
        // Act
        var id1 = await generator.GenerateIdAsync("model");
        var id2 = await generator.GenerateIdAsync("model");
        
        // Assert
        Assert.Equal("model1", id1);
        Assert.Equal("model2", id2);
    }

    [Fact]
    public async Task GenerateIdAsync_Session_StartsFromOne()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        
        // Act
        var id1 = await generator.GenerateIdAsync("session");
        var id2 = await generator.GenerateIdAsync("session");
        
        // Assert
        Assert.Equal("session1", id1);
        Assert.Equal("session2", id2);
    }

    [Fact]
    public async Task GenerateIdAsync_Message_StartsFromOne()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        
        // Act
        var id1 = await generator.GenerateIdAsync("message");
        var id2 = await generator.GenerateIdAsync("message");
        
        // Assert
        Assert.Equal("message1", id1);
        Assert.Equal("message2", id2);
    }

    [Fact]
    public async Task GenerateIdAsync_Robot_StartsFromOne()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        
        // Act
        var id1 = await generator.GenerateIdAsync("robot");
        var id2 = await generator.GenerateIdAsync("robot");
        
        // Assert
        Assert.Equal("robot1", id1);
        Assert.Equal("robot2", id2);
    }

    [Fact]
    public async Task GenerateIdAsync_DifferentCategories_IndependentSequences()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        
        // Act
        var userId1 = await generator.GenerateIdAsync("user");
        var robotId1 = await generator.GenerateIdAsync("robot");
        var groupId1 = await generator.GenerateIdAsync("group");
        var userId2 = await generator.GenerateIdAsync("user");
        var robotId2 = await generator.GenerateIdAsync("robot");
        var groupId2 = await generator.GenerateIdAsync("group");
        
        // Assert
        Assert.Equal("user1", userId1);
        Assert.Equal("robot1", robotId1);
        Assert.Equal("group1", groupId1);
        Assert.Equal("user2", userId2);
        Assert.Equal("robot2", robotId2);
        Assert.Equal("group2", groupId2);
    }

    [Fact]
    public async Task GenerateIdAsync_Concurrent_ThreadSafe()
    {
        // Arrange
        var generator = CreateGenerator(useReadableIds: true);
        var tasks = new List<Task<string>>();
        
        // Act
        for (int i = 0; i < 100; i++)
        {
            tasks.Add(generator.GenerateIdAsync("concurrent"));
        }
        var ids = await Task.WhenAll(tasks);
        
        // Assert
        Assert.Equal(100, ids.Length);
        Assert.Equal(100, ids.Distinct().Count()); // All IDs should be unique
        Assert.All(ids, id => Assert.StartsWith("concurrent", id));
    }
}

