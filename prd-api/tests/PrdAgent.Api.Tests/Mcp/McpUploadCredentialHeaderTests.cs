using System.Net;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class McpUploadCredentialHeaderTests
{
    private const string OriginalKey = "sk-ak-synthetic-upload-header-test";

    [Theory]
    [InlineData("Authorization", OriginalKey)]
    [InlineData("Authorization", "Bearer " + OriginalKey)]
    [InlineData("Authorization", "bearer " + OriginalKey)]
    [InlineData("X-AI-Access-Key", OriginalKey)]
    [InlineData("X-AI-Access-Key", "Bearer " + OriginalKey)]
    [InlineData("x-ai-access-key", "bEaReR " + OriginalKey + "  ")]
    public async Task 已支持的鉴权头都能取得绑定同一身份的上传凭证(string header, string value)
    {
        await using var fixture = await Fixture.Start();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/open/web-pages/upload-info");
        request.Headers.TryAddWithoutValidation(header, value);
        using var response = await fixture.Client.SendAsync(request);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var info = await ReadData(response);
        var token = info.GetProperty("uploadToken").GetString()!;
        McpHostedSiteUploadTicket.TryRead(fixture.Protection, token, "POST", "/api/open/web-pages/upload", out var key).ShouldBeTrue();
        key.ShouldBe(OriginalKey);
        (await response.Content.ReadAsStringAsync()).ShouldNotContain(OriginalKey);
    }

    [Theory]
    [InlineData("Bearer ", false)]
    [InlineData("Bearer sk-ak-invalid", false)]
    [InlineData("Bearer eyJhbGciOiJIUzI1NiJ9.invalid.token", false)]
    [InlineData("Bearer " + OriginalKey, true)]
    public async Task 主鉴权头在场时_备用头不能替换空值或其它身份(string primary, bool allowed)
    {
        await using var fixture = await Fixture.Start();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/open/web-pages/upload-info");
        request.Headers.TryAddWithoutValidation("Authorization", primary);
        request.Headers.TryAddWithoutValidation("X-AI-Access-Key", OriginalKey);
        using var response = await fixture.Client.SendAsync(request);
        response.StatusCode.ShouldBe(allowed ? HttpStatusCode.OK : HttpStatusCode.Unauthorized);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void 服务端存在空主头时_解析器不退回备用身份(string primary)
    {
        // HttpClient 会省略空 Authorization，不能靠它构造服务端实际存在的空头。
        var context = new DefaultHttpContext();
        context.Request.Headers.Authorization = primary;
        context.Request.Headers["X-AI-Access-Key"] = OriginalKey;
        context.Request.Headers.ContainsKey("Authorization").ShouldBeTrue();
        ApiKeyCredentialHeaders.Read(context.Request).ShouldBeNull();
    }

    [Fact]
    public async Task 没有凭据时不会签发上传凭证()
    {
        await using var fixture = await Fixture.Start();
        using var response = await fixture.Client.GetAsync("/api/open/web-pages/upload-info");
        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task 两个不同密钥同时在场_签发凭证只包含主头身份()
    {
        await using var fixture = await Fixture.Start();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/open/web-pages/upload-info");
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + OriginalKey);
        request.Headers.TryAddWithoutValidation("X-AI-Access-Key", "sk-ak-another-user-key");
        using var response = await fixture.Client.SendAsync(request);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var info = await ReadData(response);
        McpHostedSiteUploadTicket.TryRead(fixture.Protection, info.GetProperty("uploadToken").GetString()!,
            "POST", "/api/open/web-pages/upload", out var key).ShouldBeTrue();
        key.ShouldBe(OriginalKey);
    }

    [Fact]
    public async Task 备用头取得的短期凭证_仍限制方法路径并核对原密钥撤销()
    {
        await using var fixture = await Fixture.Start();
        using var get = new HttpRequestMessage(HttpMethod.Get, "/api/open/web-pages/upload-info");
        get.Headers.TryAddWithoutValidation("X-AI-Access-Key", OriginalKey);
        using var infoResponse = await fixture.Client.SendAsync(get);
        var info = await ReadData(infoResponse);
        var token = info.GetProperty("uploadToken").GetString()!;

        async Task<HttpStatusCode> Send(HttpMethod method, string path)
        {
            using var request = new HttpRequestMessage(method, path);
            request.Headers.TryAddWithoutValidation("X-AI-Access-Key", "Bearer " + token);
            using var response = await fixture.Client.SendAsync(request);
            return response.StatusCode;
        }

        (await Send(HttpMethod.Post, "/api/open/web-pages/upload")).ShouldBe(HttpStatusCode.OK);
        (await Send(HttpMethod.Get, "/api/open/web-pages/upload")).ShouldBe(HttpStatusCode.Unauthorized);
        (await Send(HttpMethod.Post, "/api/open/web-pages/pages/other/reupload")).ShouldBe(HttpStatusCode.Unauthorized);
        fixture.Revoked = true;
        (await Send(HttpMethod.Post, "/api/open/web-pages/upload")).ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task 实际网关回环转发备用头_下游可以继续签发上传凭证()
    {
        await using var fixture = await Fixture.Start();
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient("McpLoopback")).Returns(fixture.Client);
        var addresses = new ServerAddressesFeature();
        addresses.Addresses.Add("http://localhost");
        var features = new FeatureCollection();
        features.Set<IServerAddressesFeature>(addresses);
        var server = new Mock<IServer>();
        server.SetupGet(x => x.Features).Returns(features);
        var context = new DefaultHttpContext { RequestServices = fixture.App.Services };
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("map.example");
        context.Request.Headers["X-AI-Access-Key"] = "Bearer " + OriginalKey;
        var gateway = new McpGatewayController(null!, factory.Object, server.Object,
            NullLogger<McpGatewayController>.Instance, null!, fixture.Signal)
        { ControllerContext = new ControllerContext { HttpContext = context } };
        var method = typeof(McpGatewayController).GetMethod("LoopbackAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var task = (Task<(int Status, string Body)>)method.Invoke(gateway,
            ["GET", "/api/open/web-pages/upload-info", null, CancellationToken.None])!;
        var result = await task;
        result.Status.ShouldBe(200);
        using var document = JsonDocument.Parse(result.Body);
        var token = document.RootElement.GetProperty("data").GetProperty("uploadToken").GetString()!;
        McpHostedSiteUploadTicket.TryRead(fixture.Protection, token, "POST", "/api/open/web-pages/upload", out var key).ShouldBeTrue();
        key.ShouldBe(OriginalKey);
    }

    private static async Task<JsonElement> ReadData(HttpResponseMessage response)
    {
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        json.RootElement.GetProperty("success").GetBoolean().ShouldBeTrue();
        return json.RootElement.GetProperty("data").Clone();
    }

    private sealed class Fixture : IAsyncDisposable
    {
        public required WebApplication App { get; init; }
        public required HttpClient Client { get; init; }
        public required IDataProtectionProvider Protection { get; init; }
        public required McpLoopbackSignal Signal { get; init; }
        public bool Revoked { get; set; }

        public static async Task<Fixture> Start()
        {
            Fixture? fixture = null;
            var keys = new Mock<IAgentApiKeyService>();
            var key = new AgentApiKey { Id = "header-key", OwnerUserId = "owner", Scopes = ["web-pages:write"] };
            keys.Setup(x => x.LookupByPlaintextAsync(OriginalKey, It.IsAny<CancellationToken>()))
                .ReturnsAsync(() => fixture?.Revoked == true ? null : new AgentApiKeyLookupResult(key, false));
            keys.Setup(x => x.TouchUsageAsync(key.Id, It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
            var permissions = new Mock<IAdminPermissionService>();
            permissions.Setup(x => x.GetEffectivePermissionsAsync("owner", false, It.IsAny<CancellationToken>()))
                .ReturnsAsync(["access", "web-pages.read", "web-pages.write"]);
            var protection = new EphemeralDataProtectionProvider();
            var signal = new McpLoopbackSignal();
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseTestServer();
            builder.Services.AddSingleton<IAgentApiKeyService>(keys.Object);
            builder.Services.AddSingleton<IAdminPermissionService>(permissions.Object);
            builder.Services.AddSingleton<IOpenPlatformService>(Mock.Of<IOpenPlatformService>());
            builder.Services.AddSingleton<IDataProtectionProvider>(protection);
            builder.Services.AddSingleton(signal);
            builder.Services.AddAuthentication("ApiKey")
                .AddScheme<ApiKeyAuthenticationOptions, ApiKeyAuthenticationHandler>("ApiKey", _ => { });
            builder.Services.AddAuthorization(options => options.AddPolicy("web-write",
                policy => policy.RequireAuthenticatedUser().RequireClaim("scope", "web-pages:write")));
            var app = builder.Build();
            app.UseAuthentication();
            app.UseAuthorization();
            app.MapGet("/api/open/web-pages/upload-info", async (HttpContext context) =>
            {
                var controller = new WebPagesOpenApiController(Mock.Of<IHostedSiteService>(), null!)
                { ControllerContext = new ControllerContext { HttpContext = context } };
                var result = (ObjectResult)await controller.GetUploadInfo();
                return Results.Json(result.Value, statusCode: result.StatusCode ?? 200);
            }).RequireAuthorization("web-write");
            app.MapMethods("/api/open/web-pages/upload", ["GET", "POST"], () => Results.Ok()).RequireAuthorization("web-write");
            app.MapPost("/api/open/web-pages/pages/other/reupload", () => Results.Ok()).RequireAuthorization("web-write");
            await app.StartAsync();
            fixture = new Fixture { App = app, Client = app.GetTestClient(), Protection = protection, Signal = signal };
            return fixture;
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await App.DisposeAsync();
        }
    }
}
