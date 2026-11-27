using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class McpWebHostingPermissionTests
{
    private static readonly string[] OwnerPermissions = [AdminPermissionCatalog.Access, AdminPermissionCatalog.WebPagesRead];

    [Theory]
    [InlineData(AgentApiKeyScopeMode.Manual, false)]
    [InlineData(AgentApiKeyScopeMode.Auto, false)]
    [InlineData(AgentApiKeyScopeMode.Manual, true)]
    [InlineData(AgentApiKeyScopeMode.Auto, true)]
    public void 旧网页托管授权覆盖完整能力_且随账号的模块权限收回(AgentApiKeyScopeMode mode, bool legacyExposureFlag)
    {
        var key = new AgentApiKey
        {
            ScopeMode = mode,
            WebPublicExposureAllowed = legacyExposureFlag,
            Scopes = [McpCapabilityCatalog.ScopeWebPagesRead],
        };
        var now = DateTime.UtcNow;
        McpCapabilityCatalog.EffectiveScopesForKey(key, OwnerPermissions, now)
            .Where(scope => scope.StartsWith("web-pages:", StringComparison.Ordinal))
            .ShouldBe([McpCapabilityCatalog.ScopeWebPagesWrite]);
        McpCapabilityCatalog.EffectiveScopesForKey(key, [AdminPermissionCatalog.Access], now)
            .ShouldNotContain(McpCapabilityCatalog.ScopeWebPagesWrite);
        McpCapabilityCatalog.AllScopes.ShouldNotContain(McpCapabilityCatalog.ScopeWebPagesPublish);
    }

    [Fact]
    public void 旧公开字段无法单独授权_已撤销的密钥无法执行网页托管操作()
    {
        var key = new AgentApiKey
        {
            ScopeMode = AgentApiKeyScopeMode.Manual,
            Scopes = [McpCapabilityCatalog.ScopeWebPagesPublish],
            WebPublicExposureAllowed = true,
        };
        var now = DateTime.UtcNow;
        McpCapabilityCatalog.EffectiveScopesForKey(key, OwnerPermissions, now).ShouldBeEmpty();
        key.Scopes = [McpCapabilityCatalog.ScopeWebPagesRead];
        key.RevokedAt = now;
        McpCapabilityCatalog.EffectiveScopesForKey(key, OwnerPermissions, now).ShouldBeEmpty();
    }

    [Theory]
    [InlineData("none")]
    [InlineData("write")]
    [InlineData("read")]
    public void 更新授权替换旧标识_同时保留其他授权(string level)
    {
        var key = new AgentApiKey { ScopeMode = AgentApiKeyScopeMode.Manual,
            Scopes = [McpCapabilityCatalog.ScopeWebPagesRead, "agent.example:invoke"] };
        AgentApiKeysController.TryApplyMcpCapabilityAccess(key, OwnerPermissions,
            new Dictionary<string, string> { ["web"] = level }, out var scopes, out _).ShouldBeTrue();
        scopes.ShouldNotContain(McpCapabilityCatalog.ScopeWebPagesRead);
        scopes.ShouldContain("agent.example:invoke");
        scopes.Contains(McpCapabilityCatalog.ScopeWebPagesWrite).ShouldBe(level != "none");
    }

    [Fact]
    public async Task 公开站点可直接领取上传凭证并修改元数据()
    {
        var site = new HostedSite { Id = "s", OwnerUserId = "u", Visibility = "public" };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.GetByIdAsync("s", "u", CancellationToken.None)).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, "u", CancellationToken.None)).ReturnsAsync(true);
        sites.Setup(x => x.UpdateAsync("s", "u", "changed", null, null, null, null, CancellationToken.None)).ReturnsAsync(site);
        using var services = new ServiceCollection()
            .AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider()).BuildServiceProvider();
        var controller = WebController(sites.Object);
        controller.HttpContext.RequestServices = services;
        controller.Request.Headers.Authorization = "Bearer sk-ak-test";
        var upload = Body(await controller.GetUploadInfo("s"));
        upload.GetProperty("uploadUrl").GetString().ShouldEndWith("/api/open/web-pages/pages/s/reupload");
        upload.GetProperty("uploadToken").GetString().ShouldNotBeNullOrWhiteSpace();
        upload.TryGetProperty("requiredAdditionalFormFields", out _).ShouldBeFalse();
        (await controller.UpdatePage("s", new() { Title = "changed" })).ShouldBeOfType<OkObjectResult>();
        sites.VerifyAll();
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task 删除执行站点服务的归属检查(bool allowed)
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.DeleteAsync("s", "u", CancellationToken.None)).ReturnsAsync(allowed);
        var response = await WebController(sites.Object).DeletePage("s", CancellationToken.None);
        if (allowed) Body(response).GetProperty("deleted").GetBoolean().ShouldBeTrue();
        else response.ShouldBeOfType<NotFoundObjectResult>();
        sites.VerifyAll();
    }

    [Theory]
    [InlineData("missing", false, false, "share", false, true)]
    [InlineData("null", false, false, "share", false, true)]
    [InlineData("", false, false, "share", true, true)]
    [InlineData("public", false, false, "share", false, true)]
    [InlineData("logged-in", false, false, "share", true, true)]
    [InlineData("owner-only", false, false, "share", false, false)]
    [InlineData("missing", true, false, "share", false, false)]
    [InlineData("null", false, true, "share", false, false)]
    [InlineData("owner-only", false, true, "visit", false, true)]
    [InlineData("null", false, true, "VISIT", true, true)]
    [InlineData("public", true, true, "visit", false, false)]
    [InlineData("public", false, false, "share", true, true)]
    public async Task 真实Mongo旧分享判据与读取路径一致_缺省公开和访问链不能漏掉(
        string visibility, bool revoked, bool expired, string purpose, bool multiSite, bool external)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"mcp_exposure_{Guid.NewGuid():N}";
        var db = new MongoDbContext(connection, name);
        try
        {
            var share = new WebPageShareLink { CreatedBy = "another-owner", IsRevoked = revoked,
                SiteId = multiSite ? null : "s", SiteIds = multiSite ? ["other", "s"] : [],
                Visibility = visibility, Purpose = purpose,
                ExpiresAt = expired ? DateTime.UtcNow.AddDays(-1) : null };
            var raw = share.ToBsonDocument();
            var visibilityField = BsonClassMap.LookupClassMap(typeof(WebPageShareLink))
                .GetMemberMap(nameof(WebPageShareLink.Visibility)).ElementName;
            if (visibility == "missing") raw.Remove(visibilityField);
            else if (visibility == "null") raw[visibilityField] = BsonNull.Value;
            await db.Database.GetCollection<BsonDocument>("web_page_share_links").InsertOneAsync(raw);
            var site = new HostedSite { Id = "s", OwnerUserId = "u", Visibility = "private" };
            var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
            sites.Setup(x => x.GetByIdAsync("s", "u", It.IsAny<CancellationToken>())).ReturnsAsync(site);
            sites.Setup(x => x.CanEditSiteAsync(site, "u", It.IsAny<CancellationToken>())).ReturnsAsync(true);
            sites.Setup(x => x.CanSetVisibility(site, "u")).Returns(true);
            var data = Body(await WebController(sites.Object, db).GetPageSettings("s", CancellationToken.None));
            data.GetProperty("externalAccess").GetBoolean().ShouldBe(external);
            data.GetProperty("canUpdateContent").GetBoolean().ShouldBeTrue();
            data.GetProperty("requiresExposureConfirmation").GetBoolean().ShouldBeFalse();
            sites.VerifyAll(); sites.VerifyNoOtherCalls();
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }


    private static WebPagesOpenApiController WebController(IHostedSiteService sites, MongoDbContext? db = null)
    {
        Claim[] claims = [new("boundUserId", "u"), new("agentApiKeyId", "k"),
            new("scope", McpCapabilityCatalog.ScopeWebPagesWrite)];
        var context = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(claims, "ApiKey")) };
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("map.example");
        return new WebPagesOpenApiController(sites, db!) { ControllerContext = new() { HttpContext = context } };
    }

    private static JsonElement Body(IActionResult response)
    {
        var result = response.ShouldBeOfType<OkObjectResult>();
        return JsonSerializer.SerializeToElement(result.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            .GetProperty("data");
    }
}
