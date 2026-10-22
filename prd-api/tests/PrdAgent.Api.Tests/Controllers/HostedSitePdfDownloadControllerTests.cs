using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class HostedSitePdfDownloadControllerTests
{
    private const string PdfPath = "downloads/教材.pdf";
    private static HostedSite Site() => new()
    {
        Id = "site-a", Files = new()
        {
            new() { Path = PdfPath, CosKey = "web-hosting/sites/site-a/.versions/v1/guide.pdf", MimeType = "application/pdf", Size = 14 },
            new() { Path = "index.html", CosKey = "web-hosting/sites/site-a/index.html", MimeType = "text/html", Size = 10 },
        },
    };

    private static (HostedSitePdfDownloadController Controller, Mock<IHostedSiteService> Sites, Mock<IAssetStorage> Storage)
        Build(bool authenticated = false)
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.BuildSiteKey(It.IsAny<string>(), It.IsAny<string>()))
            .Returns((string id, string path) => $"web-hosting/sites/{id}/{path}");
        var controller = new HostedSitePdfDownloadController(sites.Object, storage.Object,
            NullLogger<HostedSitePdfDownloadController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        if (authenticated)
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "viewer") }, "test"));
        return (controller, sites, storage);
    }

    [Fact]
    public async Task PublicShare_DownloadsRegisteredPdfByStoredKey_WithSafeAttachmentHeaders()
    {
        var (controller, sites, storage) = Build();
        sites.Setup(x => x.ResolveShareSiteAsync("share", "site-a", null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Site = Site() });
        var pdf = Encoding.ASCII.GetBytes("%PDF-1.7\nbody");
        storage.Setup(x => x.TryDownloadBytesAsync("web-hosting/sites/site-a/.versions/v1/guide.pdf", It.IsAny<CancellationToken>())).ReturnsAsync(pdf);

        var result = Assert.IsType<FileContentResult>(await controller.DownloadSharedPdf("share", "site-a", PdfPath));

        Assert.Equal(pdf, result.FileContents);
        Assert.Equal("教材.pdf", result.FileDownloadName);
        Assert.Equal("application/pdf", result.ContentType);
        Assert.Equal("nosniff", controller.Response.Headers["X-Content-Type-Options"]);
        Assert.Equal("private, no-store", controller.Response.Headers.CacheControl);
        storage.VerifyAll();
        Assert.Equal(new[] { PdfPath }, HostedSitePdfFiles.Paths(Site()));
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(404)]
    [InlineData(429)]
    public async Task SharedGateFailure_DoesNotReadStorage_AndPasswordFailureCannotLogOutParent(int status)
    {
        var (controller, sites, storage) = Build(true);
        sites.Setup(x => x.ResolveShareSiteAsync("share", "site-a", "password", "viewer", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Error = "分享不可用", HttpStatus = status, ErrorCode = "DENIED", RetryAfterSeconds = 30 });

        var result = Assert.IsAssignableFrom<ObjectResult>(await controller.DownloadSharedPdf("share", "site-a", PdfPath, "password"));

        Assert.Equal(status == 401 ? 403 : status, result.StatusCode);
        Assert.Equal("30", controller.Response.Headers.RetryAfter);
        storage.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("https://attacker.example/guide.pdf")]
    [InlineData("../other/guide.pdf")]
    [InlineData("downloads/../guide.pdf")]
    [InlineData("downloads/other.pdf")]
    [InlineData("index.html")]
    [InlineData("downloads/教材.pdf?url=other")]
    public async Task UnregisteredOrNonPdfPath_IsRejectedWithoutStorageRead(string path)
    {
        var (controller, sites, storage) = Build();
        sites.Setup(x => x.ResolveShareSiteAsync("share", "site-a", null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Site = Site() });

        Assert.IsType<NotFoundObjectResult>(await controller.DownloadSharedPdf("share", "site-a", path));

        storage.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task OwnedReadOnlyViewer_CannotDownload()
    {
        var (controller, sites, storage) = Build(true);
        var site = Site();
        sites.Setup(x => x.GetByIdAsync("site-a", "viewer", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, "viewer", It.IsAny<CancellationToken>())).ReturnsAsync(false);
        Assert.IsType<NotFoundObjectResult>(await controller.DownloadOwnedPdf("site-a", PdfPath));
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task OwnedEditor_CanDownloadButHtmlDisguisedAsPdfIsRejected()
    {
        var (controller, sites, storage) = Build(true);
        var site = Site();
        sites.Setup(x => x.GetByIdAsync("site-a", "viewer", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, "viewer", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        storage.Setup(x => x.TryDownloadBytesAsync("web-hosting/sites/site-a/.versions/v1/guide.pdf", It.IsAny<CancellationToken>()))
            .ReturnsAsync(Encoding.UTF8.GetBytes("<html>not pdf</html>"));
        Assert.IsType<NotFoundObjectResult>(await controller.DownloadOwnedPdf("site-a", PdfPath));
    }

    [Theory]
    [InlineData("web-hosting/sites/other-site/guide.pdf")]
    [InlineData("web-hosting/sites/site-a/../other-site/guide.pdf")]
    public async Task RegisteredKeyOutsideCurrentSite_IsRejectedBeforeStorageRead(string key)
    {
        var (controller, sites, storage) = Build();
        var site = Site(); site.Files[0].CosKey = key;
        sites.Setup(x => x.ResolveShareSiteAsync("share", "site-a", null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Site = site });
        Assert.IsType<NotFoundObjectResult>(await controller.DownloadSharedPdf("share", "site-a", PdfPath));
        storage.Verify(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task MetadataOverDownloadBudget_IsRejectedBeforeAllocatingPdfBytes()
    {
        var (controller, sites, storage) = Build();
        var site = Site(); site.Files[0].Size = HostedSitePdfDownloadController.MaxPdfDownloadBytes + 1;
        sites.Setup(x => x.ResolveShareSiteAsync("share", "site-a", null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Site = site });
        var result = Assert.IsType<ObjectResult>(await controller.DownloadSharedPdf("share", "site-a", PdfPath));
        Assert.Equal(413, result.StatusCode);
        storage.Verify(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task StorageFailure_ReturnsRecoverableError()
    {
        var (controller, sites, storage) = Build();
        sites.Setup(x => x.ResolveShareSiteAsync("share", "site-a", null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Site = Site() });
        storage.Setup(x => x.TryDownloadBytesAsync("web-hosting/sites/site-a/.versions/v1/guide.pdf", It.IsAny<CancellationToken>()))
            .ThrowsAsync(new IOException("internal storage detail"));
        var result = Assert.IsType<ObjectResult>(await controller.DownloadSharedPdf("share", "site-a", PdfPath));
        Assert.Equal(503, result.StatusCode);
        Assert.DoesNotContain("internal storage detail", System.Text.Json.JsonSerializer.Serialize(result.Value));
    }
}
