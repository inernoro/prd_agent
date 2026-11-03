using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Api.Tests.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class McpWebHostingCompletionTests
{
    [Fact]
    public async Task 原始ZIP上传_传原字节给同一站点服务_保留多页面与图片清单()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var original = Zip(("index.html", "<a href='details.html'>next</a>"), ("details.html", "<img src='assets/p.png'>"), ("assets/p.png", "image"));
        var site = new HostedSite { Id = "s", SiteUrl = "https://files.example/s/index.html", Files =
            [new() { Path = "index.html" }, new() { Path = "details.html" }, new() { Path = "assets/p.png" }] };
        byte[]? received = null;
        sites.Setup(x => x.CreateFromZipAsync("u", It.IsAny<Stream>(), "Demo", null, null, null, null,
                It.IsAny<CancellationToken>(), It.IsAny<string?>(), null))
            .Returns((string _, Stream stream, string? _, string? _, string? _, List<string>? _, string? _, CancellationToken ct, string? _, string? _) =>
            {
                ct.ShouldBe(CancellationToken.None);
                using var copy = new MemoryStream(); stream.CopyTo(copy); received = copy.ToArray();
                return Task.FromResult(site);
            });
        var controller = Controller(sites.Object);
        using var input = new MemoryStream(original);
        var response = await controller.UploadFile(new FormFile(input, 0, input.Length, "file", "DEMO.zip"), "Demo", null, null, null, "up", null);
        response.ShouldBeOfType<OkObjectResult>();
        received.ShouldBe(original);
        var body = Body(response);
        body.GetProperty("fileCount").GetInt32().ShouldBe(3);
        body.GetProperty("files")[2].GetProperty("path").GetString().ShouldBe("assets/p.png");
        sites.VerifyAll();
    }

    [Fact]
    public async Task 重传指定原站_不会退化成创建新站()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var site = new HostedSite { Id = "existing", SiteUrl = "https://files.example/existing/index.html" };
        sites.Setup(x => x.GetByIdAsync("existing", "u", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, "u", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        sites.Setup(x => x.ReuploadAsync("existing", "u", It.IsAny<Stream>(), "new.zip", null,
            It.IsAny<CancellationToken>(), null, null)).ReturnsAsync(site);
        var bytes = Zip(("index.html", "updated"));
        using var input = new MemoryStream(bytes);
        var response = await Controller(sites.Object).ReuploadFile("existing", new FormFile(input, 0, input.Length, "file", "new.zip"), null, null);
        Body(response).GetProperty("siteId").GetString().ShouldBe("existing");
        sites.VerifyAll();
        sites.VerifyNoOtherCalls();
    }

    [Fact]
    public void 图片包装_保留原字节_安全编码文件名和标题()
    {
        byte[] bytes = [0, 1, 2, 255, 17];
        var zipBytes = WebPagesController.BuildWrapperZip("demo#1.png", bytes, ".png", "<demo>");
        using var zip = new ZipArchive(new MemoryStream(zipBytes));
        using var source = zip.GetEntry("demo#1.png")!.Open();
        using var content = new MemoryStream(); source.CopyTo(content);
        content.ToArray().ShouldBe(bytes);
        using var entry = new StreamReader(zip.GetEntry("index.html")!.Open());
        var html = entry.ReadToEnd();
        html.ShouldContain("demo%231.png");
        html.ShouldContain("&lt;demo&gt;");
    }

    [Theory]
    [InlineData("image")]
    [InlineData("IMAGE")]
    public void 图片页面没有新增视觉理解能力_即使个人默认开启也不开提问(string type)
    {
        AskAccessPolicy.UnsupportedReason(type).ShouldNotBeNull();
        AskAccessPolicy.IsAskOn(true, type, true).ShouldBeFalse();
        AskAccessPolicy.IsAskOn(null, type, true).ShouldBeFalse();
    }

    [Theory]
    [InlineData(".zip", 0, false)]
    [InlineData(".png", 1, true)]
    [InlineData(".zip", 30408704L, true)]
    [InlineData(".zip", 30408705L, false)]
    [InlineData(".png", 30408704L, true)]
    [InlineData(".png", 30408705L, false)]
    [InlineData(".zip", 1048576000L, false)]
    [InlineData(".html", 524288001L, false)]
    [InlineData(".zip", 5242880001L, false)]
    [InlineData(".exe", 1, false)]
    public void 上传类型和容量_同时遵循直传和共享约束(string extension, long bytes, bool allowed)
        => (WebPagesOpenApiController.ValidateUploadedFile(bytes, extension) == null).ShouldBe(allowed);

    [Fact]
    public async Task 上传指引区分直传与解包上限_为代理预留表单空间()
    {
        var controller = Controller(new Mock<IHostedSiteService>(MockBehavior.Strict).Object);
        controller.Request.Headers.Authorization = "Bearer sk-ak-synthetic-upload-limits";
        controller.HttpContext.RequestServices = new ServiceCollection()
            .AddSingleton<IDataProtectionProvider>(new EphemeralDataProtectionProvider()).BuildServiceProvider();
        var info = Body(await controller.GetUploadInfo());
        info.GetProperty("maxPackageBytes").GetInt64().ShouldBe(29L * 1024 * 1024);
        info.GetProperty("maxSingleFileBytes").GetInt64().ShouldBe(29L * 1024 * 1024);
        info.GetProperty("maxExpandedPackageBytes").GetInt64().ShouldBe(HostedSiteUploadLimits.MaxPackageBytes);
        info.GetProperty("maxExtractedFileBytes").GetInt64().ShouldBe(HostedSiteUploadLimits.MaxSingleFileBytes);
        foreach (var name in new[] { nameof(WebPagesOpenApiController.UploadFile), nameof(WebPagesOpenApiController.ReuploadFile) })
        {
            var method = typeof(WebPagesOpenApiController).GetMethod(name)!;
            ((Microsoft.AspNetCore.Http.Metadata.IRequestSizeLimitMetadata)method.GetCustomAttribute<RequestSizeLimitAttribute>()!)
                .MaxRequestBodySize.ShouldBe(30L * 1024 * 1024);
            method.GetCustomAttribute<RequestFormLimitsAttribute>()!.MultipartBodyLengthLimit.ShouldBe(29L * 1024 * 1024);
        }
    }

    [Fact]
    public async Task 超出直传上限_创建和重传均在调用站点服务前拒绝()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        using var empty = new MemoryStream();
        var file = new FormFile(empty, 0, WebPagesOpenApiController.MaxDirectUploadFileBytes + 1, "file", "large.zip");
        var controller = Controller(sites.Object);
        (await controller.UploadFile(file, null, null, null, null, null, null)).ShouldBeOfType<BadRequestObjectResult>();
        (await controller.ReuploadFile("existing", file, null, null)).ShouldBeOfType<BadRequestObjectResult>();
        sites.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task 公开永久分享_透传零天_团队编辑者按同一分享权限放行()
    {
        var sites = new Mock<IHostedSiteService>();
        var gate = new Mock<IHostedSitePrivateSourceGate>();
        // 创建者不是当前人，但同一服务已判定其团队编辑角色具有分享权。
        var site = new HostedSite { Id = "s", OwnerUserId = "someone-else", Title = "Demo" };
        var share = new WebPageShareLink { Id = "sh", Token = "t", Visibility = "public", ExpiresAt = null };
        sites.Setup(x => x.GetByIdAsync("s", "u", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanCreateShareAsync(It.IsAny<IReadOnlyCollection<string>>(), "u", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        gate.Setup(x => x.EnforceForSitesAsync(It.IsAny<IReadOnlyList<HostedSite>>(), HostedSitePrivateSourceActions.ShareCreate,
            "u", null, CancellationToken.None)).ReturnsAsync(new HostedSitePrivateSourceDecision(HostedSitePrivateSourceVerdict.Allowed, HostedSitePrivateSourceReport.Empty));
        sites.Setup(x => x.CreateShareWithReuseInfoAsync("u", "Tester", "s", null, "single", "Demo", null, null,
            0, CancellationToken.None, "share", false, "public", false, null)).ReturnsAsync((share, false));
        var controller = Controller(sites.Object, gate.Object, UsersDb());
        var response = await controller.CreateShare("s", new() { Visibility = "public", ExpiresInDays = 0, ConfirmedExposure = true }, CancellationToken.None);
        var data = Body(response);
        data.GetProperty("expiresAt").ValueKind.ShouldBe(JsonValueKind.Null);
        data.GetProperty("visibility").GetString().ShouldBe("public");
        sites.Verify(x => x.CreateShareWithReuseInfoAsync("u", "Tester", "s", null, "single", "Demo", null, null,
            0, CancellationToken.None, "share", false, "public", false, null), Times.Once);
        gate.VerifyAll();
    }

    [Theory]
    [InlineData("public", 0, true, true)]
    [InlineData("logged-in", 365, true, true)]
    [InlineData("owner-only", 0, false, true)]
    [InlineData("public", 0, false, false)]
    [InlineData("owner-only", -1, false, false)]
    [InlineData("public", 366, true, false)]
    [InlineData("invalid", 7, true, false)]
    public void 分享设置_不静默改写范围和永久时间(string visibility, int days, bool confirmed, bool allowed)
        => (WebPagesOpenApiController.ValidateShareSettings(visibility, days, confirmed) == null).ShouldBe(allowed);

    [Fact]
    public async Task 公开前必须通过创建者权限_不能靠能读网页就改可见性()
    {
        var sites = new Mock<IHostedSiteService>();
        var gate = new Mock<IHostedSitePrivateSourceGate>(MockBehavior.Strict);
        var site = new HostedSite { Id = "s", OwnerUserId = "other" };
        sites.Setup(x => x.GetByIdAsync("s", "u", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanSetVisibility(site, "u")).Returns(false);
        var response = await Controller(sites.Object, gate.Object).SetPageVisibility("s", new() { Visibility = "public", ConfirmedExposure = true });
        response.ShouldBeOfType<NotFoundObjectResult>();
        gate.VerifyNoOtherCalls();
        sites.Verify(x => x.SetVisibilityAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task 私有资料未确认_阻止公开并返回当前指纹()
    {
        var sites = new Mock<IHostedSiteService>();
        var gate = new Mock<IHostedSitePrivateSourceGate>();
        var site = new HostedSite { Id = "s", OwnerUserId = "u" };
        sites.Setup(x => x.GetByIdAsync("s", "u", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanSetVisibility(site, "u")).Returns(true);
        var report = new HostedSitePrivateSourceReport([new("s", "e", "Private document", "store", "Private", "owner-only")], "psc1:fingerprint", new Dictionary<string, string>());
        gate.Setup(x => x.EnforceForSitesAsync(It.IsAny<IReadOnlyList<HostedSite>>(), HostedSitePrivateSourceActions.SitePublic,
            "u", null, CancellationToken.None)).ReturnsAsync(new HostedSitePrivateSourceDecision(HostedSitePrivateSourceVerdict.ConfirmationRequired, report));
        var response = await Controller(sites.Object, gate.Object).SetPageVisibility("s", new() { Visibility = "public", ConfirmedExposure = true });
        var conflict = response.ShouldBeOfType<ConflictObjectResult>();
        var payload = JsonSerializer.SerializeToElement(conflict.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        payload.GetProperty("data").GetProperty("fingerprint").GetString().ShouldBe("psc1:fingerprint");
        sites.Verify(x => x.SetVisibilityAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public void 原文件传输_不能绕过逻辑工具配额与审计_令牌响应不进普通日志()
    {
        McpBuiltinTools.MatchRouteTemplate("POST", "api/open/web-pages/upload")!.Name.ShouldBe("map_web_publish_page");
        McpBuiltinTools.MatchRouteTemplate("POST", "api/open/web-pages/pages/{id}/reupload")!.Name.ShouldBe("map_web_update_page");
        McpBuiltinTools.MatchRequest("POST", "/api/open/web-pages/pages/s/reupload")!.Name.ShouldBe("map_web_update_page");
        McpUsageService.IsWriteTool(McpBuiltinTools.MatchRequest("POST", "/api/open/web-pages/upload")!).ShouldBeTrue();
        McpBuiltinTools.MatchRouteTemplate("POST", "api/open/web-pages/pages/{id}/something-else").ShouldBeNull();
        RequestLogRedactionProbe.CarriesCredential("/api/open/web-pages/upload-info").ShouldBeTrue();
        McpDestructiveActions.IsDestructiveRequest("DELETE", "/api/web-pages/s").ShouldBeTrue();
    }

    private static WebPagesOpenApiController Controller(IHostedSiteService sites,
        IHostedSitePrivateSourceGate? gate = null, MongoDbContext? db = null)
    {
        var context = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(
            [new("boundUserId", "u"), new("agentApiKeyId", "k")], "ApiKey")) };
        context.Request.Scheme = "https"; context.Request.Host = new HostString("map.example");
        return new WebPagesOpenApiController(sites, db!, gate) { ControllerContext = new ControllerContext { HttpContext = context } };
    }

    private static JsonElement Body(IActionResult response)
    {
        var ok = response.ShouldBeOfType<OkObjectResult>();
        var payload = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        payload.GetProperty("success").GetBoolean().ShouldBeTrue();
        return payload.GetProperty("data");
    }

    private static byte[] Zip(params (string Path, string Text)[] files)
    {
        using var result = new MemoryStream();
        using (var zip = new ZipArchive(result, ZipArchiveMode.Create, true))
            foreach (var file in files) { using var writer = new StreamWriter(zip.CreateEntry(file.Path).Open()); writer.Write(file.Text); }
        return result.ToArray();
    }

    private static MongoDbContext UsersDb()
    {
        var cursor = new Mock<IAsyncCursor<User>>();
        cursor.SetupGet(x => x.Current).Returns([new User { UserId = "u", DisplayName = "Tester" }]);
        cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
        var collection = new Mock<IMongoCollection<User>>();
        collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<User>>(), It.IsAny<FindOptions<User, User>>(), It.IsAny<CancellationToken>())).ReturnsAsync(cursor.Object);
        var database = new Mock<IMongoDatabase>();
        database.Setup(x => x.GetCollection<User>("users", null)).Returns(collection.Object);
        var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(db, database.Object);
        return db;
    }
}

public sealed class McpHostedSiteUploadTicketTests
{
    [Fact]
    public void 上传凭证_限制路径方法到期与完整性_不包含原key()
    {
        var provider = new EphemeralDataProtectionProvider();
        var now = DateTime.UtcNow;
        const string original = "sk-ak-synthetic-file-upload-key";
        var (token, expiry) = McpHostedSiteUploadTicket.Issue(provider, original, "site-one", now);
        token.ShouldNotContain(original);
        expiry.ShouldBe(now.AddMinutes(10));
        McpHostedSiteUploadTicket.TryRead(provider, token, "POST", "/api/open/web-pages/pages/site-one/reupload", out var key, now).ShouldBeTrue();
        key.ShouldBe(original);
        McpHostedSiteUploadTicket.TryRead(provider, token, "POST", "/api/open/web-pages/pages/site-two/reupload", out _, now).ShouldBeFalse();
        McpHostedSiteUploadTicket.TryRead(provider, token, "POST", "/api/open/web-pages/upload", out _, now).ShouldBeFalse();
        McpHostedSiteUploadTicket.TryRead(provider, token, "GET", "/api/open/web-pages/pages/site-one/reupload", out _, now).ShouldBeFalse();
        McpHostedSiteUploadTicket.TryRead(provider, token, "POST", "/api/open/web-pages/pages/site-one/reupload", out _, expiry).ShouldBeFalse();
        McpHostedSiteUploadTicket.TryRead(provider, token[..^4] + "AAAA", "POST", "/api/open/web-pages/pages/site-one/reupload", out _, now).ShouldBeFalse();
    }

    [Fact]
    public async Task 上传凭证_认证继续核对原key_撤销与权限回收即时生效()
    {
        const string original = "sk-ak-synthetic-auth-test-key";
        var keys = new Mock<IAgentApiKeyService>();
        var permissions = new Mock<IAdminPermissionService>();
        var key = new AgentApiKey { Id = "key-one", OwnerUserId = "owner", Scopes = ["web-pages:write"] };
        var revoked = false; var withdrawn = false;
        keys.Setup(x => x.LookupByPlaintextAsync(original, It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => revoked ? null : new AgentApiKeyLookupResult(key, false));
        keys.Setup(x => x.TouchUsageAsync(key.Id, It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        permissions.Setup(x => x.GetEffectivePermissionsAsync("owner", false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => withdrawn ? [] : new[] { "access", "web-pages.read", "web-pages.write" });
        var protection = new EphemeralDataProtectionProvider();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddSingleton<IAgentApiKeyService>(keys.Object);
        builder.Services.AddSingleton<IAdminPermissionService>(permissions.Object);
        builder.Services.AddSingleton<IOpenPlatformService>(Mock.Of<IOpenPlatformService>());
        builder.Services.AddSingleton<IDataProtectionProvider>(protection);
        builder.Services.AddSingleton<McpLoopbackSignal>();
        builder.Services.AddAuthentication("ApiKey").AddScheme<ApiKeyAuthenticationOptions, ApiKeyAuthenticationHandler>("ApiKey", _ => { });
        builder.Services.AddAuthorization(options => options.AddPolicy("upload", p => p.RequireAuthenticatedUser().RequireClaim("scope", "web-pages:write")));
        await using var app = builder.Build();
        app.UseAuthentication(); app.UseAuthorization();
        app.MapPost("/api/open/web-pages/upload", (HttpContext ctx) => Results.Ok(new { keyId = ctx.User.FindFirst("agentApiKeyId")?.Value })).RequireAuthorization("upload");
        await app.StartAsync();
        var token = McpHostedSiteUploadTicket.Issue(protection, original).Token;
        var client = app.GetTestClient(); client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        (await client.PostAsync("/api/open/web-pages/upload", new StringContent("file"))).StatusCode.ShouldBe(HttpStatusCode.OK);
        withdrawn = true;
        (await client.PostAsync("/api/open/web-pages/upload", new StringContent("file"))).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        revoked = true;
        (await client.PostAsync("/api/open/web-pages/upload", new StringContent("file"))).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token[..^4] + "AAAA");
        var invalid = await client.PostAsync("/api/open/web-pages/upload", new StringContent("file"));
        invalid.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        invalid.Headers.GetValues("X-Auth-Diagnosis").Single().ShouldBe(AuthorizationFailureContract.UploadCredentialInvalid);
        var invalidBody = await invalid.Content.ReadAsStringAsync();
        invalidBody.ShouldNotContain(original);
        JsonDocument.Parse(invalidBody).RootElement.GetProperty("error").GetProperty("message").GetString()!.ShouldContain("重新获取上传凭证");
        keys.Verify(x => x.LookupByPlaintextAsync(original, It.IsAny<CancellationToken>()), Times.Exactly(3));
    }
}
