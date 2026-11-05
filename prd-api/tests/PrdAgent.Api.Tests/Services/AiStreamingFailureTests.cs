using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services.DefectAgent;
using PrdAgent.Api.Services.PrReview;
using PrdAgent.Api.Services.Streaming;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class AiStreamingFailureTests
{
    [Fact]
    public async Task DefectPolish_GatewayFailureReachesTheSseContractWithItsClassification()
    {
        var gateway = new Mock<ILlmGateway>();
        GatewayRequest? capturedRequest = null;
        gateway.Setup(x => x.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Callback<GatewayRequest, CancellationToken>((request, _) => capturedRequest = request)
            .Returns(GatewayFailure());
        var service = new DefectPolishService(gateway.Object,
            new MongoDbContext("mongodb://127.0.0.1:27017", "unused_polish_contract"),
            NullLogger<DefectPolishService>.Instance);
        var context = new DefaultHttpContext();
        using var body = new MemoryStream();
        context.Response.Body = body;

        await AiStreamingHelpers.WriteSseStreamAsync(context.Response, "AI 润色",
            holder => service.StreamPolishAsync("原始描述", null, null, holder, CancellationToken.None),
            NullLogger.Instance);

        var output = Encoding.UTF8.GetString(body.ToArray());
        Assert.Equal(GatewayRouteFailure.AppCallerPoolUnbound, ReadError(output).GetProperty("code").GetString());
        Assert.DoesNotContain("private.polish", output);
        Assert.NotNull(capturedRequest);
        Assert.True(capturedRequest.IncludeThinking);
        Assert.False(capturedRequest.RequestBody!.AsObject().ContainsKey("include_reasoning"));
        Assert.False(capturedRequest.RequestBody.AsObject().ContainsKey("reasoning"));
        gateway.Verify(x => x.StreamAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Theory]
    [InlineData(GatewayRouteFailure.AppCallerPoolUnbound)]
    [InlineData(GatewayRouteFailure.ModelPoolEmpty)]
    [InlineData(GatewayRouteFailure.ProviderUnavailable)]
    public async Task RouteFailure_PreservesCodeAndRequestIdWithoutLeakingDiagnostics(string code)
    {
        var output = await RunAsync(new GatewayRouteFailureException(code,
            "AppCallerCode=private.polish::chat; secret upstream"));
        var error = ReadError(output);
        Assert.Equal(code, error.GetProperty("code").GetString());
        Assert.Equal("polish-request", error.GetProperty("requestId").GetString());
        Assert.True(error.GetProperty("elapsedMs").GetInt64() >= 0);
        Assert.Equal(GatewayRouteFailure.UserMessage(code), error.GetProperty("message").GetString());
        Assert.DoesNotContain("AppCallerCode", output);
        Assert.DoesNotContain("secret", output);
        Assert.DoesNotContain("event: done", output);
    }

    [Fact]
    public async Task UnknownFailure_IsSafeAndIncludesRecoveryAction()
    {
        var output = await RunAsync(new InvalidOperationException("secret API key HTTP 500"));
        var error = ReadError(output);
        Assert.Equal("INTERNAL_ERROR", error.GetProperty("code").GetString());
        Assert.Contains("重试", error.GetProperty("message").GetString());
        Assert.DoesNotContain("secret", output);
        Assert.DoesNotContain("event: done", output);
    }

    private static async Task<string> RunAsync(Exception failure)
    {
        var context = new DefaultHttpContext { TraceIdentifier = "polish-request" };
        using var body = new MemoryStream();
        context.Response.Body = body;
        await AiStreamingHelpers.WriteSseStreamAsync(context.Response, "AI 润色",
            _ => FailingStream(failure), NullLogger.Instance);
        return Encoding.UTF8.GetString(body.ToArray());
    }

    private static async IAsyncEnumerable<LlmStreamDelta> FailingStream(Exception failure)
    {
        await Task.Yield();
        yield return new LlmStreamDelta(false, "部分内容");
        throw failure;
    }

    private static async IAsyncEnumerable<GatewayStreamChunk> GatewayFailure()
    {
        await Task.Yield();
        yield return GatewayStreamChunk.Fail("AppCallerCode=private.polish::chat", GatewayRouteFailure.AppCallerPoolUnbound);
    }

    private static JsonElement ReadError(string output)
    {
        var block = output.Split("\n\n").Single(part => part.StartsWith("event: error"));
        var data = block.Split('\n').Single(line => line.StartsWith("data: "))[6..];
        using var document = JsonDocument.Parse(data);
        return document.RootElement.Clone();
    }
}
