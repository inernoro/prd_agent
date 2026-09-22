using System.Runtime.CompilerServices;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class AgentUniverseModelParameterTests
{
    [Fact]
    public async Task ReadImageSizesAsync_ReadsPhysicalCapabilitiesFromCatalogWithoutClaimingHalfOpenLease()
    {
        var gateway = new CapturingGateway();
        var leaseBefore = gateway.HalfOpenLeaseUntil;

        var sizes = await AgentUniverseController.ReadImageSizesAsync(
            gateway,
            "ai-toolbox.agent.visual::generation",
            "default-generation");

        Assert.Equal("ai-toolbox.agent.visual::generation", gateway.AppCallerCode);
        Assert.Equal(0, gateway.ResolveCalls);
        Assert.Equal(leaseBefore, gateway.HalfOpenLeaseUntil);
        Assert.Contains("1024x1024", sizes);
        Assert.True(sizes.Count >= 3);
    }

    [Fact]
    public async Task GatewayImageCatalog_ReadsCapabilitySnapshotWithoutResolvingAgain()
    {
        var gateway = new CapturingGateway();
        var leaseBefore = gateway.HalfOpenLeaseUntil;

        var catalog = await GatewayImageModelCatalog.ReadAsync(
            gateway,
            "ai-toolbox.agent.visual::generation",
            CancellationToken.None);

        var model = Assert.Single(catalog);
        Assert.Equal("default-generation", model.Model.Code);
        Assert.True(model.ImageCapabilities?.Matched);
        Assert.Equal(0, gateway.ResolveCalls);
        Assert.Equal(leaseBefore, gateway.HalfOpenLeaseUntil);
    }

    private sealed class CapturingGateway : ILlmGateway
    {
        public string? AppCallerCode { get; private set; }
        public int ResolveCalls { get; private set; }
        public DateTime HalfOpenLeaseUntil { get; private set; } = new(2026, 9, 22, 1, 2, 3, DateTimeKind.Utc);

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
        {
            ResolveCalls++;
            HalfOpenLeaseUntil = DateTime.UtcNow.AddMinutes(1);
            throw new InvalidOperationException("只读能力查询不应调用 ResolveModelAsync");
        }

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
        {
            AppCallerCode = appCallerCode;
            return Task.FromResult(new List<AvailableModelPool>
            {
                new()
                {
                    Id = "logical-image2",
                    Code = "default-generation",
                    Name = "默认生图",
                    ResolutionType = "LogicalModel",
                    Models =
                    [
                        new PoolModelInfo
                        {
                            ModelId = "default-generation",
                            PlatformId = "logical-model",
                            HealthStatus = "Unavailable",
                            ActualModelId = "chatgpt-image-latest",
                            ActualPlatformId = "openai",
                            // 目录读取只消费网关下发的能力快照，不再根据物理模型名本地推导。
                            ImageCapabilities = new GatewayImageCapabilitiesSnapshot
                            {
                                SizeConstraintType = "whitelist",
                                SizeParamFormat = "WxH",
                                SizesByResolution = new Dictionary<string, List<string>>
                                {
                                    ["standard"] = ["1024x1024", "1536x1024", "1024x1536"],
                                },
                            },
                        },
                    ],
                },
            });
        }

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

        public ILLMClient CreateClient(
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
