using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class LocalAssetStaticFilePolicyTests
{
    [Fact]
    public async Task HostedHtml_ShouldExecuteInOpaqueSandboxWithoutAdminOriginAccess()
    {
        var root = Path.Combine(Path.GetTempPath(), $"local-assets-policy-{Guid.NewGuid():N}");
        var htmlPath = Path.Combine(root, "web-hosting", "sites", "attack", "index.html");
        Directory.CreateDirectory(Path.GetDirectoryName(htmlPath)!);
        await File.WriteAllTextAsync(
            htmlPath,
            "<script>document.body.textContent = localStorage.getItem('token')</script>");

        try
        {
            await using var app = BuildHost(root);
            await app.StartAsync();

            using var response = await app.GetTestClient().GetAsync(
                "/local-assets/web-hosting/sites/attack/index.html");

            response.EnsureSuccessStatusCode();
            response.Content.Headers.ContentType?.MediaType.ShouldBe("text/html");
            var policy = response.Headers.GetValues("Content-Security-Policy").Single();
            policy.ShouldBe(LocalAssetStaticFilePolicy.ContentSecurityPolicy);
            policy.ShouldContain("allow-scripts");
            policy.ShouldNotContain("allow-same-origin");
            response.Headers.GetValues("X-Content-Type-Options").Single().ShouldBe("nosniff");
            response.Headers.GetValues("Referrer-Policy").Single().ShouldBe("no-referrer");
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task RecordingAsset_ShouldRemainReadableThroughLocalRoute()
    {
        var root = Path.Combine(Path.GetTempPath(), $"local-assets-policy-{Guid.NewGuid():N}");
        var audioPath = Path.Combine(root, "recordings", "session", "audio.m4a");
        Directory.CreateDirectory(Path.GetDirectoryName(audioPath)!);
        var payload = new byte[] { 4, 3, 2, 1 };
        await File.WriteAllBytesAsync(audioPath, payload);

        try
        {
            await using var app = BuildHost(root);
            await app.StartAsync();

            using var response = await app.GetTestClient().GetAsync(
                "/local-assets/recordings/session/audio.m4a");

            response.EnsureSuccessStatusCode();
            (await response.Content.ReadAsByteArrayAsync()).ShouldBe(payload);
            response.Headers.GetValues("Content-Security-Policy").Single()
                .ShouldBe(LocalAssetStaticFilePolicy.ContentSecurityPolicy);
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    private static WebApplication BuildHost(string localAssetDir)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        var app = builder.Build();
        app.UseStaticFiles(LocalAssetStaticFilePolicy.CreateOptions(localAssetDir));
        return app;
    }
}
