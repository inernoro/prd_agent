using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests;

public sealed class HostedSitePreviewAccessTests
{
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task AccessAndFileReadBindAuthorizedViewerRevisionAndPackage()
    {
        var revision = Revision();
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.GetAsync("site-a", "revision-a", "viewer-user", CancellationToken.None))
            .ReturnsAsync(revision);
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var accessController = Controller(new HostedSitePreviewAccessController(revisions.Object, access), "viewer-user");

        var create = Assert.IsType<OkObjectResult>(await accessController.Create(new("site-a", "revision-a")));
        var data = JsonSerializer.SerializeToElement(create.Value, WebJson).GetProperty("data");
        Assert.True(data.GetProperty("available").GetBoolean());
        var previewUrl = data.GetProperty("previewUrl").GetString()!;
        const string bootstrapPrefix = "/api/hosted-site-preview-files/bootstrap/";
        Assert.StartsWith(bootstrapPrefix, previewUrl, StringComparison.Ordinal);
        var ticket = previewUrl[bootstrapPrefix.Length..];

        var fileController = Controller(new HostedSitePreviewFilesController(revisions.Object, access));
        var accessId = Bootstrap(fileController, ticket);
        revisions.Setup(x => x.GetVerifiedFileAsync(
                "site-a", "revision-a", "assets/app.js", "viewer-user", CancellationToken.None))
            .ReturnsAsync(revision.VerifiedFiles[1]);
        var result = Assert.IsType<FileContentResult>(await fileController.Read(accessId, "assets/app.js"));

