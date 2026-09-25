using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 离线 HTML 下载的两道门：站内走「能编辑这个站点」，分享走 ResolveShareSiteAsync（撤销 / 过期 / 密码）。
/// 门没过时打包服务一次都不许被调用——被调用就意味着存储已经被读过了。
/// </summary>
public sealed class HostedSiteExportControllerTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const string UserId = "viewer-user";

    private static HostedSite Site(string id = "site-a") => new()
    {
        Id = id,
        Title = "季度复盘",
        OwnerUserId = "owner-user",
        EntryFile = "index.html",
        Files = new List<HostedSiteFile>
        {
            new() { Path = "index.html", CosKey = $"web-hosting/sites/{id}/index.html", Size = 64, MimeType = "text/html" },
            new() { Path = "css/app.css", CosKey = $"web-hosting/sites/{id}/css/app.css", Size = 16, MimeType = "text/css" },
        },
    };

    private static (HostedSiteExportController Controller, Mock<IHostedSiteService> Sites, Mock<IHostedSiteOfflineExportService> Exporter)
        Build()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var exporter = new Mock<IHostedSiteOfflineExportService>(MockBehavior.Strict);
        exporter.Setup(x => x.ExportAsync(It.IsAny<HostedSite>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteOfflineExportResult
            {
                Html = Encoding.UTF8.GetBytes("<html></html>"),
                FileName = "季度复盘（离线版）.html",
                InlinedCount = 1,
                Missing = new List<HostedSiteOfflineExportMissing> { new("img/缺.png", "not-in-site") },
            });
        var controller = new HostedSiteExportController(sites.Object, exporter.Object)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", UserId) }, "test")),
                },
            },
        };
        return (controller, sites, exporter);
    }

    private static string ErrorCode(IActionResult result)
    {
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        return JsonSerializer.SerializeToElement(obj.Value, JsonOptions).GetProperty("error").GetProperty("code").GetString()!;
    }

    [Fact]
    public async Task 站内_看不到的站点直接404_不打包()
    {
        var (controller, sites, exporter) = Build();
        sites.Setup(x => x.GetByIdAsync("site-a", UserId, It.IsAny<CancellationToken>())).ReturnsAsync((HostedSite?)null);

        var result = await controller.ExportOwnedSite("site-a");

        Assert.IsType<NotFoundObjectResult>(result);
        exporter.Verify(x => x.ExportAsync(It.IsAny<HostedSite>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task 站内_只读的团队成员看得到站点但不能导出源码()
    {
        var (controller, sites, exporter) = Build();
        var site = Site();
        sites.Setup(x => x.GetByIdAsync("site-a", UserId, It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, UserId, It.IsAny<CancellationToken>())).ReturnsAsync(false);

        var result = await controller.ExportOwnedSite("site-a");

        Assert.IsType<NotFoundObjectResult>(result);
        exporter.Verify(x => x.ExportAsync(It.IsAny<HostedSite>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task 站内_有编辑权时返回附件并在响应头报告缺失资源()
    {
        var (controller, sites, _) = Build();
        var site = Site();
        sites.Setup(x => x.GetByIdAsync("site-a", UserId, It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, UserId, It.IsAny<CancellationToken>())).ReturnsAsync(true);

        var result = await controller.ExportOwnedSite("site-a");

        var file = Assert.IsType<FileContentResult>(result);
        Assert.Equal("text/html; charset=utf-8", file.ContentType);
        Assert.Equal("季度复盘（离线版）.html", file.FileDownloadName);
        var headers = controller.Response.Headers;
        Assert.Equal("1", headers[HostedSiteExportController.MissingCountHeader].ToString());
        Assert.Equal("not-in-site:" + Uri.EscapeDataString("img/缺.png"), headers[HostedSiteExportController.MissingHeader].ToString());
        Assert.Equal("sandbox", headers["Content-Security-Policy"].ToString());
    }

    [Theory]
    [InlineData(404, "not_found", typeof(NotFoundObjectResult), "NOT_FOUND")]            // 已撤销 / 不存在
    [InlineData(400, "expired", typeof(BadRequestObjectResult), "SHARE_EXPIRED")]         // 已过期
    [InlineData(403, "VISIBILITY_DENIED", typeof(ObjectResult), "VISIBILITY_DENIED")]     // 可见性不放行
    [InlineData(401, "UNAUTHORIZED", typeof(ObjectResult), "SHARE_PASSWORD_REQUIRED")]    // 缺密码 / 密码错
    public async Task 分享_门禁不过时不打包(int status, string gateCode, Type resultType, string expectedCode)
    {
        var (controller, sites, exporter) = Build();
        sites.Setup(x => x.ResolveShareSiteAsync("tok", null, null, UserId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Error = "门禁拒绝", HttpStatus = status, ErrorCode = gateCode });

        var result = await controller.ExportSharedSite("tok", null, null);

        Assert.IsType(resultType, result);
        Assert.Equal(expectedCode, ErrorCode(result));
        if (status == 401)
        {
            // 分享密码不对不是登录失效：回 401 会让前端下载器把用户登出
            Assert.Equal(StatusCodes.Status403Forbidden, ((ObjectResult)result).StatusCode);
        }
        exporter.Verify(x => x.ExportAsync(It.IsAny<HostedSite>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task 分享_密码正确时把密码交给同一条门禁并返回附件()
    {
        var (controller, sites, exporter) = Build();
        var site = Site();
        sites.Setup(x => x.ResolveShareSiteAsync("tok", "site-a", "p@ss", UserId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult { Site = site });

        var result = await controller.ExportSharedSite("tok", "site-a", "p@ss");

        Assert.IsType<FileContentResult>(result);
        exporter.Verify(x => x.ExportAsync(site, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task 打包超限时回413与结构化错误码()
    {
        var (controller, sites, exporter) = Build();
        var site = Site();
        sites.Setup(x => x.GetByIdAsync("site-a", UserId, It.IsAny<CancellationToken>())).ReturnsAsync(site);
        sites.Setup(x => x.CanEditSiteAsync(site, UserId, It.IsAny<CancellationToken>())).ReturnsAsync(true);
        exporter.Setup(x => x.ExportAsync(site, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteOfflineExportResult
            {
                Failure = HostedSiteOfflineExportFailure.TooLarge,
                Message = HostedSiteOfflineExportService.DescribeFailure(HostedSiteOfflineExportFailure.TooLarge),
            });

        var result = await controller.ExportOwnedSite("site-a");

        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, obj.StatusCode);
        Assert.Equal("OFFLINE_EXPORT_TOO_LARGE", ErrorCode(result));
    }

    [Fact]
    public async Task 打包服务只按文件清单里的键读存储_越界引用不会变成存储键()
    {
        var storage = new Mock<IAssetStorage>(MockBehavior.Loose);
        var reads = new List<string>();
        var site = Site();
        storage.Setup(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Callback<string, CancellationToken>((key, _) => reads.Add(key))
            .ReturnsAsync((string key, CancellationToken _) => key.EndsWith("index.html", StringComparison.Ordinal)
                ? Encoding.UTF8.GetBytes("<link rel=stylesheet href=\"css/app.css\"><img src=\"../other/secret.png\">")
                : Encoding.UTF8.GetBytes("h1{color:red}"));
        var service = new HostedSiteOfflineExportService(storage.Object, NullLogger<HostedSiteOfflineExportService>.Instance);

        var result = await service.ExportAsync(site);

        Assert.True(result.Succeeded);
        var html = Encoding.UTF8.GetString(result.Html);
        Assert.Contains("<style>h1{color:red}</style>", html);
        Assert.Equal(new[] { "web-hosting/sites/site-a/index.html", "web-hosting/sites/site-a/css/app.css" }, reads);
        Assert.Contains(result.Missing, m => m.Reason == "outside-site-root" && m.Reference == "../other/secret.png");
        Assert.Equal("季度复盘（离线版）.html", result.FileName);
    }

    [Fact]
    public async Task PDF包装站不打包()
    {
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var site = Site();
        site.WrappedAssetType = "pdf";
        var service = new HostedSiteOfflineExportService(storage.Object, NullLogger<HostedSiteOfflineExportService>.Instance);

        var result = await service.ExportAsync(site);

        Assert.Equal(HostedSiteOfflineExportFailure.WrappedAsset, result.Failure);
    }

    [Fact]
    public void 打包服务已在DI注册()
    {
        var program = File.ReadAllText(Path.Combine(RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Program.cs"));
        Assert.Contains(
            "AddScoped<PrdAgent.Core.Interfaces.IHostedSiteOfflineExportService, PrdAgent.Infrastructure.Services.HostedSiteOfflineExportService>()",
            program);
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "CLAUDE.md")) && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException("找不到仓库根");
    }
}
