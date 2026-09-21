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
        var resolver = new FakeResolver();
        var probe = new ModelCatalogContractProbe(catalog, resolver);

        var result = await probe.CheckAsync();

        Assert.Equal(0, result.FailureCount);
        Assert.Equal(5, result.TargetCount);
        Assert.Equal(5, result.CatalogEntryCount);
        Assert.Empty(result.Failures);
        Assert.Equal(5, resolver.CatalogCalls.Count);
        Assert.Empty(resolver.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsWhenSelectorLeaksDisplayNameInsteadOfPublicId()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: true);
        var resolver = new FakeResolver();
        var probe = new ModelCatalogContractProbe(catalog, resolver);

        var result = await probe.CheckAsync();

        Assert.Equal(5, result.FailureCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":IDENTIFIER_DRIFT", failure));
        Assert.Equal(5, resolver.CatalogCalls.Count);
        Assert.Empty(resolver.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsWhenCatalogDefaultDiffersFromRuntimeDefault()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false);
        var resolver = new FakeResolver(automaticPublicId: "different-default");
        var probe = new ModelCatalogContractProbe(catalog, resolver);

        var result = await probe.CheckAsync();

        Assert.Equal(5, result.FailureCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":DEFAULT_RUNTIME_MISMATCH", failure));
        Assert.Empty(resolver.ResolveCalls);
    }

    [Fact]
    public async Task CheckAsync_FailsWhenEveryBusinessCatalogIsEmpty()
    {
        var catalog = new FakeCatalog(useDisplayNameAsMemberId: false, returnEmpty: true);
        var resolver = new FakeResolver();
        var probe = new ModelCatalogContractProbe(catalog, resolver);

        var result = await probe.CheckAsync();

        Assert.Equal(5, result.FailureCount);
        Assert.Equal(0, result.CatalogEntryCount);
        Assert.All(result.Failures, failure => Assert.EndsWith(":CATALOG_EMPTY", failure));
        Assert.Empty(resolver.ResolveCalls);
    }

    private sealed class FakeCatalog(bool useDisplayNameAsMemberId, bool returnEmpty = false) : IModelPoolQueryService
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
            return Task.FromResult<List<ModelPoolForAppResult>>(
            [
                new()
                {
                    Id = $"logical-{publicId}",
                    Name = "对外展示名",
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
                            HealthStatus = "Healthy",
                        },
                    ],
                },
            ]);
        }
    }

    private sealed class FakeResolver(string? automaticPublicId = null) : IModelResolver
    {
        public List<(string AppCallerCode, string? ExpectedModel)> ResolveCalls { get; } = [];
        public List<string> CatalogCalls { get; } = [];

        public Task<ModelResolutionResult> ResolveAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
        {
            ResolveCalls.Add((appCallerCode, expectedModel));
            var publicId = expectedModel ?? automaticPublicId ?? PublicId(appCallerCode);
            return Task.FromResult(new ModelResolutionResult
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
                CreateRuntimePool(catalogPublicId, isDefault: runtimeDefault == catalogPublicId),
            };
            if (!string.Equals(runtimeDefault, catalogPublicId, StringComparison.Ordinal))
            {
                pools.Add(CreateRuntimePool(runtimeDefault, isDefault: true));
            }
            return Task.FromResult(pools);
        }

        private static AvailableModelPool CreateRuntimePool(string publicId, bool isDefault)
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
                        HealthStatus = "Healthy",
                    },
                ],
            };

        public Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;

        public Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;

        public Task RecordUnavailableAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;
    }

    private static string PublicId(string? appCallerCode)
        => $"public-{(appCallerCode ?? "unknown").Replace('.', '-').Replace(':', '-')}";
}
