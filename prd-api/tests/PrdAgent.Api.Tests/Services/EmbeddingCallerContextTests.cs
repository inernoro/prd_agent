using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class EmbeddingCallerContextTests
{
    [Fact]
    public async Task Resolve和Send共享提问者租户_发送后恢复原上下文()
    {
        var contexts = new LLMRequestContextAccessor();
        var parent = new LlmRequestContext("parent", null, "session", "reader", null, null, null,
            null, TenantId: "tenant-fixture", TeamId: "team-fixture");
        using var scope = contexts.BeginScope(parent);
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var resolution = new GatewayModelResolution { Success = true, ActualModel = "embedding-fixture" };
        gateway.Setup(g => g.ResolveModelAsync("caller", ModelTypes.Embedding, null, null, null, CancellationToken.None))
            .Callback(() => { Assert.Equal("tenant-fixture", contexts.Current?.TenantId); Assert.Equal("reader", contexts.Current?.UserId); })
            .ReturnsAsync(resolution);
        gateway.Setup(g => g.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), resolution, CancellationToken.None))
            .Callback((GatewayRawRequest request, GatewayModelResolution actual, CancellationToken ct) =>
            {
                Assert.Equal("tenant-fixture", request.Context?.TenantId);
                Assert.Equal("team-fixture", request.Context?.TeamId);
                Assert.Equal("tenant-fixture", contexts.Current?.TenantId);
                Assert.Equal("reader", contexts.Current?.UserId);
            }).ReturnsAsync(new GatewayRawResponse { Success = true, StatusCode = 200,
                Content = "{\"data\":[{\"index\":0,\"embedding\":[1,0]}]}", Resolution = resolution });
        var service = new EmbeddingService(gateway.Object, NullLogger<EmbeddingService>.Instance, contexts);
        var result = await service.EmbedAsync(new[] { "原文" }, "caller", "reader");
        Assert.True(result.Success);
        Assert.Same(parent, contexts.Current);
        gateway.VerifyAll();
    }
}
