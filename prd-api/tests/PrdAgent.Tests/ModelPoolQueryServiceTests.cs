using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class ModelPoolQueryServiceTests
{
    [Fact]
    public async Task GetModelPoolsAsync_UsesRuntimeCatalogAndPreservesPublicId()
    {
        var resolver = new StubResolver
        {
            Pools =
            [
                new AvailableModelPool
                {
                    Id = "logical-1",
                    Name = "deepseek-ai/DeepSeek-V4-Flash",
                    Code = "deepseek-ai-deepseek-v4-flash",
                    Priority = 7,
                    ResolutionType = "LogicalModel",
                    IsDedicated = true,
                    IsDefault = true,
                    Capabilities = ["chat"],
                    Models =
                    [
                        new PoolModelInfo
                        {
                            ModelId = "deepseek-ai-deepseek-v4-flash",
                            PlatformId = "logical-model",
                            Priority = 1,
                            HealthStatus = "Healthy",
                        },
                    ],
                },
            ],
        };
        var service = new ModelPoolQueryService(resolver);

        var result = await service.GetModelPoolsAsync("literary-agent.content::chat", "chat");

        var model = Assert.Single(result);
        Assert.Equal("literary-agent.content::chat", resolver.AppCallerCode);
        Assert.Equal("chat", resolver.ModelType);
        Assert.Equal("deepseek-ai-deepseek-v4-flash", model.Code);
        Assert.Equal("deepseek-ai-deepseek-v4-flash", Assert.Single(model.Models).ModelId);
        Assert.Equal("deepseek-ai/DeepSeek-V4-Flash", model.Name);
        Assert.Equal(["chat"], model.Capabilities);
    }

    [Fact]
    public async Task GetModelPoolsAsync_PutsRuntimeDefaultFirst()
    {
        var resolver = new StubResolver
        {
            Pools =
            [
                CreatePool("first-by-display-order", priority: 10, isDefault: false),
                CreatePool("runtime-default", priority: 50, isDefault: true),
            ],
        };
        var service = new ModelPoolQueryService(resolver);

        var result = await service.GetModelPoolsAsync("literary-agent.content::chat", "chat");

        Assert.Equal(["runtime-default", "first-by-display-order"], result.Select(x => x.Code));
    }

    private static AvailableModelPool CreatePool(string publicId, int priority, bool isDefault)
        => new()
        {
            Id = $"logical-{publicId}",
            Name = publicId,
            Code = publicId,
            Priority = priority,
            ResolutionType = "LogicalModel",
            IsDefault = isDefault,
            Models =
            [
                new PoolModelInfo
                {
                    ModelId = publicId,
                    PlatformId = "logical-model",
                    HealthStatus = "Healthy",
                },
            ],
        };

    private sealed class StubResolver : IModelResolver
    {
        public List<AvailableModelPool> Pools { get; init; } = [];
        public string? AppCallerCode { get; private set; }
        public string? ModelType { get; private set; }

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
        {
            AppCallerCode = appCallerCode;
            ModelType = modelType;
            return Task.FromResult(Pools);
        }

        public Task<ModelResolutionResult> ResolveAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;

        public Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;

        public Task RecordUnavailableAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;
    }
}
