using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class CanonicalImageBoundaryTests
{
    private sealed class Transport : HttpMessageHandler, IHttpClientFactory
    {
        public List<string> Paths { get; } = [];
        public JsonObject? Body { get; private set; }
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Paths.Add(request.RequestUri!.AbsolutePath);
            Body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"Success\":true,\"StatusCode\":200,\"Content\":\"{}\"}") };
        }
    }

    [Fact]
    public async Task MapSendsOnlyCanonicalParameters_NoPreResolveOrWireParameters()
    {
        var transport = new Transport();
        var client = new HttpLlmGatewayClient(transport, new ConfigurationBuilder().Build(), NullLogger<HttpLlmGatewayClient>.Instance);
        var result = await client.GenerateImageAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VisualAgent.Image.Text2Img, ModelType = ModelTypes.ImageGen,
            ExpectedModel = "image1", RequiredLogicalModelPublicId = "image1",
            CanonicalImageRequest = new GatewayCanonicalImageRequest { Prompt = "白桃", Size = "1024x1024" },
        }, CancellationToken.None);
        Assert.True(result.Success);
        Assert.Equal(new[] { "/gw/v1/raw" }, transport.Paths);
        Assert.Equal("image1", transport.Body!["RequiredLogicalModelPublicId"]!.GetValue<string>());
        Assert.False(transport.Body.ContainsKey("RequestBody"));
        Assert.False(transport.Body.ContainsKey("EndpointPath"));
        Assert.Equal("1024x1024", transport.Body["CanonicalImageRequest"]!["Size"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("{\"data\":[{\"b64_json\":\"abc\"}]}")]
    [InlineData("{\"data\":[{\"url\":\"data:image/png;base64,abc\"}]}")]
    [InlineData("{\"choices\":[{\"message\":{\"images\":[{\"image_url\":{\"url\":\"data:image/png;base64,abc\"}}]}}]}")]
    [InlineData("{\"candidates\":[{\"content\":{\"parts\":[{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":\"abc\"}}]}}]}")]
    public void GatewayNormalizesVendorResults(string wire)
    {
        var response = GatewayImageResponseNormalizer.Normalize(new GatewayRawResponse { Success = true, StatusCode = 200, Content = wire });
        Assert.True(response.Success);
        Assert.Equal("abc", JsonNode.Parse(response.Content!)!["data"]![0]!["b64_json"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"data\":[{}]}")]
    [InlineData("invalid-json")]
    public void Http200WithoutImageIsNotSuccess(string wire)
        => Assert.False(GatewayImageResponseNormalizer.Normalize(new GatewayRawResponse { Success = true, StatusCode = 200, Content = wire }).Success);

    [Fact]
    public void NormalizedImagePreservesActualExecutionAndRequestedLogicalIdentity()
    {
        var resolution = new GatewayModelResolution
        {
            Success = true, LogicalModelPublicId = "image1", ActualModel = "gpt-image-1",
            ModelGroupName = "image-channel",
        };
        var result = GatewayImageResponseNormalizer.Normalize(new GatewayRawResponse
        {
            Success = true, Content = "{\"data\":[{\"b64_json\":\"abc\"}]}", Resolution = resolution,
        });
        Assert.Same(resolution, result.Resolution);
        Assert.Equal("image1", result.Resolution!.LogicalModelPublicId);
        Assert.Equal("gpt-image-1", result.Resolution.ActualModel);
    }
}
