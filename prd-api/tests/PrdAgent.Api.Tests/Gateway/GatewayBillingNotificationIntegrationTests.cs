using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.LlmGatewayHost;
using PrdAgent.Api.Tests.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>两个真实 HTTP 边界和独立 Mongo；上游只在回环地址返回固定拒绝，不消费供应商额度。</summary>
[Trait("Category", "Integration")]
public class GatewayBillingNotificationIntegrationTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ExplicitBillingRefusal_ReachesMapAndPersistsOneAdminNotice_EvenWhenBackupSucceeds(bool fallbackSucceeds, bool userQuota)
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var provider = builder.Build();
        provider.MapFallback(async http =>
        {
            http.Response.ContentType = "application/json";
            if (http.Request.Path.StartsWithSegments("/primary"))
            {
                http.Response.StatusCode = 403;
                await http.Response.WriteAsync(userQuota
                    ? "{\"error\":{\"code\":\"insufficient_user_quota\",\"type\":\"shell_api_error\",\"message\":\"user [30296] quota [3267] preConsumedQuota [12500] is not enough\"}}"
                    : "{\"error\":{\"code\":\"AccountOverdueError\",\"message\":\"rejected\"}}");
            }
            else await http.Response.WriteAsync("{\"choices\":[{\"message\":{\"content\":\"备用线路完成\"}}]}");
        });
        await provider.StartAsync();
        var providerUrl = Address(provider);
        ModelResolutionResult Route(string name) => new()
        {
            Success = true, ActualModel = name, ActualPlatformId = name, ActualPlatformName = name,
            ApiUrl = providerUrl + "/" + name, ApiKey = "fixture-only", PlatformType = "openai", Protocol = "openai",
        };
        var primary = Route("primary"); if (fallbackSucceeds) primary.RetryCandidates = [Route("backup")];
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(primary);
        resolver.Setup(x => x.RecordFailureAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        resolver.Setup(x => x.RecordSuccessAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        using var services = new ServiceCollection().AddHttpClient().BuildServiceProvider();
        var factory = services.GetRequiredService<IHttpClientFactory>();
        var realGateway = new LlmGateway(resolver.Object, factory, NullLogger<LlmGateway>.Instance);
        var hostBuilder = WebApplication.CreateBuilder(); hostBuilder.Logging.ClearProviders(); hostBuilder.WebHost.UseUrls("http://127.0.0.1:0");
        hostBuilder.Services.AddSingleton<ILlmGateway>(realGateway);
        hostBuilder.Services.AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>();
        GatewayAuthorizedTaskFixture.Register(hostBuilder.Services);
        await using var serving = hostBuilder.Build();
        serving.MapGatewayServingEndpoints(new JsonSerializerOptions { PropertyNamingPolicy = null }, "fixture-gateway", "fixture-commit");
        await serving.StartAsync();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["LlmGateway:ServeBaseUrl"] = Address(serving), ["LlmGwServe:ApiKey"] = "fixture-gateway" }).Build();
        var mapClient = new HttpLlmGatewayClient(factory, configuration, NullLogger<HttpLlmGatewayClient>.Instance,
            failoverNotifier: new PoolFailoverNotifier(db.Context, NullLogger<PoolFailoverNotifier>.Instance),
            taskAuthorizer: GatewayAuthorizedTaskFixture.Outbound);
        using var authorized = GatewayAuthorizedTaskFixture.EnterTask();
        for (var i = 0; i < 2; i++)
        {
            var response = await mapClient.SendAsync(new GatewayRequest
            {
                AppCallerCode = "demo.app::chat", ModelType = "chat",
                RequestBody = new System.Text.Json.Nodes.JsonObject { ["messages"] = new System.Text.Json.Nodes.JsonArray { new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = "fixed fixture" } } },
            });
            Assert.True(response.Success == fallbackSucceeds, response.ErrorMessage);
            if (!fallbackSucceeds) { Assert.Equal(userQuota ? GatewayBillingFailure.QuotaExceeded : GatewayBillingFailure.AccountOverdue, response.ErrorCode); Assert.Contains(userQuota ? "额度" : "账户欠费", response.ErrorMessage); }
            else Assert.Contains("备用线路完成", response.Content);
        }
        var notice = Assert.Single(await db.Context.AdminNotifications.Find(_ => true).ToListAsync());
        Assert.Contains(userQuota ? "额度" : "账户欠费", notice.Title); Assert.Contains("primary", notice.Message);
        Assert.Contains(userQuota ? "检查服务额度" : "补缴费用", notice.Message); Assert.DoesNotContain("fixture-only", notice.Message);
        Assert.Equal("admin", notice.Section); Assert.Null(notice.TargetUserId);
    }

    private static string Address(WebApplication app)
        => app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single().TrimEnd('/');
}
