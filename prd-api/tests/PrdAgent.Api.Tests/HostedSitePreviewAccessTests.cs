using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
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

    private static T Controller<T>(T controller, string? userId = null) where T : ControllerBase
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        if (userId != null)
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim("sub", userId)],
                "test"));
        controller.ControllerContext = new ControllerContext { HttpContext = context };
        return controller;
    }

    private static string Bootstrap(HostedSitePreviewFilesController controller, string ticket)
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
        Assert.Contains("samesite=strict", setCookie, StringComparison.OrdinalIgnoreCase);
        controller.Request.Headers.Cookie = setCookie.Split(';', 2)[0];
        return accessId;
    }
}
