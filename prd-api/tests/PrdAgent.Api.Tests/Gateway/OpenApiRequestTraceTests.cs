using System.Security.Claims;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Tests.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class OpenApiRequestTraceTests
{
    [Theory]
    [InlineData("chat")]
    [InlineData("stream")]
    [InlineData("image")]
    public async Task BusinessLogAndPhysicalGatewayRequest_ShareServerGeneratedRequestId(string kind)
    {
        await using var database = await RunMongoFixture.CreateAsync("openapi_trace");
        var key = new AgentApiKey { OwnerUserId = "trace-owner", OpenApiChatModels = ["future-model"],
            OpenApiImageModels = ["future-image"], Scopes = [OpenApiController.ScopeCall] };
        await database.Db.AgentApiKeys.InsertOneAsync(key);
        var http = new DefaultHttpContext();
        http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("agentApiKeyId", key.Id)], "ApiKey"));
        http.Response.Body = new MemoryStream();
        var body = new JsonObject { ["model"] = kind == "image" ? "future-image" : "future-model",
            ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "fixture" }),
            ["stream"] = kind == "stream", ["prompt"] = "fixture" };
        http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body.ToJsonString()));
        // 外部伪造的追踪头不能取代服务端确定的请求身份。
        http.Request.Headers["X-Request-Id"] = "untrusted-external-id";
        var usage = new Mock<IOpenApiUsageService>();
        usage.Setup(x => x.CheckAndReserveAsync(It.IsAny<AgentApiKey>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(OpenApiUsageDecision.Allow(10, 9));
        var gateway = new Mock<ILlmGateway>();
        GatewayRequestContext? physicalContext = null;
        var resolution = new GatewayModelResolution { Success = true, ActualModel = "future-model",
            ActualPlatformId = "fixture-platform", ResolutionType = "LogicalModel" };
        gateway.Setup(x => x.SendAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Callback<GatewayRequest, CancellationToken>((request, _) => physicalContext = request.Context)
            .ReturnsAsync(new GatewayResponse { Success = true, StatusCode = 200, Content = "OK", Resolution = resolution });
        gateway.Setup(x => x.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Returns((GatewayRequest request, CancellationToken _) =>
            {
                physicalContext = request.Context;
                return Stream(resolution);
            });
        gateway.Setup(x => x.ResolveModelAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
                It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(resolution);
        gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Callback<GatewayRawRequest, GatewayModelResolution, CancellationToken>((request, _, _) => physicalContext = request.Context)
            .ReturnsAsync(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "{\"data\":[]}" });
        var controller = new OpenApiController(gateway.Object, new LLMRequestContextAccessor(), database.Db,
            usage.Object, NullLogger<OpenApiController>.Instance)
        { ControllerContext = new ControllerContext { HttpContext = http } };

        if (kind == "image") await controller.ImageGenerations(default);
        else await controller.ChatCompletions(default);

        var log = await database.Db.OpenApiRequestLogs.Find(_ => true).SingleAsync();
        Assert.NotNull(physicalContext);
        Assert.Equal(log.RequestId, physicalContext!.RequestId);
        Assert.NotEqual("untrusted-external-id", physicalContext.RequestId);
        Assert.Equal(key.OwnerUserId, physicalContext.UserId);
        Assert.Equal(200, log.StatusCode);
    }

    private static async IAsyncEnumerable<GatewayStreamChunk> Stream(GatewayModelResolution resolution)
    {
        await Task.CompletedTask;
        yield return GatewayStreamChunk.Start(resolution);
        yield return GatewayStreamChunk.Text("OK");
        yield return GatewayStreamChunk.Done("stop", null);
    }
}
