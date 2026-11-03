using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class McpPublicExposureGrantTests
{
    private static readonly string[] OwnerPermissions = [AdminPermissionCatalog.Access, "web-pages.write"];

    [Theory]
    [InlineData(AgentApiKeyScopeMode.Manual, false, true, false)]
    [InlineData(AgentApiKeyScopeMode.Auto, false, true, false)]
    [InlineData(AgentApiKeyScopeMode.Manual, true, true, true)]
    [InlineData(AgentApiKeyScopeMode.Auto, true, true, true)]
    [InlineData(AgentApiKeyScopeMode.Manual, true, false, false)]
    [InlineData(AgentApiKeyScopeMode.Auto, true, false, false)]
    public void 独立授权不会由自动模式或普通写权限产生_且随当前权限收回(
        AgentApiKeyScopeMode mode, bool enabled, bool hasWrite, bool expected)
    {
        var key = new AgentApiKey { ScopeMode = mode, WebPublicExposureAllowed = enabled,
            Scopes = [McpCapabilityCatalog.ScopeWebPagesWrite, McpCapabilityCatalog.ScopeWebPagesPublish] };
        var scopes = McpCapabilityCatalog.EffectiveScopesForKey(key, hasWrite ? OwnerPermissions : [], DateTime.UtcNow);
        scopes.Contains(McpCapabilityCatalog.ScopeWebPagesPublish).ShouldBe(expected);
        McpCapabilityCatalog.AutoScopesFor([AdminPermissionCatalog.Super]).ShouldNotContain(McpCapabilityCatalog.ScopeWebPagesPublish);
        McpCapabilityCatalog.AllScopes.ShouldNotContain(McpCapabilityCatalog.ScopeWebPagesPublish);
    }

    [Fact]
    public void 存量文档缺授权字段时默认拒绝_失效密钥不能保留发布能力()
    {
        var old = BsonSerializer.Deserialize<AgentApiKey>(new BsonDocument());
        old.WebPublicExposureAllowed.ShouldBeFalse();
        var key = new AgentApiKey { WebPublicExposureAllowed = true, Scopes = [McpCapabilityCatalog.ScopeWebPagesWrite] };
        foreach (var mutation in new Action<AgentApiKey>[] {
            k => k.IsActive = false,
            k => k.RevokedAt = DateTime.UtcNow,
            k => { k.ExpiresAt = DateTime.UtcNow.AddDays(-10); k.GracePeriodDays = 0; } })
        {
            var copy = BsonSerializer.Deserialize<AgentApiKey>(key.ToBson()); mutation(copy);
            McpCapabilityCatalog.EffectiveScopesForKey(copy, OwnerPermissions, DateTime.UtcNow).ShouldBeEmpty();
        }
    }

    [Theory]
    [InlineData("public")]
    [InlineData("logged-in")]
    public async Task 伪造确认参数和资料指纹不能代替独立发布授权(string visibility)
    {
        var site = new HostedSite { Id = "s", OwnerUserId = "u" };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetByIdAsync("s", "u", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanCreateShareAsync(It.IsAny<IReadOnlyCollection<string>>(), "u", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        var gate = new Mock<IHostedSitePrivateSourceGate>(MockBehavior.Strict);
        var controller = WebController(sites.Object, null, gate.Object);
        var result = await controller.CreateShare("s", new() { Visibility = visibility, ExpiresInDays = 0,
            ConfirmedExposure = true, ConfirmedPrivateSourceFingerprint = "psc1:" + new string('a', 64) }, CancellationToken.None);
        Denied(result); gate.VerifyNoOtherCalls();
        sites.VerifyAll(); sites.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task 未授权时即使确认公开_也不能修改可见性()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        Denied(await WebController(sites.Object).SetPageVisibility("s", new() { Visibility = "public", ConfirmedExposure = true }));
        sites.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("public", 0)]
    [InlineData("private", 1)]
    public async Task 已对外站点的上传凭据和内容及元数据更新都需要独立授权(string visibility, long activeShares)
    {
        var site = new HostedSite { Id = "s", OwnerUserId = "u", Visibility = visibility };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetByIdAsync("s", "u", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, "u", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        var links = new Mock<IMongoCollection<WebPageShareLink>>();
        links.Setup(x => x.CountDocumentsAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(),
            It.IsAny<CountOptions>(), It.IsAny<CancellationToken>())).ReturnsAsync(activeShares);
        var controller = WebController(sites.Object, ShareDatabase(links.Object));
        Denied(await controller.GetUploadInfo("s"));
        using var body = new MemoryStream("<h1>changed</h1>"u8.ToArray());
        Denied(await controller.ReuploadFile("s", new FormFile(body, 0, body.Length, "file", "entry.html"), null, null));
        Denied(await controller.UpdatePage("s", new() { Title = "changed" }));
        sites.VerifyAll(); sites.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("public", false)]
    [InlineData("logged-in", false)]
    [InlineData("public", true)]
    public async Task 对外分享修改与续期不能用确认参数越过授权(string visibility, bool renewal)
    {
        var share = new WebPageShareLink { Id = "share", SiteId = "s", CreatedBy = "u", Visibility = visibility };
        var links = ShareCollection(share);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var controller = WebController(sites.Object, ShareDatabase(links.Object));
        var response = renewal
            ? await controller.RenewPageShare("share", new() { ExtendDays = 7, ConfirmedExposure = true })
            : await controller.UpdatePageShare("share", new() { ExpiresInDays = 0, ConfirmedExposure = true });
        Denied(response); sites.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task 关闭独立授权后仍可撤销已有分享()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.RevokeShareAsync("share", "u", "stop", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        var response = await WebController(sites.Object).RevokePageShare("share", new() { Reason = "stop" });
        response.ShouldBeOfType<OkObjectResult>(); sites.VerifyAll();
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(true, false)]
    public async Task 只有服务器验证的同一用户JWT能修改独立授权(bool jwtSucceeded, bool sameUser)
    {
        var service = new Mock<IAgentApiKeyService>(MockBehavior.Strict);
        var permissions = new Mock<IAdminPermissionService>(MockBehavior.Strict);
        var auth = new Mock<IAuthenticationService>();
        auth.Setup(x => x.AuthenticateAsync(It.IsAny<HttpContext>(), JwtBearerDefaults.AuthenticationScheme))
            .ReturnsAsync(jwtSucceeded
                ? AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(
                    [new("sub", sameUser ? "u" : "other")], "Bearer")), "Bearer"))
                : AuthenticateResult.NoResult());
        var context = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new("sub", "u")], "ApiKey")) };
        context.RequestServices = new ServiceCollection().AddSingleton(auth.Object).BuildServiceProvider();
        var key = new AgentApiKey { Id = "k", OwnerUserId = "u", Scopes = [McpCapabilityCatalog.ScopeWebPagesWrite] };
        if (jwtSucceeded && sameUser)
        {
            service.Setup(x => x.GetByIdAsync("k", It.IsAny<CancellationToken>())).ReturnsAsync(key);
            permissions.Setup(x => x.GetEffectivePermissionsAsync("u", false, It.IsAny<CancellationToken>())).ReturnsAsync(OwnerPermissions);
            service.Setup(x => x.UpdateMetadataAsync("k", null, null, null, null, It.IsAny<CancellationToken>(),
                It.IsAny<AgentApiKeyQuotaPatch?>(), null, null, true)).ReturnsAsync(true);
        }
        var controller = new AgentApiKeysController(service.Object, null!, permissions.Object, null!)
            { ControllerContext = new() { HttpContext = context } };
        var response = await controller.Update("k", new() { WebPublicExposureAllowed = true }, CancellationToken.None);
        if (jwtSucceeded && sameUser) response.ShouldBeOfType<OkObjectResult>();
        else { Denied(response); service.VerifyNoOtherCalls(); permissions.VerifyNoOtherCalls(); }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task 真实智能体身份没有用户登录声明时_修改授权明确返回拒绝而不是异常(bool enabled)
    {
        var service = new Mock<IAgentApiKeyService>(MockBehavior.Strict);
        var auth = new Mock<IAuthenticationService>();
        auth.Setup(x => x.AuthenticateAsync(It.IsAny<HttpContext>(), "Bearer")).ReturnsAsync(AuthenticateResult.NoResult());
        var context = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(
            [new("boundUserId", "u"), new("authType", "agent-apikey")], "ApiKey")) };
        context.RequestServices = new ServiceCollection().AddSingleton(auth.Object).BuildServiceProvider();
        var controller = new AgentApiKeysController(service.Object, null!, null!, null!)
            { ControllerContext = new() { HttpContext = context } };
        Denied(await controller.Update("k", new() { WebPublicExposureAllowed = enabled }, CancellationToken.None));
        service.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false, true, true, false)]
    [InlineData(true, false, true, false)]
    [InlineData(false, false, false, true)]
    public async Task 开启授权需当前可用网页写权限_关闭不受降权或停用阻挡(bool hasWrite, bool active, bool enabled, bool allowed)
    {
        var key = new AgentApiKey { Id = "k", OwnerUserId = "u", IsActive = active, WebPublicExposureAllowed = true,
            Scopes = [McpCapabilityCatalog.ScopeWebPagesWrite] };
        var service = new Mock<IAgentApiKeyService>();
        service.Setup(x => x.GetByIdAsync("k", It.IsAny<CancellationToken>())).ReturnsAsync(key);
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(x => x.GetEffectivePermissionsAsync("u", false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(hasWrite ? OwnerPermissions : []);
        var auth = new Mock<IAuthenticationService>();
        var principal = new ClaimsPrincipal(new ClaimsIdentity([new("sub", "u")], "Bearer"));
        auth.Setup(x => x.AuthenticateAsync(It.IsAny<HttpContext>(), "Bearer"))
            .ReturnsAsync(AuthenticateResult.Success(new AuthenticationTicket(principal, "Bearer")));
        var context = new DefaultHttpContext { User = principal };
        context.RequestServices = new ServiceCollection().AddSingleton(auth.Object).BuildServiceProvider();
        var controller = new AgentApiKeysController(service.Object, null!, permissions.Object, null!)
            { ControllerContext = new() { HttpContext = context } };
        var result = await controller.Update("k", new() { WebPublicExposureAllowed = enabled }, CancellationToken.None);
        if (allowed) result.ShouldBeOfType<OkObjectResult>(); else Denied(result);
        service.Verify(x => x.UpdateMetadataAsync("k", null, null, null, null, It.IsAny<CancellationToken>(),
            It.IsAny<AgentApiKeyQuotaPatch?>(), null, null, enabled), allowed ? Times.Once() : Times.Never());
    }

    [Theory]
    [InlineData("PATCH", "/api/web-pages/s/visibility")]
    [InlineData("POST", "/api/web-pages/s/reupload")]
    [InlineData("POST", "/api/web-pages/s/share")]
    [InlineData("PUT", "/api/web-pages/s/?x=1")]
    public void 普通网页后台写接口不能绕过受控开放接口(string method, string path)
        => McpDestructiveActions.IsDestructiveRequest(method, path).ShouldBeTrue();

    [Fact]
    public void 后台读取和正常开放上传不会被误封()
    {
        McpDestructiveActions.IsDestructiveRequest("GET", "/api/web-pages/s").ShouldBeFalse();
        McpDestructiveActions.IsDestructiveRequest("POST", "/api/open/web-pages/upload").ShouldBeFalse();
    }

    [Fact]
    public async Task 授权与配额在一次存储更新中保存_省略授权字段不改变旧授权()
    {
        var collection = new Mock<IMongoCollection<AgentApiKey>>();
        var updates = new List<BsonDocument>();
        collection.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<AgentApiKey>>(),
            It.IsAny<UpdateDefinition<AgentApiKey>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
            .Callback<FilterDefinition<AgentApiKey>, UpdateDefinition<AgentApiKey>, UpdateOptions, CancellationToken>((_, update, _, _) =>
                updates.Add(update.Render(new RenderArgs<AgentApiKey>(BsonSerializer.LookupSerializer<AgentApiKey>(), BsonSerializer.SerializerRegistry)).AsBsonDocument))
            .ReturnsAsync(new UpdateResult.Acknowledged(1, 1, null));
        var db = Database(collection.Object);
        var service = new AgentApiKeyService(db, NullLogger<AgentApiKeyService>.Instance);
        await service.UpdateMetadataAsync("k", null, null, null, null, quota: new(10, 20, 30), webPublicExposureAllowed: true);
        await service.UpdateMetadataAsync("k", "renamed", null, null, null);
        await service.UpdateMetadataAsync("k", null, null, null, null, webPublicExposureAllowed: false);
        updates.Count.ShouldBe(3);
        updates[0]["$set"][nameof(AgentApiKey.WebPublicExposureAllowed)].AsBoolean.ShouldBeTrue();
        updates[0]["$set"][nameof(AgentApiKey.McpDailyWriteQuota)].AsInt32.ShouldBe(20);
        updates[1]["$set"].AsBsonDocument.Contains(nameof(AgentApiKey.WebPublicExposureAllowed)).ShouldBeFalse();
        updates[2]["$set"][nameof(AgentApiKey.WebPublicExposureAllowed)].AsBoolean.ShouldBeFalse();
    }

    internal static WebPagesOpenApiController WebController(IHostedSiteService sites, MongoDbContext? db = null,
        IHostedSitePrivateSourceGate? gate = null, bool granted = false)
    {
        var claims = new List<Claim> { new("boundUserId", "u"), new("agentApiKeyId", "k"), new("scope", McpCapabilityCatalog.ScopeWebPagesWrite) };
        if (granted) claims.Add(new("scope", McpCapabilityCatalog.ScopeWebPagesPublish));
        return new WebPagesOpenApiController(sites, db!, gate) { ControllerContext = new() { HttpContext = new DefaultHttpContext {
            User = new ClaimsPrincipal(new ClaimsIdentity(claims, "ApiKey")) } } };
    }

    internal static void Denied(IActionResult result) => result.ShouldBeOfType<ObjectResult>().StatusCode.ShouldBe(403);

    private static MongoDbContext Database(IMongoCollection<AgentApiKey> collection)
    {
        var database = new Mock<IMongoDatabase>();
        database.Setup(x => x.GetCollection<AgentApiKey>("agent_api_keys", null)).Returns(collection);
        var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(db, database.Object);
        return db;
    }

    private static MongoDbContext ShareDatabase(IMongoCollection<WebPageShareLink> collection)
    {
        var database = new Mock<IMongoDatabase>();
        database.Setup(x => x.GetCollection<WebPageShareLink>("web_page_share_links", null)).Returns(collection);
        var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(db, database.Object);
        return db;
    }

    private static Mock<IMongoCollection<WebPageShareLink>> ShareCollection(WebPageShareLink share)
    {
        var collection = new Mock<IMongoCollection<WebPageShareLink>>();
        collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(),
            It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Returns(() => {
                var cursor = new Mock<IAsyncCursor<WebPageShareLink>>(); cursor.SetupGet(x => x.Current).Returns([share]);
                cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
                return Task.FromResult(cursor.Object);
            });
        return collection;
    }
}
