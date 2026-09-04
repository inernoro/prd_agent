using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class HostedSiteOptimizationServiceTests
{
    [Theory]
    [InlineData("web-hosting/sites/0123456789abcdef0123456789abcdef/__chunks/000000.part", null, true)]
    [InlineData("data/web-hosting/sites/0123456789abcdef0123456789abcdef/__source/source.zip", "data", true)]
    [InlineData("data/web-hosting/sites/0123456789abcdef0123456789abcdef/__preview/assets/app.js", "data", true)]
    [InlineData("data/web-hosting/sites/0123456789abcdef0123456789abcdef/index.html", "data", false)]
    [InlineData("data/web-hosting/sites/not-a-session/__source/source.zip", "data", false)]
    [InlineData("data/web-hosting/sites/0123456789abcdef0123456789abcdef/__chunks/all.part", "data", false)]
    [InlineData("data/web-hosting/sites/0123456789abcdef0123456789abcdef/__preview/../index.html", "data", false)]
    public void TemporaryDeletePolicy_AllowsOnlyOptimizerOwnedObjectShapes(
        string key,
        string? prefix,
        bool expected)
    {
        AssetStorageDeletePolicy.IsHostedSiteOptimizationTemporaryKey(key, prefix).ShouldBe(expected);
    }

    [Fact]
    public void PreviewProxy_UsesSeparateStorageScopeAndConstantTimeTokenGate()
    {
        var session = new PrdAgent.Core.Models.HostedSiteOptimizationSession
        {
            Id = "11111111111111111111111111111111",
            TemporaryStorageId = "22222222222222222222222222222222",
            PreviewAccessToken = new string('a', 64),
        };

        var url = HostedSiteOptimizationService.BuildPreviewProxyUrl(session, "assets/app.js");

        url.ShouldContain(session.Id);
        url.ShouldContain(session.PreviewAccessToken);
        url.ShouldNotContain(session.TemporaryStorageId);
        HostedSiteOptimizationService.StorageScope(session).ShouldBe(session.TemporaryStorageId);
        HostedSiteOptimizationService.SecretEquals(session.PreviewAccessToken, new string('a', 64)).ShouldBeTrue();
        HostedSiteOptimizationService.SecretEquals(session.PreviewAccessToken, new string('b', 64)).ShouldBeFalse();
    }

    [Fact]
    public void Analyze_CleanRuntimePackage_DoesNotInterruptUpload()
    {
        var zip = CreateZip(new Dictionary<string, string>
        {
            ["index.html"] = "<html><script src=\"./app.js\"></script></html>",
            ["app.js"] = "document.body.dataset.ready = 'true';",
        });

        var result = CreateService().Analyze(zip);

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeFalse();
        result.OriginalFiles.ShouldBe(2);
    }

    [Fact]
    public void Analyze_FirstHtmlFallback_RemainsHostableWithoutIndexName()
    {
        var result = CreateService().Analyze(CreateZip(new Dictionary<string, string>
        {
            ["slides.html"] = "<main>slides</main>",
        }));

        result.Blocked.ShouldBeFalse();
        result.OriginalFiles.ShouldBe(1);
    }

    [Fact]
    public void Analyze_CleanPackageAboveOptimizationTarget_RemainsHostable()
    {
        var files = new Dictionary<string, string> { ["index.html"] = "<main>ready</main>" };
        for (var index = 0; index < 5000; index++)
            files[$"assets/{index:D4}.txt"] = "x";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeFalse();
        result.OriginalFiles.ShouldBe(5001);
    }

    [Fact]
    public void Analyze_LargeNodeModulesTree_RecommendsConservativeOptimization()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<html><script src=\"https://unpkg.com/demo@1.0.0/dist/demo.js\"></script></html>",
            ["node_modules/demo/dist/demo.js"] = "window.demo = true;",
            ["node_modules/demo/LICENSE"] = "sample license",
        };
        for (var index = 0; index < 150; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.NodeModulesFiles.ShouldBe(152);
        result.LocalizedDependencies.ShouldBe(1);
        result.OptimizedFiles.ShouldBe(3);
    }

    [Fact]
    public void Analyze_NodeModulesLargerThanRuntimeScanBudget_PrunesBeforeBudgetCheck()
    {
        var result = CreateService().Analyze(CreateNodeModulesHeavyZip());

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.NodeModulesFiles.ShouldBe(105);
        result.OriginalFiles.ShouldBe(107);
        result.OptimizedFiles.ShouldBe(2);
    }

    [Fact]
    public void Analyze_StaticRuntimeFetchIntoNodeModules_RestoresRequiredDependency()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<html><script src=\"./app.js\"></script></html>",
            ["app.js"] = "fetch('./node_modules/pkg/data.json').then(response => response.json());",
            ["node_modules/pkg/data.json"] = "{\"ready\":true}",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(3);
    }

    [Fact]
    public void Analyze_UnquotedHtmlResourceAttribute_RestoresRequiredDependency()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<script src=./node_modules/pkg/app.js></script><img srcset=./node_modules/pkg/a.png><main style=background:url(./node_modules/pkg/bg.png)></main>",
            ["node_modules/pkg/app.js"] = "document.body.dataset.ready = 'true';",
            ["node_modules/pkg/a.png"] = "image",
            ["node_modules/pkg/bg.png"] = "background",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(4);
    }

    [Fact]
    public void Analyze_UnquotedHtmlBaseHref_ResolvesDependencyFromEffectiveBase()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<base href=./assets/><script src=app.js></script>",
            ["assets/app.js"] = "document.body.dataset.ready = 'true';",
        };

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.OriginalFiles.ShouldBe(2);
    }

    [Fact]
    public void Analyze_RestoredDependencyWithComputedLoader_PreservesDependencyTree()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<script src=\"./node_modules/pkg/runtime.js\"></script>",
            ["node_modules/pkg/runtime.js"] = "const path = './asset.json'; fetch(path);",
            ["node_modules/pkg/asset.json"] = "{\"ready\":true}",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeFalse();
        result.OptimizedFiles.ShouldBe(result.OriginalFiles);
        result.Warnings.ShouldContain(x => x.Contains("依赖脚本", StringComparison.Ordinal));
    }

    [Fact]
    public void Analyze_ServiceWorkerRegistrationIntoNodeModules_RestoresRequiredDependency()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<html><script src=\"./app.js\"></script></html>",
            ["app.js"] = "navigator.serviceWorker.register('./node_modules/pkg/sw.js');",
            ["node_modules/pkg/sw.js"] = "self.addEventListener('fetch', () => {});",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(3);
    }

    [Fact]
    public void Analyze_ComputedRuntimeLoader_PreservesPotentialDependencies()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<html><script src=\"./app.js\"></script></html>",
            ["app.js"] = "const path = './node_modules/pkg/data.json'; fetch(path);",
            ["node_modules/pkg/data.json"] = "{\"ready\":true}",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeFalse();
        result.OptimizedFiles.ShouldBe(result.OriginalFiles);
        result.Warnings.ShouldContain(x => x.Contains("保留所有潜在依赖", StringComparison.Ordinal));
    }

    [Fact]
    public void Analyze_ComputedImportAndRequire_PreservePotentialDependencies()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<html><script src=\"./app.js\"></script></html>",
            ["app.js"] = "const first = './node_modules/pkg/a.js'; import(first); const second = './node_modules/pkg/b.js'; require(second);",
            ["node_modules/pkg/a.js"] = "export default true;",
            ["node_modules/pkg/b.js"] = "module.exports = true;",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeFalse();
        result.OptimizedFiles.ShouldBe(result.OriginalFiles);
        result.Warnings.ShouldContain(x => x.Contains("保留所有潜在依赖", StringComparison.Ordinal));
    }

    [Fact]
    public void Analyze_InlineRuntimeFetch_RestoresRequiredDependency()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<script>fetch('./node_modules/pkg/data.json')</script>",
            ["node_modules/pkg/data.json"] = "{\"ready\":true}",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(2);
    }

    [Fact]
    public void Analyze_NonUtf8RuntimeText_PreservesOriginalBytesAndDependencies()
    {
        var files = new Dictionary<string, byte[]>
        {
            ["index.html"] = new byte[] { 0xff, 0xfe, 0x3c, 0x68, 0x31, 0x3e },
            ["node_modules/pkg/data.json"] = Encoding.UTF8.GetBytes("{}"),
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = Encoding.UTF8.GetBytes("export default true;");

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeFalse();
        result.OptimizedFiles.ShouldBe(result.OriginalFiles);
        result.Warnings.ShouldContain(x => x.Contains("保留所有潜在依赖", StringComparison.Ordinal));
    }

    [Fact]
    public void Analyze_NonUtf8Stylesheet_PreservesPotentialDependencies()
    {
        var files = new Dictionary<string, byte[]>
        {
            ["index.html"] = Encoding.UTF8.GetBytes("<link rel=\"stylesheet\" href=\"./styles.css\">") ,
            ["styles.css"] = new byte[] { 0x80, 0x81, 0x82 },
            ["node_modules/pkg/font.woff"] = new byte[] { 0x01, 0x02 },
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = Encoding.UTF8.GetBytes("export default true;");

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeFalse();
        result.OptimizedFiles.ShouldBe(result.OriginalFiles);
        result.Warnings.ShouldContain(x => x.Contains("保留所有潜在依赖", StringComparison.Ordinal));
    }

    [Fact]
    public void Analyze_InlineStyleAndSrcSet_RestoreRequiredDependencies()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<main style=\"background:url('./node_modules/pkg/bg.png')\"><img srcset=\"./node_modules/pkg/a.png 1x, ./node_modules/pkg/b.png 2x\"></main>",
            ["node_modules/pkg/bg.png"] = "background",
            ["node_modules/pkg/a.png"] = "one",
            ["node_modules/pkg/b.png"] = "two",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(4);
    }

    [Fact]
    public void Analyze_CssImportUrlWrapper_RestoresActualStylesheet()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<link rel=\"stylesheet\" href=\"./styles/app.css\">",
            ["styles/app.css"] = "@import url(\"./theme.css\");",
            ["styles/theme.css"] = "body { color: black; }",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(3);
    }

    [Fact]
    public void Analyze_MultipleResourceAttributes_RestoreEveryDependency()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<video src=\"./node_modules/pkg/movie.mp4\" poster=\"./node_modules/pkg/poster.jpg\"></video>",
            ["node_modules/pkg/movie.mp4"] = "movie",
            ["node_modules/pkg/poster.jpg"] = "poster",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(3);
    }

    [Fact]
    public void Analyze_LocalNavigation_RestoresLinkedPageAndItsDependencies()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<a href=\"./tests/help.html\">help</a>",
            ["tests/help.html"] = "<script src=\"./help.js\"></script>",
            ["tests/help.js"] = "document.body.dataset.ready = 'true';",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(3);
    }

    [Fact]
    public void Analyze_CommentedResource_DoesNotBlockOnStaleDependency()
    {
        var result = CreateService().Analyze(CreateZip(new Dictionary<string, string>
        {
            ["index.html"] = "<!-- <script src=\"./old.js\"></script> --><main>ready</main>",
        }));

        result.Blocked.ShouldBeFalse();
        result.OriginalFiles.ShouldBe(1);
    }

    [Fact]
    public void Analyze_NonFileUriSchemes_DoNotBecomeMissingLocalDependencies()
    {
        var result = CreateService().Analyze(CreateZip(new Dictionary<string, string>
        {
            ["index.html"] = "<iframe src=\"about:blank\"></iframe><img src=\"blob:preview\">",
        }));

        result.Blocked.ShouldBeFalse();
        result.OriginalFiles.ShouldBe(1);
    }

    [Fact]
    public void Analyze_SvgUse_RestoresSpriteDependency()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<svg><use href=\"./node_modules/pkg/icons.svg#check\"></use></svg>",
            ["node_modules/pkg/icons.svg"] = "<svg><symbol id=\"check\"></symbol></svg>",
        };
        for (var index = 0; index < 120; index++)
            files[$"node_modules/unused-{index}/index.js"] = "export default true;";

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.Recommended.ShouldBeTrue();
        result.OptimizedFiles.ShouldBe(2);
    }

    [Fact]
    public void Analyze_HtmlBaseHref_ResolvesDependenciesFromEffectiveBase()
    {
        var files = new Dictionary<string, string>
        {
            ["index.html"] = "<base href=\"/assets/\"><script src=\"app.js\"></script>",
            ["assets/app.js"] = "document.body.dataset.ready = 'true';",
        };

        var result = CreateService().Analyze(CreateZip(files));

        result.Blocked.ShouldBeFalse();
        result.OriginalFiles.ShouldBe(2);
    }

    [Fact]
    public void Analyze_UnsafeArchivePath_BlocksBeforeAnySave()
    {
        var result = CreateService().Analyze(CreateZip(new Dictionary<string, string>
        {
            ["index.html"] = "<html></html>",
            ["../secret.txt"] = "secret",
        }));

        result.Blocked.ShouldBeTrue();
        (result.Error ?? string.Empty).ShouldContain("不安全路径");
    }

    [Fact]
    public void Analyze_MissingRuntimeAsset_BlocksInsteadOfGuessing()
    {
        var result = CreateService().Analyze(CreateZip(new Dictionary<string, string>
        {
            ["index.html"] = "<html><link rel=\"stylesheet\" href=\"./missing.css\"></html>",
        }));

        result.Blocked.ShouldBeTrue();
        (result.Error ?? string.Empty).ShouldContain("资源缺失");
    }

    [Theory]
    [InlineData("text/html", "pages/index.html", "<img src=\"/assets/logo.png\">", "<img src=\"../assets/logo.png\">")]
    [InlineData("text/css", "styles/app.css", "body{background:url('/assets/bg.png')}", "body{background:url('../assets/bg.png')}")]
    [InlineData("application/javascript", "scripts/app.js", "fetch('/assets/data.json')", "fetch('../assets/data.json')")]
    public void RewriteRootReferencesForArtifact_PersistsPreviewResolutionInSavedPackage(
        string mimeType,
        string ownerPath,
        string input,
        string expected)
    {
        var rewritten = HostedSiteOptimizationService.RewriteRootReferencesForArtifact(
            Encoding.UTF8.GetBytes(input), mimeType, ownerPath);

        Encoding.UTF8.GetString(rewritten).ShouldBe(expected);
    }

    [Fact]
    public void RewriteRootReferencesForPreview_CoversRuntimeLoaders()
    {
        const string input = "import('/module.js');require('/legacy.js');fetch('/data.json');new Worker('/worker.js');navigator.serviceWorker.register('/service-worker.js');importScripts('/shared.js')";

        var rewritten = HostedSiteOptimizationService.RewriteRootReferencesForPreview(
            Encoding.UTF8.GetBytes(input), "application/javascript", "/preview/", "scripts/app.js");

        var text = Encoding.UTF8.GetString(rewritten);
        foreach (var path in new[] { "module.js", "legacy.js", "data.json", "worker.js", "service-worker.js", "shared.js" })
            text.ShouldContain($"'/preview/{path}'");
    }

    [Fact]
    public void RewriteRootReferencesForPreview_RewritesLocalBaseToTokenProxy()
    {
        const string input = "<base href=\"/assets/\"><script src=\"app.js\"></script>";

        var rewritten = HostedSiteOptimizationService.RewriteRootReferencesForPreview(
            Encoding.UTF8.GetBytes(input), "text/html", "/preview/", "pages/index.html");

        Encoding.UTF8.GetString(rewritten)
            .ShouldBe("<base href=\"/preview/assets/\"><script src=\"app.js\"></script>");

        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs"));
        controller.ShouldContain("base-uri 'self'");
        controller.ShouldNotContain("base-uri 'none'");
    }

    [Fact]
    public void RewriteRootReferences_CoversSrcSetAndEmbeddedCss()
    {
        const string input = "<pre>href=/api/items</pre><script>const sample = 'href=/api/items';</script><script src=/assets/app.js></script><img srcset=\"/assets/a.png 1x, /assets/b.png 2x\" style=\"background:url('/assets/bg.png')\"><style>.hero{mask:url('/assets/mask.svg')}</style>";

        var artifact = Encoding.UTF8.GetString(
            HostedSiteOptimizationService.RewriteRootReferencesForArtifact(
                Encoding.UTF8.GetBytes(input), "text/html", "pages/index.html"));
        artifact.ShouldContain("srcset=\"../assets/a.png 1x, ../assets/b.png 2x\"");
        artifact.ShouldContain("src=../assets/app.js");
        artifact.ShouldContain("<pre>href=/api/items</pre>");
        artifact.ShouldContain("const sample = 'href=/api/items'");
        artifact.ShouldContain("url('../assets/bg.png')");
        artifact.ShouldContain("url('../assets/mask.svg')");

        var preview = Encoding.UTF8.GetString(
            HostedSiteOptimizationService.RewriteRootReferencesForPreview(
                Encoding.UTF8.GetBytes(input), "text/html", "/preview/", "pages/index.html"));
        preview.ShouldContain("srcset=\"/preview/assets/a.png 1x, /preview/assets/b.png 2x\"");
        preview.ShouldContain("src=/preview/assets/app.js");
        preview.ShouldContain("<pre>href=/api/items</pre>");
        preview.ShouldContain("const sample = 'href=/api/items'");
        preview.ShouldContain("url('/preview/assets/bg.png')");
        preview.ShouldContain("url('/preview/assets/mask.svg')");
    }

    [Fact]
    public void OptimizationSessionIndexes_PreserveCleanupLedgerUntilWorkerDeletesIt()
    {
        var catalog = File.ReadAllText(LocateRepoFile("scripts/mongodb-indexes.js"));
        var context = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs"));
        var optimizer = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteOptimizationService.cs"));

        catalog.ShouldContain("idx_hosted_site_optimization_owner_expiry");
        catalog.ShouldContain("idx_hosted_site_optimization_status_updated");
        catalog.ShouldContain("idx_hosted_site_optimization_expiry");
        catalog.ShouldContain("collection.dropIndex(index.name)");
        catalog.ShouldNotContain("ttl_hosted_site_optimization_expiry");
        catalog.ShouldNotContain("expireAfterSeconds: 86400");
        context.ShouldNotContain("ttl_hosted_site_optimization_expiry");
        context.ShouldNotContain("idx_hosted_site_optimization_owner_expiry");
        context.ShouldNotContain("idx_hosted_site_optimization_status_updated");
        context.ShouldNotContain("idx_hosted_site_optimization_expiry");
        optimizer.ShouldContain("Sort.Ascending(x => x.UpdatedAt)");
        optimizer.ShouldNotContain("Sort.Ascending(x => x.CreatedAt)");
    }

    [Fact]
    public void ReuploadRecovery_PersistsAndUsesOptimizationSessionMarker()
    {
        var optimizer = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteOptimizationService.cs"));
        var hostedSites = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs"));

        optimizer.ShouldContain("reuploadRef: session.Id");
        optimizer.ShouldContain("x.LastReuploadRef == session.Id");
        hostedSites.ShouldContain(".Set(x => x.LastReuploadRef, normalizedReuploadRef)");
    }

    [Fact]
    public void BackgroundCleanup_UsesIndependentElapsedTimeLoopAndDrainsBatches()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/HostedSiteOptimizationCleanupService.cs"));

        source.ShouldContain("Task.WhenAll(");
        source.ShouldContain("CleanupInterval = TimeSpan.FromMinutes(10)");
        source.ShouldContain("total += result.Deleted;");
        source.ShouldContain("if (result.Selected < 20) break;");
        source.ShouldNotContain("CleanupEveryTicks");
    }

    [Theory]
    [InlineData(0, 0, 0, true)]
    [InlineData(101, 0, 0, false)]
    [InlineData(1, 16, 0, false)]
    [InlineData(0, 0, 1, false)]
    public void QueueHealth_FailsForBacklogStallOrExpiredHolder(
        int queuedCount,
        int oldestMinutes,
        int expiredHolderCount,
        bool expected)
    {
        var oldestAge = oldestMinutes == 0 ? (TimeSpan?)null : TimeSpan.FromMinutes(oldestMinutes);

        HostedSiteOptimizationService.IsQueueHealthy(
            queuedCount, oldestAge, expiredHolderCount).ShouldBe(expected);
    }

    [Fact]
    public void QueueWorker_HasProbeWatchdogAndStandingRegressionHooks()
    {
        var worker = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/HostedSiteOptimizationCleanupService.cs"));
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs"));

        worker.ShouldContain("WatchQueueHealthAsync");
        worker.ShouldContain("LogError(");
        controller.ShouldContain("optimization/health");
        controller.ShouldContain("Status503ServiceUnavailable");
    }

    [Fact]
    public void LargeUploadAndCancellation_AvoidDuplicateArchiveAndRetainCleanupLedger()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteOptimizationService.cs"));

        source.ShouldContain("var sourceBytes = new byte[checked((int)session.SourceFileSize)]");
        source.ShouldNotContain("var sourceBytes = source.ToArray()");
        source.ShouldContain("var cleanupAfter = DateTime.UtcNow.Add(WorkerLeaseLifetime)");
        source.ShouldContain("current == null || current.Status == HostedSiteOptimizationStatuses.CleanupPending");
        source.ShouldContain("await TryDeleteAsync(key)");
        source.ShouldContain("session.ExpiresAt = cleanupAfter");
        source.ShouldContain("session.Status = HostedSiteOptimizationStatuses.Saved");
        source.ShouldContain("Previewing,\n                            HostedSiteOptimizationStatuses.Saving");
        source.ShouldContain(".Push(x => x.PreviewFiles, pendingFile)");
        source.ShouldContain("HostedSiteService.GetMimeType(Path.GetExtension(path))");
        source.IndexOf("var recoveryClaim =", StringComparison.Ordinal).ShouldBeLessThan(
            source.IndexOf("CleanupPreviewFilesAsync(recoveryClaim.PreviewFiles)", StringComparison.Ordinal));
        source.ShouldContain("PersistSavedCompletionAsync");
        source.ShouldContain("sourceRef: session.Id");
        source.IndexOf("var claimed = await _db.HostedSiteOptimizationSessions.FindOneAndUpdateAsync(", StringComparison.Ordinal)
            .ShouldBeLessThan(source.IndexOf("CleanupSessionFilesAsync(claimed)", StringComparison.Ordinal));
        source.ShouldContain("x.LeaseOwner == cleanupOwner");
        source.ShouldContain("CleanupRetryDelay = TimeSpan.FromMinutes(10)");
        source.ShouldContain(".Set(x => x.ExpiresAt, cleanupNow.Add(CleanupRetryDelay))");

        var recommendedBranch = source[source.IndexOf("if (analysis.Recommended)", StringComparison.Ordinal)..];
        recommendedBranch.IndexOf(".Set(x => x.SourceObjectKey", StringComparison.Ordinal).ShouldBeLessThan(
            recommendedBranch.IndexOf("await _storage.UploadToKeyAsync(", StringComparison.Ordinal));

        var healthQuery = source[
            source.IndexOf("public async Task<HostedSiteOptimizationQueueHealth>", StringComparison.Ordinal)..
            source.IndexOf("internal static bool IsQueueHealthy", StringComparison.Ordinal)];
        healthQuery.ShouldContain("HostedSiteOptimizationStatuses.Previewing");

        var hostedSiteSource = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs"));
        hostedSiteSource.ShouldContain("SourceRef = sourceRef?.Trim()");
    }

    private static HostedSiteOptimizationService CreateService()
        => new(null!, null!, null!, NullLogger<HostedSiteOptimizationService>.Instance);

    private static string LocateRepoFile(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"仓库文件不存在: {relativePath}");
    }

    private static byte[] CreateZip(IReadOnlyDictionary<string, string> files)
        => CreateZip(files.ToDictionary(x => x.Key, x => Encoding.UTF8.GetBytes(x.Value)));

    private static byte[] CreateZip(IReadOnlyDictionary<string, byte[]> files)
    {
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, content) in files)
            {
                var entry = archive.CreateEntry(path, CompressionLevel.Fastest);
                using var stream = entry.Open();
                stream.Write(content, 0, content.Length);
            }
        }
        return output.ToArray();
    }

    private static byte[] CreateNodeModulesHeavyZip()
    {
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            AddTextEntry(archive, "index.html", "<html><script src=\"./app.js\"></script></html>");
            AddTextEntry(archive, "app.js", "document.body.dataset.ready = 'true';");

            var dependencyPayload = new string('x', 350 * 1024);
            for (var index = 0; index < 105; index++)
                AddTextEntry(archive, $"node_modules/unused-{index}/index.js", dependencyPayload);
        }
        return output.ToArray();
    }

    private static void AddTextEntry(ZipArchive archive, string path, string content)
    {
        var entry = archive.CreateEntry(path, CompressionLevel.Fastest);
        using var stream = entry.Open();
        var bytes = Encoding.UTF8.GetBytes(content);
        stream.Write(bytes, 0, bytes.Length);
    }
}
