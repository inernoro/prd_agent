using System.IO.Compression;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class WebPagesOptimizationGateTests
{
    [Fact]
    public async Task CreateOptimizationUpload_ReturnsFixedChunkContractWithoutSavingSite()
    {
        var session = new HostedSiteOptimizationSession
        {
            Id = "session-upload",
            ChunkSize = 2 * 1024 * 1024,
            TotalChunks = 9,
            ExpiresAt = DateTime.UtcNow.AddHours(2),
        };
        var optimization = new Mock<IHostedSiteOptimizationService>();
        optimization.Setup(x => x.CreateUploadAsync(
                "user-1", It.IsAny<CreateHostedSiteOptimizationUploadRequest>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(session);
        var hostedSites = new Mock<IHostedSiteService>();
        var controller = BuildController(hostedSites.Object, optimization.Object, Mock.Of<IUploadProgressService>());

        var result = await controller.CreateOptimizationUpload(new CreateHostedSiteOptimizationUploadRequest
        {
            FileName = "prototype.zip",
            FileSize = 17 * 1024 * 1024,
        });

        var response = result.ShouldBeOfType<OkObjectResult>()
            .Value.ShouldBeOfType<ApiResponse<object>>();
        var created = response.Data.ShouldBeOfType<HostedSiteOptimizationUploadCreatedResult>();
        created.SessionId.ShouldBe("session-upload");
        created.ChunkSize.ShouldBe(2 * 1024 * 1024);
        created.TotalChunks.ShouldBe(9);
        hostedSites.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ReviewedUpload_WhenOptimizationIsRecommended_DoesNotCreateOrReplaceSite()
    {
        var analysis = new HostedSiteOptimizationAnalysis
        {
            Recommended = true,
            OriginalFiles = 6000,
            OptimizedFiles = 10,
        };
        var session = new HostedSiteOptimizationSession
        {
            Id = "session-1",
            OwnerUserId = "user-1",
            Analysis = analysis,
        };
        var optimization = new Mock<IHostedSiteOptimizationService>();
        optimization.Setup(x => x.Analyze(It.IsAny<byte[]>())).Returns(analysis);
        optimization.Setup(x => x.CreateSessionAsync(
                "user-1",
                It.IsAny<byte[]>(),
                "prototype.zip",
                null,
                null,
                null,
                null,
                It.IsAny<List<string>>(),
                analysis,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(session);
        var hostedSites = new Mock<IHostedSiteService>();
        var progress = new Mock<IUploadProgressService>();
        progress.Setup(x => x.CompleteAsync(It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        var controller = BuildController(hostedSites.Object, optimization.Object, progress.Object);

        var result = await controller.UploadReviewed(
            CreateZipFormFile(), null, null, null, null, "upload-1", null);

        var response = result.ShouldBeOfType<OkObjectResult>()
            .Value.ShouldBeOfType<ApiResponse<object>>();
        var review = response.Data.ShouldBeOfType<HostedSiteOptimizationReviewResult>();
        review.Outcome.ShouldBe("optimization-recommended");
        review.SessionId.ShouldBe("session-1");
        hostedSites.Verify(x => x.CreateFromZipAsync(
            It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string?>(),
            It.IsAny<CancellationToken>(), It.IsAny<string?>()), Times.Never);
        hostedSites.Verify(x => x.ReuploadAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(),
            It.IsAny<string?>(), It.IsAny<CancellationToken>(), It.IsAny<string?>()), Times.Never);
    }

    [Fact]
    public async Task PreviewFile_UsesShortLivedProxyAndReturnsPrivateResponse()
    {
        var optimization = new Mock<IHostedSiteOptimizationService>();
        optimization.Setup(x => x.GetPreviewFileAsync(
                "session-1", "secret-token", "assets/app.js", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteOptimizationPreviewFileResult
            {
                Bytes = Encoding.UTF8.GetBytes("console.log('preview')"),
                MimeType = "text/javascript",
            });
        var controller = BuildController(
            Mock.Of<IHostedSiteService>(), optimization.Object, Mock.Of<IUploadProgressService>());

        var result = await controller.GetOptimizationPreviewFile(
            "session-1", "secret-token", "assets/app.js");

        var file = result.ShouldBeOfType<FileContentResult>();
        file.ContentType.ShouldBe("text/javascript");
        Encoding.UTF8.GetString(file.FileContents).ShouldBe("console.log('preview')");
        controller.Response.Headers.CacheControl.ToString().ShouldBe("private, no-store");
        controller.Response.Headers.AccessControlAllowOrigin.ToString().ShouldBe("*");
        controller.Response.Headers["Referrer-Policy"].ToString().ShouldBe("no-referrer");
        optimization.VerifyAll();
    }

    private static WebPagesController BuildController(
        IHostedSiteService hostedSites,
        IHostedSiteOptimizationService optimization,
        IUploadProgressService progress)
    {
        var identity = new ClaimsIdentity(new[] { new Claim("sub", "user-1") }, "test");
        return new WebPagesController(hostedSites, optimization, progress, null!, null!, null!)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(identity),
                },
            },
        };
    }

    private static IFormFile CreateZipFormFile()
    {
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entry = archive.CreateEntry("index.html");
            using var target = entry.Open();
            var bytes = Encoding.UTF8.GetBytes("<html></html>");
            target.Write(bytes, 0, bytes.Length);
        }
        stream.Position = 0;
        return new FormFile(stream, 0, stream.Length, "file", "prototype.zip");
    }
}
