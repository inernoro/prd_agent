using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayBusinessContextTests
{
    [Theory]
    [InlineData("send")]
    [InlineData("stream")]
    [InlineData("raw")]
    public async Task ExistingBusinessIdentityCrossesHttpBoundary(string path)
    {
        var business = new LlmRequestContext("business-request", null, null, "business-user", "ADMIN", null, null, null,
            RunId: "business-run", LogicalRequestId: "logical-request", ProviderTaskId: "provider-task");
        var accessor = new Mock<ILLMRequestContextAccessor>();
        accessor.SetupGet(x => x.Current).Returns(business);
        var handler = new Recorder();
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient(handler, false));
        var client = new HttpLlmGatewayClient(factory.Object, new ConfigurationBuilder().Build(),
            NullLogger<HttpLlmGatewayClient>.Instance, accessor.Object);
        var context = new GatewayRequestContext { RequestId = "poll-request", ProviderTaskId = "explicit-task" };
        var request = new GatewayRequest { AppCallerCode = AppCallerRegistry.VisualAgent.Storyboard.Script, ModelType = ModelTypes.Chat, Context = context };
        if (path == "raw") await client.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = request.AppCallerCode, ModelType = request.ModelType, Context = context
        }, new GatewayModelResolution { Success = true, ActualModel = "gpt-5.6-sol" });
        else if (path == "stream") { await foreach (var _ in client.StreamAsync(request)) { } }
        else await client.SendAsync(request);
        var sent = JsonDocument.Parse(handler.Body!).RootElement.GetProperty("Context");
        Assert.Equal("business-user", sent.GetProperty("UserId").GetString());
        Assert.Equal("business-run", sent.GetProperty("RunId").GetString());
        Assert.Equal("business-run", sent.GetProperty("SessionId").GetString());
        Assert.Equal("poll-request", sent.GetProperty("RequestId").GetString());
        Assert.Equal("logical-request", sent.GetProperty("LogicalRequestId").GetString());
        Assert.Equal("explicit-task", sent.GetProperty("ProviderTaskId").GetString());
        Assert.Equal("http", sent.GetProperty("GatewayTransport").GetString());
    }
    private sealed class Recorder : HttpMessageHandler
    {
        public string? Body { get; private set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Body = await request.Content!.ReadAsStringAsync(ct);
            return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("{}") };
        }
    }
}
