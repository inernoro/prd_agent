using System.Runtime.CompilerServices;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class AgentUniverseModelParameterTests
{
    [Fact]
    public async Task ReadImageSizesAsync_ResolvesLogicalPublicIdBeforeReadingPhysicalCapabilities()
    {
        var gateway = new CapturingGateway();

        var sizes = await AgentUniverseController.ReadImageSizesAsync(
            gateway,
            "ai-toolbox.agent.visual::generation",
            "image2");

        Assert.Equal("ai-toolbox.agent.visual::generation", gateway.AppCallerCode);
        Assert.Equal("image2", gateway.ExpectedModel);
        Assert.Contains("1024x1024", sizes);
        Assert.True(sizes.Count >= 3);
    }

    private sealed class CapturingGateway : ILlmGateway
    {
        public string? AppCallerCode { get; private set; }
        public string? ExpectedModel { get; private set; }

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
        {
            AppCallerCode = appCallerCode;
            ExpectedModel = expectedModel;
            return Task.FromResult(new GatewayModelResolution
            {
                Success = true,
                ResolutionType = "LogicalModel",
                LogicalModelPublicId = expectedModel,
                ActualPlatformId = "openai",
                ActualModel = "gpt-image-2",
            });
        }

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());

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
