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
    public void OptimizationSessionIndexes_AreRegisteredInExecutableCatalog()
    {
        var catalog = File.ReadAllText(LocateRepoFile("scripts/mongodb-indexes.js"));

        catalog.ShouldContain("idx_hosted_site_optimization_owner_expiry");
        catalog.ShouldContain("idx_hosted_site_optimization_status_updated");
        catalog.ShouldContain("ttl_hosted_site_optimization_expiry");
        catalog.ShouldContain("expireAfterSeconds: 86400");
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
    {
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, content) in files)
            {
                var entry = archive.CreateEntry(path, CompressionLevel.Fastest);
                using var stream = entry.Open();
                var bytes = Encoding.UTF8.GetBytes(content);
                stream.Write(bytes, 0, bytes.Length);
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
