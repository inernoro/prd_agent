using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public sealed class HostedSiteVerifiedPackageTests
{
    [Fact]
    public void Validate_ShouldPreserveCompleteResourceBytesAndMetadata()
    {
        var files = Package();
        files.Add(File("assets/style.css", "text/css; charset=utf-8", "body { color: #123456; }"));
        files.Add(File("assets/app.js", "application/javascript; charset=utf-8", "document.body.dataset.ready = 'yes';"));
        files.Add(File("assets/slides.mjs", "application/javascript", "export const pageCount = 2;"));
        files.Add(File("assets/images/cover.png", "image/png", "binary-image-fixture"));
        files.Add(File("assets/fonts/body.woff2", "font/woff2", "binary-font-fixture"));

        var actual = HostedSiteService.ValidateVerifiedGeneratedFiles(files);

        Assert.Equal(files.Count, actual.Length);
        Assert.Equal(files.Select(file => file.Path).OrderBy(path => path, StringComparer.Ordinal),
            actual.Select(file => file.Path));
        foreach (var expected in files)
        {
            var saved = Assert.Single(actual.Where(file => file.Path == expected.Path));
            Assert.Same(expected, saved);
            Assert.Equal(expected.Content, saved.Content);
            Assert.Equal(expected.Sha256, saved.Sha256);
            Assert.Equal(expected.MimeType, saved.MimeType);
        }
    }

    [Fact]
    public void Validate_ShouldKeepLegacySixFilePackageUnchanged()
    {
        var files = Package();
        Assert.Equal(6, HostedSiteService.ValidateVerifiedGeneratedFiles(files).Length);
    }

    [Fact]
    public void Validate_ShouldAcceptEditPackageWithoutGenerationReports()
    {
        var files = Package().Where(file => file.Path is "index.html" or "manifest.json").ToList();
        Assert.Equal(2, HostedSiteService.ValidateVerifiedGeneratedFiles(files).Length);
        files.Add(File("assets/style.css", "text/css", "body { color: blue; }"));
        files.Add(File("assets/app.js", "text/javascript", "void 0;"));
        files.Add(File("assets/cover.png", "image/png", "unchanged-image-fixture"));

        var actual = HostedSiteService.ValidateVerifiedGeneratedFiles(files);
        Assert.Equal(files.Count, actual.Length);
        foreach (var expected in files)
            Assert.Same(expected, Assert.Single(actual.Where(file => file.Path == expected.Path)));
    }

    [Theory]
    [InlineData("index.html")]
    [InlineData("manifest.json")]
    public void Validate_ShouldStillRequireEntryAndManifest(string missingPath)
    {
        var files = Package();
        files.RemoveAll(file => file.Path == missingPath);
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
    }

    [Theory]
    [InlineData("assets/extra.html", "text/html")]
    [InlineData("assets/extra.svg", "image/svg+xml")]
    [InlineData("assets/extra.xml", "application/xml")]
    [InlineData("assets/extra.sh", "text/plain")]
    [InlineData("assets/app.js", "text/html")]
    [InlineData("assets/cover.png", "application/javascript")]
    [InlineData("assets/app.js", "application/javascript; charset=iso-8859-1")]
    [InlineData("assets/app.js", "application/javascript; unknown=value")]
    [InlineData("../assets/app.js", "application/javascript")]
    [InlineData("knowledge/private.json", "application/json")]
    [InlineData("assets/%2e%2e/app.js", "application/javascript")]
    public void Validate_ShouldRejectUnsupportedOrMislabeledResource(string path, string mime)
    {
        var files = Package();
        files.Add(File(path, mime, "not public content"));
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
    }

    [Fact]
    public void Validate_ShouldRejectCaseCollisionsAndFileDirectoryCollisions()
    {
        var files = Package();
        files.Add(File("assets/app.js", "application/javascript", "first"));
        files.Add(File("assets/APP.js", "application/javascript", "second"));
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
        files.RemoveAt(files.Count - 1);
        files.Add(File("assets/app.js/nested.json", "application/json", "{}"));
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
    }

    [Fact]
    public void Validate_ShouldRejectTamperingWithoutMutatingTheInput()
    {
        var files = Package();
        var resource = File("assets/app.js", "application/javascript", "original");
        resource.Content[0] ^= 1;
        files.Add(resource);
        var before = resource.Content.ToArray();
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
        Assert.Equal(before, resource.Content);
    }

    [Fact]
    public void Validate_ShouldAllowOnlyResourcesBoundToTheVerifiedPackage()
    {
        var files = Package();
        files.RemoveAll(file => file.Path == "index.html");
        files.Add(File("assets/app.js", "application/javascript; charset=utf-8",
            "document.body.dataset.ready = 'yes';"));
        var hardened = HostedSiteRevisionRules.HardenVerifiedPackageHtml(
            "<!doctype html><html><body><button id=\"next\">下一页</button><script src=\"assets/app.js\"></script></body></html>",
            files.Select(file => file.Path).Append("index.html").ToArray());
        files.Add(File("index.html", "text/html; charset=utf-8", hardened));

        var accepted = HostedSiteService.ValidateVerifiedGeneratedFiles(files);

        Assert.Equal(files.Count, accepted.Length);
        Assert.Contains("script-src 'self' 'unsafe-inline'", hardened, StringComparison.Ordinal);
        Assert.Contains("connect-src 'none'", hardened, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://tracker.example/app.js")]
    [InlineData("assets/missing.js")]
    [InlineData("../assets/app.js")]
    [InlineData("/assets/app.js")]
    public void VerifiedHtml_ShouldRejectReferencesOutsideTheBoundPackage(string reference)
    {
        var paths = new[] { "index.html", "assets/app.js" };
        var html = $"<!doctype html><html><body><script src=\"{reference}\"></script></body></html>";

        Assert.Throws<InvalidOperationException>(() =>
            HostedSiteRevisionRules.HardenVerifiedPackageHtml(html, paths));
    }

    [Fact]
    public void Validate_ShouldRejectTooManyFiles()
    {
        var files = Package();
        for (var index = 0; index < 95; index++)
            files.Add(File($"assets/{index}.json", "application/json", "{}"));
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
    }

    [Theory]
    [InlineData("assets/config.json", "application/json", "not-json")]
    [InlineData("assets/style.css", "text/css", "invalid-utf8")]
    public void Validate_ShouldRejectMalformedTextWithoutRewritingIt(string path, string mime, string text)
    {
        var files = Package();
        var file = File(path, mime, text);
        if (text == "invalid-utf8")
        {
            var bytes = new byte[] { 0xff, 0xfe };
            file = new HostedSiteVerifiedFile(path, bytes,
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), mime);
        }
        files.Add(file);
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
    }

    [Fact]
    public void Validate_ShouldRejectOversizedTotalPackage()
    {
        var files = Package();
        files.Add(File("assets/app.js", "text/javascript; charset=utf-8", new string(' ', 6 * 1024 * 1024)));
        Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
    }

    [Theory]
    [InlineData("application/javascript")]
    [InlineData("text/javascript; charset=utf-8")]
    public void Validate_ShouldAcceptBothExistingScriptMediaTypes(string mime)
    {
        var files = Package();
        files.Add(File("assets/app.js", mime, "void 0;"));
        Assert.Equal(files.Count, HostedSiteService.ValidateVerifiedGeneratedFiles(files).Length);
    }

    [Fact]
    public void Validate_ShouldRejectJsonBomAndExcessiveNestingWithoutChangingBytes()
    {
        foreach (var text in new[] { "\uFEFF{}", new string('[', 65) + "0" + new string(']', 65) })
        {
            var files = Package();
            var file = File("assets/data.json", "application/json; charset=utf-8", text);
            files.Add(file);
            Assert.Throws<InvalidOperationException>(() => HostedSiteService.ValidateVerifiedGeneratedFiles(files));
            Assert.Equal(Encoding.UTF8.GetBytes(text), file.Content);
        }
    }

    [Fact]
    public void Validate_ShouldPreserveJsonAtSupportedNestingBoundary()
    {
        var files = Package();
        var file = File("assets/data.json", "application/json; charset=utf-8",
            new string('[', 64) + "0" + new string(']', 64));
        files.Add(file);
        Assert.Same(file, Assert.Single(HostedSiteService.ValidateVerifiedGeneratedFiles(files)
            .Where(result => result.Path == file.Path)));
    }

    private static List<HostedSiteVerifiedFile> Package() =>
    [
        File("index.html", "text/html; charset=utf-8", HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><head><title>知识网页</title></head><body><h1>知识网页</h1></body></html>")),
        File("manifest.json", "application/json; charset=utf-8", "{}"),
        File("assets/accessibility-static-report.json", "application/json", "{}"),
        File("assets/design-tokens.json", "application/json", "{}"),
        File("assets/page-outline.json", "application/json", "{}"),
        File("assets/provenance.json", "application/json", "{}"),
    ];

    private static HostedSiteVerifiedFile File(string path, string mime, string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return new HostedSiteVerifiedFile(path, bytes,
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), mime);
    }
}
