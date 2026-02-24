using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// 测试数据构建辅助
/// </summary>
public static class TestDataHelper
{
    public static PoolEndpoint CreateEndpoint(
        string modelId,
        string platformId = "plat-1",
        int priority = 1,
        string platformType = "openai",
        string? platformName = null)
    {
        return new PoolEndpoint
        {
            EndpointId = $"{platformId}:{modelId}",
            ModelId = modelId,
            PlatformId = platformId,
            PlatformType = platformType,
            PlatformName = platformName ?? $"Platform-{platformId}",
            ApiUrl = "https://api.example.com",
            ApiKey = "sk-test",
            Priority = priority
        };
    }

    public static List<PoolEndpoint> CreateEndpoints(params (string modelId, int priority)[] models)
    {
        return models.Select((m, i) => CreateEndpoint(m.modelId, $"plat-{i + 1}", m.priority))
            .ToList();
    }

    public static PoolRequest CreateRequest(string modelType = "chat")
    {
        return new PoolRequest
        {
            ModelType = modelType,
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = "test"
                    }
                }
            },
            TimeoutSeconds = 30,
            RequestId = "test-req-1",
            UserId = "test-user-1"
        };
    }
}
