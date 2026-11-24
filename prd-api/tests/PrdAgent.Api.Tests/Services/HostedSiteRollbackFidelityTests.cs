using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 回退的前提是这条版本自己的内容能把站点还原成它当时的样子。
/// 多文件站点的 CSS 与图片是对象存储里的旁挂对象，只有整包版本才把它们存了下来；
/// 只有入口 HTML 的版本还原不出来，而下一次整包发布会把旧对象回收掉——那之后按 HTML
/// 回退，得到的是旧 HTML 配着新版本的样式与图片，或者干脆指向已删对象。
/// </summary>
public sealed class HostedSiteRollbackFidelityTests
{
    [Fact]
    public void VerifiedPackage_ShouldAlwaysReproduceTheSite()
    {
        var revision = Revision(verifiedFiles: 3, capturedShape: HostedSiteContentShapes.MultiFile);

        HostedSiteRevisionService.CanReproduceSite(revision, MultiFileSite()).ShouldBeTrue();
    }

    [Fact]
    public void HtmlOnlyRevisionOfASelfContainedSite_ShouldReproduceTheSite()
    {
        var revision = Revision(verifiedFiles: 0, capturedShape: HostedSiteContentShapes.SelfContainedHtml);

        // 站点后来变成多文件也不影响：判的是这条版本建档时的形态。
        HostedSiteRevisionService.CanReproduceSite(revision, MultiFileSite()).ShouldBeTrue();
    }

    [Fact]
    public void HtmlOnlyRevisionOfAMultiFileSite_ShouldNotReproduceTheSite()
    {
        var revision = Revision(verifiedFiles: 0, capturedShape: HostedSiteContentShapes.MultiFile);

        // 站点现在恰好是单文件也不放行：旁挂对象当初就没存下来。
        HostedSiteRevisionService.CanReproduceSite(revision, SelfContainedSite()).ShouldBeFalse();
    }

    [Fact]
    public void RevisionWithoutARecordedShape_ShouldFallBackToTheSitesCurrentShape()
    {
        var revision = Revision(verifiedFiles: 0, capturedShape: null);

        // 存量版本没有记过形态，只能按站点当前形态退让一步。
        HostedSiteRevisionService.CanReproduceSite(revision, SelfContainedSite()).ShouldBeTrue();
        HostedSiteRevisionService.CanReproduceSite(revision, MultiFileSite()).ShouldBeFalse();
    }

    [Fact]
    public void SiteWithNoRegisteredFiles_ShouldNotBeTreatedAsMultiFile()
    {
        // 一个文件都没登记的站点没有旁挂内容会丢。第一版判据直接套 IsSelfContainedHtml，
        // 而那个函数对空文件表也返回 false，于是把这种站点一律拦掉——五条既有回退用例当场变红。
        var revision = Revision(verifiedFiles: 0, capturedShape: null);

        HostedSiteRevisionService.CanReproduceSite(revision, EmptySite()).ShouldBeTrue();
    }

    [Fact]
    public void GeneratedPackageSidecars_ShouldStillCountAsSelfContained()
    {
        // 生成包那六个路径按既有产品语义算自包含：入口 HTML 不靠它们渲染，
        // 替换入口时本来就会一并丢掉，回退不该因为它们被拦。
        var revision = Revision(verifiedFiles: 0, capturedShape: null);

        HostedSiteRevisionService.CanReproduceSite(revision, GeneratedPackageSite()).ShouldBeTrue();
    }

    private static HostedSiteRevision Revision(int verifiedFiles, string? capturedShape) => new()
    {
        Id = "revision-1",
        SiteId = "site-1",
        CreatedByUserId = "user-1",
        Status = HostedSiteRevisionStatuses.Published,
        Html = "<!doctype html><html><body>历史版本</body></html>",
        CapturedContentShape = capturedShape,
        VerifiedFiles = Enumerable.Range(0, verifiedFiles)
            .Select(index => new HostedSiteRevisionFile
            {
                Path = index == 0 ? "index.html" : $"assets/file-{index}.css",
                Content = [1, 2, 3],
                Sha256 = new string('a', 64),
                MimeType = index == 0 ? "text/html" : "text/css",
            })
            .ToList(),
    };

    private static HostedSite SelfContainedSite() => new()
    {
        Id = "site-1",
        OwnerUserId = "user-1",
        EntryFile = "index.html",
        Files = [new HostedSiteFile { Path = "index.html", CosKey = "k/index.html", MimeType = "text/html" }],
    };

    private static HostedSite EmptySite() => new()
    {
        Id = "site-1",
        OwnerUserId = "user-1",
        EntryFile = "index.html",
        Files = [],
    };

    private static HostedSite GeneratedPackageSite() => new()
    {
        Id = "site-1",
        OwnerUserId = "user-1",
        EntryFile = "index.html",
        Files =
        [
            new HostedSiteFile { Path = "assets/accessibility-static-report.json", CosKey = "k/a.json" },
            new HostedSiteFile { Path = "assets/design-tokens.json", CosKey = "k/b.json" },
            new HostedSiteFile { Path = "assets/page-outline.json", CosKey = "k/c.json" },
            new HostedSiteFile { Path = "assets/provenance.json", CosKey = "k/d.json" },
            new HostedSiteFile { Path = "index.html", CosKey = "k/index.html", MimeType = "text/html" },
            new HostedSiteFile { Path = "manifest.json", CosKey = "k/manifest.json" },
        ],
    };

    private static HostedSite MultiFileSite() => new()
    {
        Id = "site-1",
        OwnerUserId = "user-1",
        EntryFile = "index.html",
        Files =
        [
            new HostedSiteFile { Path = "index.html", CosKey = "k/index.html", MimeType = "text/html" },
            new HostedSiteFile { Path = "styles/site.css", CosKey = "k/styles/site.css", MimeType = "text/css" },
            new HostedSiteFile { Path = "images/hero.png", CosKey = "k/images/hero.png", MimeType = "image/png" },
        ],
    };
}
