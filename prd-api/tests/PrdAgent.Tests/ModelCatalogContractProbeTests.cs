using System.Runtime.CompilerServices;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class ModelCatalogContractProbeTests
{
    [Fact]
    public async Task CheckAsync_PassesWhenEverySelectorUsesResolvablePublicId()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false);
        var gateway = new FakeGateway();
        var probe = new ModelCatalogContractProbe(catalog, gateway);

        var result = await probe.CheckAsync();

        Assert.Equal(0, result.FailureCount);
        Assert.Equal(5, result.TargetCount);
        Assert.Equal(5, result.CatalogEntryCount);
        Assert.Empty(result.Failures);
        Assert.Equal(5, gateway.CatalogCalls.Count);
        Assert.Empty(gateway.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsWhenSelectorLeaksDisplayNameInsteadOfPublicId()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: true);
        var gateway = new FakeGateway();
        var probe = new ModelCatalogContractProbe(catalog, gateway);

        var result = await probe.CheckAsync();

        Assert.Equal(5, result.FailureCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":IDENTIFIER_DRIFT", failure));
        Assert.Equal(5, gateway.CatalogCalls.Count);
        Assert.Empty(gateway.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsWhenCatalogDefaultDiffersFromRuntimeDefault()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false);
        var gateway = new FakeGateway(automaticPublicId: "different-default");
        var probe = new ModelCatalogContractProbe(catalog, gateway);

        var result = await probe.CheckAsync();

        Assert.Equal(5, result.FailureCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":DEFAULT_RUNTIME_MISMATCH", failure));
        Assert.Empty(gateway.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsWhenEveryBusinessCatalogIsEmpty()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false, returnEmpty: true);
        var gateway = new FakeGateway();
        var probe = new ModelCatalogContractProbe(catalog, gateway);

        var result = await probe.CheckAsync();

        Assert.Equal(5, result.FailureCount);
        Assert.Equal(0, result.CatalogEntryCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":CATALOG_EMPTY", failure));
        Assert.Empty(gateway.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsButKeepsCatalogVisibleWhenModelIsUnavailable()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false, healthStatus: "Unavailable");
        var gateway = new FakeGateway(healthStatus: "Unavailable");
        var probe = new ModelCatalogContractProbe(catalog, gateway);

        var result = await probe.CheckAsync();

        Assert.Equal(5, result.CatalogEntryCount);
        Assert.Equal(5, result.FailureCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":MODEL_UNAVAILABLE", failure));
        Assert.Empty(gateway.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsWhenImageCatalogUsesMarketingAlias()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false, displayNameDrift: true);
        var gateway = new FakeGateway();
        var probe = new ModelCatalogContractProbe(catalog, gateway);

        var result = await probe.CheckAsync();

        Assert.Equal(3, result.FailureCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":NON_CANONICAL_DISPLAY_NAME", failure));
    }

    [Fact]
    public async Task CheckAsync_FailsWhenSelectorContainsDuplicateDisplayNames()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false, duplicateDisplayNames: true);
        var gateway = new FakeGateway(includeSecondary: true);
        var probe = new ModelCatalogContractProbe(catalog, gateway);

        var result = await probe.CheckAsync();

        Assert.Equal(8, result.FailureCount);
        Assert.Equal(5, result.Failures.Count(failure => failure.EndsWith(":DUPLICATE_DISPLAY_NAME")));
        Assert.Equal(3, result.Failures.Count(failure => failure.EndsWith(":NON_CANONICAL_DISPLAY_NAME")));
    }

    private sealed class FakeCatalog(
        bool useDisplayNameAsMemberId,
        bool returnEmpty = false,
        string healthStatus = "Healthy",
        bool displayNameDrift = false,
        bool duplicateDisplayNames = false) : IModelPoolQueryService
    {
        public Task<List<ModelPoolForAppResult>> GetModelPoolsAsync(
            string? appCallerCode,
            string modelType,
            CancellationToken ct = default)
        {
            if (returnEmpty)
            {
                return Task.FromResult(new List<ModelPoolForAppResult>());
            }

            var publicId = PublicId(appCallerCode);
            var pools = new List<ModelPoolForAppResult>
            {
                new()
                {
                    Id = $"logical-{publicId}",
                    Name = displayNameDrift || duplicateDisplayNames ? "营销别名" : publicId,
                    Code = publicId,
                    ModelType = modelType,
                    IsDefault = true,
                    IsDefaultForType = true,
                    ResolutionType = "LogicalModel",
                    Models =
                    [
                        new()
                        {
                            ModelId = useDisplayNameAsMemberId ? "provider/Display-Name" : publicId,
                            PlatformId = "logical-model",
                            HealthStatus = healthStatus,
                        },
                    ],
                },
            };
            if (duplicateDisplayNames)
            {
                pools.Add(new ModelPoolForAppResult
                {
                    Id = $"logical-{publicId}-secondary",
                    Name = "营销别名",
                    Code = $"{publicId}-secondary",
                    ModelType = modelType,
                    IsDefault = false,
                    IsDefaultForType = false,
                    ResolutionType = "LogicalModel",
                    Models =
                    [
                        new()
                        {
                            ModelId = $"{publicId}-secondary",
                            PlatformId = "logical-model",
                            HealthStatus = healthStatus,
                        },
                    ],
                });
            }
            return Task.FromResult(pools);
        }
    }

    private sealed class FakeGateway(
        string? automaticPublicId = null,
        string healthStatus = "Healthy",
        bool includeSecondary = false) : ILlmGateway
    {
        public List<(string AppCallerCode, string? ExpectedModel)> ResolveCalls { get; } = [];
        public List<string> CatalogCalls { get; } = [];

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
        {
            ResolveCalls.Add((appCallerCode, expectedModel));
            var publicId = expectedModel ?? automaticPublicId ?? PublicId(appCallerCode);
            return Task.FromResult(new GatewayModelResolution
            {
                Success = true,
                LogicalModelPublicId = publicId,
                ActualModel = "provider/actual-model",
                ActualPlatformId = "provider",
                ResolutionType = "LogicalModel",
            });
        }

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
        {
            CatalogCalls.Add(appCallerCode);
            var catalogPublicId = PublicId(appCallerCode);
            var runtimeDefault = automaticPublicId ?? catalogPublicId;
            var pools = new List<AvailableModelPool>
            {
                CreateRuntimePool(catalogPublicId, isDefault: runtimeDefault == catalogPublicId, healthStatus),
            };
            if (includeSecondary)
            {
                pools.Add(CreateRuntimePool($"{catalogPublicId}-secondary", isDefault: false, healthStatus));
            }
            if (!string.Equals(runtimeDefault, catalogPublicId, StringComparison.Ordinal))
            {
                pools.Add(CreateRuntimePool(runtimeDefault, isDefault: true, healthStatus));
            }
            return Task.FromResult(pools);
        }

        private static AvailableModelPool CreateRuntimePool(string publicId, bool isDefault, string healthStatus)
            => new()
            {
                Id = $"logical-{publicId}",
                Name = publicId,
                Code = publicId,
                ResolutionType = "LogicalModel",
                IsDefault = isDefault,
                Models =
                [
                    new PoolModelInfo
                    {
                        ModelId = publicId,
                        PlatformId = "logical-model",
                        HealthStatus = healthStatus,
                    },
                ],
            };

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

    private static string PublicId(string? appCallerCode)
        => $"public-{(appCallerCode ?? "unknown").Replace('.', '-').Replace(':', '-')}";
}
