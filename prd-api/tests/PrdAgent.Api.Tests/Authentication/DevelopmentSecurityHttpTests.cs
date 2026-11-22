using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.ApplicationModels;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;
using Moq;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Controllers.Stub;
using PrdAgent.Api.Filters;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

// Real loopback HTTP + JWT validation + production authentication/filter/controller code.
// Deliberately NOT Program.cs: no workers, Mongo, Redis, MCP transport or paid model calls.
[Xunit.Collection("DevelopmentSecurity")]
public sealed class DevelopmentSecurityHttpTests
{
    private const string SigningKey = "isolated-test-signing-key-32-bytes-minimum";
    private const string StubKey = "isolated-stub-key-32-bytes-minimum";

    [Fact]
    public async Task AuthorizedDevelopmentStub_GenerationAndEditUseRequestedInlinePng()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = "Development",
            ContentRootPath = AppContext.BaseDirectory
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DevelopmentStub:Enabled"] = "true",
            ["DevelopmentStub:ApiKey"] = StubKey
        });
        builder.Services.AddAuthorization();
        builder.Services.AddSingleton(Mock.Of<IWatermarkFontAssetSource>());
        builder.Services.AddSingleton(Mock.Of<IAssetStorage>());
        builder.Services.AddSingleton<WatermarkFontRegistry>();
        builder.Services.AddControllers(options =>
        {
            options.Conventions.Add(new SelectedControllers());
            options.Conventions.Add(new DevelopmentStubConvention(true));
        }).AddApplicationPart(typeof(StubOpenAIController).Assembly);
        await using var app = builder.Build();
        app.MapControllers();
        await app.StartAsync();

        const string images = "/api/v1/stub/v1/images";
        using var client = app.GetTestClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", StubKey);
        using var generated = await client.PostAsJsonAsync($"{images}/generations",
            new { size = "64x64", prompt = "Fixture", response_format = "b64_json" });
        var source = await ReadInlinePng(generated);

        using var form = new MultipartFormDataContent();
        form.Add(new ByteArrayContent(source), "image", "fixture.png");
        form.Add(new StringContent("64x64"), "size");
        form.Add(new StringContent("Edit fixture"), "prompt");
        form.Add(new StringContent("b64_json"), "response_format");
        using var edited = await client.PostAsync($"{images}/edits", form);
        await ReadInlinePng(edited);

        using var defaultFormat = await client.PostAsJsonAsync($"{images}/generations",
            new { size = "64x64", prompt = "Fixture" });
        defaultFormat.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await defaultFormat.Content.ReadAsByteArrayAsync());
        var assetPath = new Uri(json.RootElement.GetProperty("data")[0].GetProperty("url").GetString()!).PathAndQuery;
        using var authorizedAsset = await client.GetAsync(assetPath);
        Assert.Equal(HttpStatusCode.OK, authorizedAsset.StatusCode);
        using var anonymousClient = app.GetTestClient();
        using var anonymousAsset = await anonymousClient.GetAsync(assetPath);
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousAsset.StatusCode);
    }

    private static async Task<byte[]> ReadInlinePng(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync());
        var image = json.RootElement.GetProperty("data")[0];
        Assert.False(image.TryGetProperty("url", out _));
        var bytes = image.GetProperty("b64_json").GetBytesFromBase64();
        Assert.Equal(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, bytes.Take(8));
        return bytes;
    }

    [Theory]
    [InlineData("Production", true)]
    [InlineData("Development", false)]
    [InlineData("Development", true)]
    public async Task RealHttp_EnvironmentIdentityAndRevocation(string environment, bool enabled)
    {
        var grants = true;
        var revoked = false;
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(x => x.GetEffectivePermissionsAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => (IReadOnlyList<string>)(grants ? new[] { "access", "mds.read" } : Array.Empty<string>()));
        var keys = new Mock<IAgentApiKeyService>();
        keys.Setup(x => x.LookupByPlaintextAsync("sk-ak-isolated", It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => revoked ? null : new AgentApiKeyLookupResult(new AgentApiKey
            { Id = "test-key", Name = "test", OwnerUserId = "owner", Scopes = new List<string>() }, false));
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DevelopmentStub:Enabled"] = enabled.ToString(), ["DevelopmentStub:ApiKey"] = StubKey,
            // Tests the handler ignoring this legacy setting, not Program's startup guard.
            ["OpenPlatform:TestApiKey"] = "sk-retired-test-key"
        });
        builder.Services.AddSingleton(permissions.Object);
        builder.Services.AddSingleton(keys.Object);
        builder.Services.AddSingleton(Mock.Of<IOpenPlatformService>());
        builder.Services.AddSingleton<McpLoopbackSignal>();
        builder.Services.AddAuthentication("select")
            .AddPolicyScheme("select", "select", options => options.ForwardDefaultSelector = context =>
                context.Request.Headers.Authorization.ToString().StartsWith("Bearer sk-", StringComparison.Ordinal) ? "apikey" : "jwt")
            .AddScheme<ApiKeyAuthenticationOptions, ApiKeyAuthenticationHandler>("apikey", _ => { })
            .AddJwtBearer("jwt", options => options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true, ValidIssuer = "test", ValidateAudience = true, ValidAudience = "test",
                ValidateLifetime = true, ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(SigningKey)), ClockSkew = TimeSpan.Zero
            });
        builder.Services.AddAuthorization();
        builder.Services.AddControllers(options =>
        {
            options.Conventions.Add(new SelectedControllers());
            options.Conventions.Add(new DevelopmentStubConvention(environment == "Development" && enabled));
        }).AddApplicationPart(typeof(StubOpenAIController).Assembly);
        builder.Services.AddSingleton<IControllerActivator, IsolatedControllerActivator>();
        await using var app = builder.Build();
        app.UseAuthentication(); app.UseAuthorization(); app.MapControllers();
        await app.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new Uri(app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses.Single()) };
            async Task<HttpResponseMessage> Get(string path, string? token = null)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, path);
                if (token != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                return await client.SendAsync(request);
            }
            async Task<int> Intent(string? token)
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/intent/group-name") { Content = JsonContent.Create(new { snippet = "" }) };
                if (token != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using var response = await client.SendAsync(request);
                return (int)response.StatusCode;
            }
            var active = environment == "Development" && enabled;
            using var anonymous = await Get("/api/v1/stub/v1/models");
            Assert.Equal(active ? 401 : 404, (int)anonymous.StatusCode);
            using var models = await Get("/api/v1/stub/v1/models", StubKey);
            Assert.Equal(active ? 200 : 404, (int)models.StatusCode);
            using var asset = await Get("/api/v1/stub/assets/missing.png");
            Assert.Equal(active ? 401 : 404, (int)asset.StatusCode);
            Assert.Equal(401, await Intent(null));
            Assert.Equal(401, await Intent("sk-retired-test-key"));
            Assert.Equal(400, await Intent(Token())); // Real JWT reaches safe input validation, no model call.
            Assert.Equal(400, await Intent("sk-ak-isolated"));
            revoked = true;
            Assert.Equal(401, await Intent("sk-ak-isolated"));
            using var admin = await Get("/api/debug/resolver/inspect?appCallerCode=", Token());
            Assert.Equal(HttpStatusCode.BadRequest, admin.StatusCode);
            grants = false;
            using var denied = await Get("/api/debug/resolver/inspect?appCallerCode=private", Token());
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            var body = await denied.Content.ReadAsStringAsync();
            Assert.DoesNotContain("apiUrl", body); Assert.DoesNotContain("private", body);
            using var unauthenticated = await Get("/api/debug/resolver/inspect?appCallerCode=private");
            Assert.Equal(HttpStatusCode.Unauthorized, unauthenticated.StatusCode);
        }
        finally { await app.StopAsync(); }
    }

    private static string Token() => new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken("test", "test",
        new[] { new Claim("sub", "owner") }, expires: DateTime.UtcNow.AddMinutes(5),
        signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(SigningKey)), SecurityAlgorithms.HmacSha256)));

    private sealed class SelectedControllers : IApplicationModelConvention
    {
        public void Apply(ApplicationModel model)
        {
            foreach (var controller in model.Controllers.Where(c => c.ControllerType.AsType() != typeof(StubOpenAIController)
                && c.ControllerType.AsType() != typeof(ResolverDebugController) && c.ControllerType.AsType() != typeof(IntentController)).ToArray())
                model.Controllers.Remove(controller);
        }
    }
    private sealed class IsolatedControllerActivator : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var type = context.ActionDescriptor.ControllerTypeInfo.AsType();
            if (type == typeof(StubOpenAIController)) return new StubOpenAIController(null!, context.HttpContext.RequestServices.GetRequiredService<IConfiguration>());
            if (type == typeof(ResolverDebugController)) return new ResolverDebugController(null!, null!, NullLogger<ResolverDebugController>.Instance);
            if (type == typeof(IntentController)) return new IntentController(null!, null!);
            throw new InvalidOperationException("Unapproved controller in isolated test");
        }
        public void Release(ControllerContext context, object controller) { }
    }
}
