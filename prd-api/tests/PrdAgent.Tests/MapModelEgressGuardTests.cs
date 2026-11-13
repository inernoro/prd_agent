using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Tests;

public sealed class MapModelEgressGuardTests
{
    [Theory]
    [InlineData("/gw/v1/send")]
    [InlineData("/gw/v1/stream")]
    [InlineData("/gw/v1/raw")]
    [InlineData("/gw/v1/client-stream")]
    [InlineData("/gw/v1/profile-test")]
    [InlineData("/gw/v1/future-paid-job")]
    [InlineData("/gw/v1/asr/live")]
    public async Task NewOrKnownGatewayRoute_CannotUseSelfReportedPermit(string path)
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://gateway.invalid" + path);
        request.Headers.Add("X-Gateway-Task-Permit", "spoofed-permit");
        request.Options.Set(new HttpRequestOptionsKey<bool>("map.task-authorized"), true);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => http.SendAsync(request));
        Assert.Equal(0, transport.Sends);
    }

    [Fact]
    public async Task AuthorizedDedicatedGatewayTransport_AllowsFutureRouteWithoutDuplicateAuthorization()
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport, AuthorizedGatewayRequest.HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://gateway.invalid/gw/v1/future-paid-job");
        var authorizer = new TestAuthorizer();
        await AuthorizedGatewayRequest.PrepareAsync(request, authorizer, "future-business::chat", null, CancellationToken.None);
        using var response = await http.SendAsync(request);
        Assert.Equal(1, authorizer.Calls);
        Assert.Equal(1, transport.Sends);
        Assert.True(response.IsSuccessStatusCode);
    }

    [Fact]
    public async Task PreparedMessage_CannotBeRepurposedToAnotherGatewayTarget()
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport, AuthorizedGatewayRequest.HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://gateway.invalid/gw/v1/send");
        await AuthorizedGatewayRequest.PrepareAsync(request, new TestAuthorizer(), "future-business::chat", null, CancellationToken.None);
        request.RequestUri = new Uri("https://gateway.invalid/gw/v1/future-paid-job");
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => http.SendAsync(request));
        Assert.Equal(0, transport.Sends);
    }

    [Theory]
    [InlineData("/v1/models")]
    [InlineData("/v1/models/vendor/model")]
    [InlineData("/gw/v1/requests/request-id/status?operation=raw")]
    [InlineData("/gw/v1/healthz")]
    [InlineData("/gw/v1/healthz/ready")]
    [InlineData("/gw/v1/healthz/deep")]
    public async Task ExistingReadOnlyGatewayContract_RemainsAvailableWithoutTaskPermit(string path)
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport);
        using var response = await http.GetAsync("https://gateway.invalid" + path);
        Assert.True(response.IsSuccessStatusCode);
        Assert.Equal(1, transport.Sends);
    }

    [Theory]
    [InlineData("/v1/models")]
    [InlineData("/gw/v1/requests/request-id/status?operation=raw")]
    public async Task ReadOnlyContract_DoesNotPermitAMutationWithTheSamePath(string path)
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => http.PostAsync("https://gateway.invalid" + path, new StringContent("{}")));
        Assert.Equal(0, transport.Sends);
    }

    [Theory]
    [InlineData("https://future-vendor.invalid/v1/chat/completions")]
    [InlineData("https://future-vendor.invalid/v1/messages")]
    [InlineData("https://future-vendor.invalid/v1/responses")]
    [InlineData("https://future-vendor.invalid/v1/images/generations")]
    [InlineData("https://future-vendor.invalid/v1/audio/transcriptions")]
    [InlineData("https://future-vendor.invalid/v1/models/future:generateContent")]
    [InlineData("https://fal.run/future-vendor/future-model")]
    public async Task DirectVendorProtocol_IsRejectedBeforeNetwork(string url)
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => http.PostAsync(url, new StringContent("{}")));
        Assert.Equal(0, transport.Sends);
    }

    [Fact]
    public async Task WholeHttpFactory_IsGuardedIncludingFutureNamedClient()
    {
        var transport = new RecordingHandler();
        using var services = new ServiceCollection()
            .AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { ["LlmGateway:ServeBaseUrl"] = "https://gateway.invalid" }).Build())
            .AddMapModelEgressGuard()
            .AddHttpClient("future-business", c => { }).ConfigurePrimaryHttpMessageHandler(() => transport)
            .Services.BuildServiceProvider();
        using var http = services.GetRequiredService<IHttpClientFactory>().CreateClient("future-business");
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => http.PostAsync("https://future-vendor.invalid/v1/chat/completions", new StringContent("{}")));
        Assert.Equal(0, transport.Sends);
    }

    [Fact]
    public async Task OrdinaryDownloadStorageUploadAndReadOnlyModelDirectory_RemainAvailable()
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport);
        using var downloaded = await http.GetAsync("https://assets.invalid/images/one.jpg");
        using var uploaded = await http.PostAsync("https://storage.invalid/objects", new ByteArrayContent([1, 2]));
        using var catalog = new HttpRequestMessage(HttpMethod.Get, "https://provider.invalid/v1/models");
        catalog.Headers.Add("anthropic-version", "2023-06-01");
        catalog.Headers.Add("x-api-key", "catalog-key");
        using var models = await http.SendAsync(catalog);
        using var resolve = await http.PostAsync("https://gateway.invalid/gw/v1/resolve", new StringContent("{}"));
        using var pools = await http.GetAsync("https://gateway.invalid/gw/v1/pools");
        Assert.Equal(5, transport.Sends);
    }

    [Fact]
    public async Task RedirectedDownload_IsCheckedAgainAndCannotReachModelEndpoint()
    {
        var transport = new RecordingHandler("https://future-vendor.invalid/v1/chat/completions");
        using var http = GuardedClient(transport);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => http.GetAsync("https://assets.invalid/redirect"));
        Assert.Equal(1, transport.Sends);
    }

    [Fact]
    public async Task RedirectedAttachment_RemainsAvailableWithoutCrossHostCredentials()
    {
        var transport = new RecordingHandler("https://cdn.invalid/one.jpg");
        using var http = GuardedClient(transport);
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://assets.invalid/redirect");
        request.Headers.Add("Authorization", "Bearer private-asset-key");
        using var response = await http.SendAsync(request);
        Assert.Equal(2, transport.Sends);
        Assert.Null(transport.LastAuthorization);
        Assert.True(response.IsSuccessStatusCode);
    }

    [Fact]
    public async Task GatewayCredentials_CannotBeSentToExternalTarget()
    {
        var transport = new RecordingHandler();
        using var http = GuardedClient(transport, AuthorizedGatewayRequest.HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://assets.invalid/one.jpg");
        request.Headers.Add("X-Gateway-Key", "internal-key");
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => http.SendAsync(request));
        Assert.Equal(0, transport.Sends);
    }

    private static HttpClient GuardedClient(RecordingHandler transport, string name = "future-business")
        => new(new MapModelEgressHandler(name, new Uri("https://gateway.invalid")) { InnerHandler = transport });

    private sealed class TestAuthorizer : ITaskExecutionAuthorizer
    {
        public int Calls { get; private set; }
        public Task AuthorizeOutboundAsync(HttpRequestMessage request, string caller, GatewayRequestContext? context, CancellationToken ct)
        {
            Calls++;
            request.Headers.Add("X-Gateway-Task-Permit", "record-verified-by-test-authorizer");
            return Task.CompletedTask;
        }
    }

    private sealed class RecordingHandler(string? redirect = null) : HttpMessageHandler
    {
        public int Sends { get; private set; }
        public string? LastAuthorization { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sends++;
            LastAuthorization = request.Headers.Authorization?.ToString();
            var response = new HttpResponseMessage(Sends == 1 && redirect is not null ? HttpStatusCode.Found : HttpStatusCode.OK)
            { Content = new StringContent("ok") };
            if (Sends == 1 && redirect is not null) response.Headers.Location = new Uri(redirect);
            return Task.FromResult(response);
        }
    }
}
