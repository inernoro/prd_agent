using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class CodeReviewUserKeysTests
{
    [Fact]
    public async Task BoundResolverCannotEnterAnyPlatformPool()
    {
        var http = new DefaultHttpContext();
        var resolution = new ModelResolutionResult { Success = true, ActualPlatformId = "user-key:one", ActualModel = "chosen" };
        http.Items[CodeReviewUserKeys.ResolutionItem] = resolution;
        var resolver = new CodeReviewUserKeyResolver(null!, new HttpContextAccessor { HttpContext = http });
        Assert.Same(resolution, await resolver.ResolveAsync(CodeReviewUserKeys.Caller, "chat", "anything", "user-key:one", "chosen"));
        Assert.False((await resolver.ResolveAsync("another.call::chat", "chat", null, "user-key:one", "chosen")).Success);
        Assert.False((await resolver.ResolveAsync(CodeReviewUserKeys.Caller, "chat", null, "platform-key", "chosen")).Success);
        Assert.False((await resolver.ResolveOfferingAsync(CodeReviewUserKeys.Caller, "chat", "offering")).Success);
        Assert.Empty(await resolver.GetAvailablePoolsAsync(CodeReviewUserKeys.Caller, "chat"));
        await resolver.RecordFailureAsync(resolution);
    }

    [Theory]
    [InlineData("openai", "api.openai.com", "openai")]
    [InlineData("anthropic", "api.anthropic.com", "claude")]
    [InlineData("openrouter", "openrouter.ai", "openai")]
    [InlineData("deepseek", "api.deepseek.com", "openai")]
    public void ProviderEndpointsAreServerOwned(string provider, string hostname, string protocol)
    {
        Assert.Equal(hostname, new Uri(CodeReviewUserKeys.Providers[provider].Url).Host);
        Assert.Equal(protocol, CodeReviewUserKeys.Providers[provider].Protocol);
        Assert.Equal(4, CodeReviewUserKeys.Providers.Count);
    }

    [Fact]
    public async Task DedicatedRoutesRejectAnonymousOrMalformedBindingsBeforeAnyDatabaseAccess()
    {
        var builder = WebApplication.CreateBuilder(); builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["CodeReview:ServiceKey"] = "issuer-test-secret" });
        builder.Services.AddSingleton(new LlmGatewayDataContext("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=10", "no_database_access"));
        await using var app = builder.Build(); app.MapCodeReviewUserKeys(); await app.StartAsync();
        using var client = app.GetTestClient();
        var input = new CodeReviewKeyBind("owner", "project", "task", "openai", "chosen", "not-a-real-key");
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/internal/code-review/user-keys/bind", input)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/byok/v1/chat/completions", new { messages = new[] { new { role = "user", content = "ok" } } })).StatusCode);
        client.DefaultRequestHeaders.Add("X-Code-Review-Service-Key", "issuer-test-secret");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/internal/code-review/user-keys/bind", input with { Provider = "unknown" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/internal/code-review/user-keys/bind", input with { TokenLimit = 1 })).StatusCode);
    }
}
