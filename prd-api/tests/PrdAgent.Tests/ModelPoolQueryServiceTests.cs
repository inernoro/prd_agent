using System.Runtime.CompilerServices;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class ModelPoolQueryServiceTests
{
    [Fact]
    public async Task GetModelPoolsAsync_UsesRuntimeCatalogAndPreservesPublicId()
    {
        var gateway = new StubGateway
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
        var service = new ModelPoolQueryService(gateway);

        var result = await service.GetModelPoolsAsync("literary-agent.content::chat", "chat");

        var model = Assert.Single(result);
        Assert.Equal("literary-agent.content::chat", gateway.AppCallerCode);
        Assert.Equal("chat", gateway.ModelType);
        Assert.Equal("deepseek-ai-deepseek-v4-flash", model.Code);
        Assert.Equal("deepseek-ai-deepseek-v4-flash", Assert.Single(model.Models).ModelId);
        Assert.Equal("deepseek-ai/DeepSeek-V4-Flash", model.Name);
        Assert.Equal(["chat"], model.Capabilities);
    }

    [Fact]
    public async Task GetModelPoolsAsync_PutsRuntimeDefaultFirst()
    {
        var gateway = new StubGateway
        {
            Pools =
            [
                CreatePool("first-by-display-order", priority: 10, isDefault: false),
                CreatePool("runtime-default", priority: 50, isDefault: true),
            ],
        };
        var service = new ModelPoolQueryService(gateway);

        var result = await service.GetModelPoolsAsync("literary-agent.content::chat", "chat");

        Assert.Equal(["runtime-default", "first-by-display-order"], result.Select(x => x.Code));
    }

    [Fact]
    public async Task GetModelPoolsAsync_WithoutCallerPreservesDefaultOnlyContract()
    {
        var gateway = new StubGateway
        {
            Pools =
            [
                CreatePool("probe-caller-default", priority: 5, isDefault: true, isDefaultForType: false),
                CreatePool("global-default", priority: 50, isDefault: false, isDefaultForType: true),
                CreatePool("unrestricted-extra", priority: 10, isDefault: false, isDefaultForType: false),
            ],
        };
        var service = new ModelPoolQueryService(gateway);

        var result = await service.GetModelPoolsAsync(null, "generation");

        var model = Assert.Single(result);
        Assert.Equal("global-default", model.Code);
        Assert.Equal(AppCallerRegistry.System.HealthProbe.Generation, gateway.AppCallerCode);
    }

    [Fact]
    public async Task GetModelPoolsAsync_DoesNotHideAuthoritativeGatewayFailureAsEmptyCatalog()
    {
        var gateway = new StubGateway
        {
            CatalogError = new InvalidOperationException("serving unavailable"),
        };
        var service = new ModelPoolQueryService(gateway);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.GetModelPoolsAsync("literary-agent.content::chat", "chat"));

        Assert.Equal("serving unavailable", error.Message);
    }

    private static AvailableModelPool CreatePool(
        string publicId,
        int priority,
        bool isDefault,
        bool? isDefaultForType = null)
        => new()
        {
            Id = $"logical-{publicId}",
            Name = publicId,
            Code = publicId,
            Priority = priority,
            ResolutionType = "LogicalModel",
            IsDefault = isDefault,
            IsDefaultForType = isDefaultForType ?? isDefault,
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

    private sealed class StubGateway : ILlmGateway
    {
        public List<AvailableModelPool> Pools { get; init; } = [];
        public string? AppCallerCode { get; private set; }
        public string? ModelType { get; private set; }
        public Exception? CatalogError { get; init; }

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
        {
            if (string.IsNullOrWhiteSpace(appCallerCode))
                throw new InvalidOperationException("真实网关拒绝空 appCallerCode");
            AppCallerCode = appCallerCode;
            ModelType = modelType;
            if (CatalogError is not null)
                throw CatalogError;
            return Task.FromResult(Pools);
        }

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request,
            [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.CompletedTask;
            yield break;
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request,
            GatewayModelResolution resolution,
            CancellationToken ct = default)
            => throw new NotSupportedException();

        public PrdAgent.Core.Interfaces.ILLMClient CreateClient(
            string appCallerCode,
            string modelType,
            int maxTokens = 4096,
            double temperature = 0.2,
            bool includeThinking = false,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null)
            => throw new NotSupportedException();
    }
}
