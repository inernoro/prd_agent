using System.IO.Compression;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class HostedSiteOptimizationServiceTests
{
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

    private static HostedSiteOptimizationService CreateService()
        => new(null!, null!, null!, NullLogger<HostedSiteOptimizationService>.Instance);

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
}