        Assert.Equal("application/javascript; charset=utf-8", result.ContentType);
        Assert.Equal("document.body.dataset.ready='yes'", Encoding.UTF8.GetString(result.FileContents));
        Assert.Equal("no-referrer", fileController.Response.Headers["Referrer-Policy"]);
        Assert.Equal("*", fileController.Response.Headers.AccessControlAllowOrigin);
        Assert.Equal("cross-origin", fileController.Response.Headers["Cross-Origin-Resource-Policy"]);
        revisions.Verify(x => x.GetAsync("site-a", "revision-a", "viewer-user", CancellationToken.None), Times.Once);
        revisions.Verify(x => x.GetVerifiedFileAsync(
            "site-a", "revision-a", "assets/app.js", "viewer-user", CancellationToken.None), Times.Once);
    }

    [Fact]
    public async Task SubPathDeployment_ScopesTheTicketToTheExternallyVisiblePath()
    {
        // 子路径部署（API 挂在 /platform 之类前缀下）时，浏览器打开的是
        // /platform/api/hosted-site-preview-files/...。cookie 的 Path 是浏览器那一侧的概念，
        // 写死从根开始就等于签了一张永远不会被带上的票：每个文件 404、预览全白——
        // 比不收窄还糟。同方法里的 redirect 用相对路径本来就是前缀安全的，两者必须同口径。
        var revision = Revision();
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var issued = access.Issue(revision, "viewer-user");
        var controller = Controller(
            new HostedSitePreviewFilesController(revisions.Object, access), pathBase: "/platform");

        var accessId = Bootstrap(controller, issued.Ticket);

        var setCookie = controller.Response.Headers.SetCookie.ToString();
        Assert.Contains(
            $"path=/platform/api/hosted-site-preview-files/{accessId}",
            setCookie,
            StringComparison.OrdinalIgnoreCase);
        // 没有前缀的那一档必须原样不变，前缀只是多出来的一段。
        Assert.DoesNotContain(
            $"path=/api/hosted-site-preview-files/{accessId}",
            setCookie,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task HtmlResponseCarriesOpaqueSandboxPolicy()
    {
        var revision = Revision();
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.GetVerifiedFileAsync(
                "site-a", "revision-a", "index.html", "viewer-user", CancellationToken.None))
            .ReturnsAsync(revision.VerifiedFiles[0]);
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var issued = access.Issue(revision, "viewer-user");
        var controller = Controller(new HostedSitePreviewFilesController(revisions.Object, access));
        var accessId = Bootstrap(controller, issued.Ticket);

        var result = Assert.IsType<FileContentResult>(await controller.Read(accessId, "index.html"));

        Assert.StartsWith("text/html", result.ContentType, StringComparison.OrdinalIgnoreCase);
        var csp = controller.Response.Headers.ContentSecurityPolicy.ToString();
        Assert.Contains("sandbox allow-scripts", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("allow-same-origin", csp, StringComparison.Ordinal);
        Assert.Contains("frame-ancestors 'self'", csp, StringComparison.Ordinal);
        Assert.Equal("private, no-store, max-age=0", controller.Response.Headers.CacheControl);
    }

    // Codex P1（2026-09-15）：拆分部署（admin 与 API 不同源）时前端会显式拼出跨源的预览地址，
    // 而 CSP 写死 frame-ancestors 'self'，浏览器把这块发布前必看的核对面板整片挡成空白。
    // 可嵌入来源改跟已声明的 Cors:AllowedOrigins 同一份名单走。
    [Fact]
    public async Task ConfiguredAdminOriginMayFrameTheVerifiedPreview()
    {
        var embed = HostedSitePreviewEmbedOptions.FromConfiguration(
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Cors:AllowedOrigins:0"] = "https://admin.example.test",
                ["Cors:AllowedOrigins:1"] = "https://admin.example.test:8443/ignored/path",
                ["Cors:AllowedOrigins:2"] = "not-a-url",
                ["Cors:AllowedOrigins:3"] = "ftp://admin.example.test",
            }).Build());
        Assert.Equal(
            new[] { "https://admin.example.test", "https://admin.example.test:8443" },
            embed.FrameAncestors);

        var revision = Revision();
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.GetVerifiedFileAsync(
                "site-a", "revision-a", "index.html", "viewer-user", CancellationToken.None))
            .ReturnsAsync(revision.VerifiedFiles[0]);
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var issued = access.Issue(revision, "viewer-user");
        var controller = Controller(new HostedSitePreviewFilesController(revisions.Object, access, embed));
        controller.Request.Headers["Sec-Fetch-Site"] = "cross-site";
        // 跨站 iframe 里 Strict / Lax 的 cookie 浏览器一律不带，CSP 放行了也照样空白。
        var accessId = Bootstrap(controller, issued.Ticket, expectedSameSite: "none");

        Assert.IsType<FileContentResult>(await controller.Read(accessId, "index.html"));
        var csp = controller.Response.Headers.ContentSecurityPolicy.ToString();
        Assert.Contains(
            "frame-ancestors 'self' https://admin.example.test https://admin.example.test:8443",
            csp,
            StringComparison.Ordinal);
    }

    // 单源部署（没配 Cors:AllowedOrigins）必须原样不变：只许同源嵌入、cookie 维持 Strict。
    [Fact]
    public void SingleOriginDeploymentKeepsSelfOnlyFramingAndStrictCookie()
    {
        Assert.Empty(HostedSitePreviewEmbedOptions.FromConfiguration(new ConfigurationBuilder().Build()).FrameAncestors);
        Assert.EndsWith(
            "frame-ancestors 'self'",
            HostedSitePreviewFilesController.BuildContentSecurityPolicy(HostedSitePreviewEmbedOptions.SelfOnly),
            StringComparison.Ordinal);

        var revision = Revision();
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var issued = access.Issue(revision, "viewer-user");
        var controller = Controller(new HostedSitePreviewFilesController(
            new Mock<IHostedSiteRevisionService>(MockBehavior.Strict).Object, access));
        controller.Request.Headers["Sec-Fetch-Site"] = "cross-site";
        // Bootstrap 内部断言 samesite=strict：拿不到 Sec-Fetch-Site 的信任面就不该放宽。
        Bootstrap(controller, issued.Ticket);
    }

    [Fact]
    public async Task PackageMutationInvalidatesIssuedTicket()
    {
        var revision = Revision();
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var issued = access.Issue(revision, "viewer-user");
        revision.VerifiedFiles[1].Content = Encoding.UTF8.GetBytes("mutated");
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.GetVerifiedFileAsync(
                "site-a", "revision-a", "assets/app.js", "viewer-user", CancellationToken.None))
            .ReturnsAsync(revision.VerifiedFiles[1]);
        var controller = Controller(new HostedSitePreviewFilesController(revisions.Object, access));
        var accessId = Bootstrap(controller, issued.Ticket);

        Assert.IsType<NotFoundObjectResult>(await controller.Read(accessId, "assets/app.js"));
    }

    [Theory]
    [InlineData("../index.html")]
    [InlineData("manifest.json")]
    [InlineData("assets/../index.html")]
    [InlineData("assets/app.js?x=1")]
    public async Task NonPublicPathsAreRejectedBeforeRevisionRead(string path)
    {
        var revision = Revision();
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var issued = access.Issue(revision, "viewer-user");
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var controller = Controller(new HostedSitePreviewFilesController(revisions.Object, access));
        var accessId = Bootstrap(controller, issued.Ticket);

        Assert.IsType<NotFoundObjectResult>(await controller.Read(accessId, path));
        revisions.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task FinalResourcePathNeedsHttpOnlyCookieAndDoesNotExposeTicket()
    {
        var revision = Revision();
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var issued = access.Issue(revision, "viewer-user");
        Assert.True(access.TryRead(issued.Ticket, out var payload));
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var controller = Controller(new HostedSitePreviewFilesController(revisions.Object, access));

        Assert.IsType<NotFoundObjectResult>(await controller.Read(payload.AccessId, "index.html"));
        Assert.DoesNotContain(issued.Ticket, payload.AccessId, StringComparison.Ordinal);
        revisions.VerifyNoOtherCalls();
    }

    [Fact]
    public void ExpiredAndTamperedTicketsAreRejected()
    {
        var revision = Revision();
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var now = new DateTime(2026, 9, 10, 0, 0, 0, DateTimeKind.Utc);
        var issued = access.Issue(revision, "viewer-user", now);

        Assert.False(access.TryRead(issued.Ticket, out _, now.Add(HostedSitePreviewAccessService.Lifetime)));
        Assert.False(access.TryRead(issued.Ticket + "tampered", out _, now));
        var controller = Controller(new HostedSitePreviewFilesController(
            Mock.Of<IHostedSiteRevisionService>(), access));
        Assert.IsType<NotFoundObjectResult>(controller.Bootstrap(issued.Ticket + "tampered"));
    }

    [Fact]
    public async Task LegacySingleFileRevisionUsesExistingStaticPreview()
    {
        var revision = Revision();
        revision.VerifiedFiles = [];
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.GetAsync("site-a", "revision-a", "viewer-user", CancellationToken.None))
            .ReturnsAsync(revision);
        var access = new HostedSitePreviewAccessService(new EphemeralDataProtectionProvider());
        var controller = Controller(new HostedSitePreviewAccessController(revisions.Object, access), "viewer-user");

        var result = Assert.IsType<OkObjectResult>(await controller.Create(new("site-a", "revision-a")));
        var data = JsonSerializer.SerializeToElement(result.Value, WebJson).GetProperty("data");
        Assert.False(data.GetProperty("available").GetBoolean());
    }

    private static HostedSiteRevision Revision()
    {
        var html = File("index.html", "text/html; charset=utf-8", "<!doctype html><html><body><script src=\"assets/app.js\"></script></body></html>");
        var script = File("assets/app.js", "application/javascript; charset=utf-8", "document.body.dataset.ready='yes'");
        return new HostedSiteRevision
        {
            Id = "revision-a",
            SiteId = "site-a",
            CreatedByUserId = "author-user",
            Html = Encoding.UTF8.GetString(html.Content),
            VerifiedFiles = [html, script],
        };
    }

    private static HostedSiteRevisionFile File(string path, string mimeType, string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return new HostedSiteRevisionFile
        {
            Path = path,
            MimeType = mimeType,
            Content = bytes,
            Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
        };
    }

    private static T Controller<T>(T controller, string? userId = null, string pathBase = "")
        where T : ControllerBase
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        if (pathBase.Length > 0) context.Request.PathBase = pathBase;
        if (userId != null)
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim("sub", userId)],
                "test"));
        controller.ControllerContext = new ControllerContext { HttpContext = context };
        return controller;
    }

    private static string Bootstrap(
        HostedSitePreviewFilesController controller,
        string ticket,
        string expectedSameSite = "strict")
    {
        var redirect = Assert.IsType<RedirectResult>(controller.Bootstrap(ticket));
        const string prefix = "../";
        Assert.StartsWith(prefix, redirect.Url, StringComparison.Ordinal);
        Assert.EndsWith("/index.html", redirect.Url, StringComparison.Ordinal);
        var accessId = redirect.Url![prefix.Length..^"/index.html".Length];
        Assert.DoesNotContain(ticket, redirect.Url, StringComparison.Ordinal);
        var setCookie = controller.Response.Headers.SetCookie.ToString();
        Assert.Contains("HttpOnly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains($"samesite={expectedSameSite}", setCookie, StringComparison.OrdinalIgnoreCase);
        // 票据只跟着自己这条预览的资源请求走。Path=/ 时，15 分钟寿命内签发过的每一张票据都会
        // 附在打到本域名的所有请求上——翻几十个版本就能把 cookie 与请求头堆到上限，打坏的是
        // 与预览无关的普通接口，而且要等 cookie 过期才恢复（Codex P2，2026-09-16）。
        // cookie 的 Path 是浏览器看到的那条路径：子路径部署时必须带上 PathBase，
        // 否则签出去的票永远不会被带上，每个文件 404、预览全白。
        Assert.Contains(
            $"path={controller.Request.PathBase}/api/hosted-site-preview-files/{accessId}",
            setCookie,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("path=/;", setCookie, StringComparison.OrdinalIgnoreCase);
        controller.Request.Headers.Cookie = setCookie.Split(';', 2)[0];
        return accessId;
    }
}
