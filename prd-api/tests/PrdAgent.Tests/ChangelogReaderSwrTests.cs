using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services.Changelog;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// ChangelogReader 的 serve-stale-while-revalidate 行为回归测试。
/// 用临时目录作为本地源（含 changelogs/ + CHANGELOG.md），不触网。
/// 覆盖：本地解析正确 + 新鲜期内命中缓存（同实例，不重读文件）+ force 绕过缓存重读。
/// </summary>
public sealed class ChangelogReaderSwrTests : IDisposable
{
    private readonly string _root;

    public ChangelogReaderSwrTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "changelog-swr-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_root, "changelogs"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* best-effort */ }
    }

    private void WriteChangelog(string body) => File.WriteAllText(Path.Combine(_root, "CHANGELOG.md"), body);

    private ChangelogReader CreateReader()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new System.Collections.Generic.Dictionary<string, string?>
            {
                ["Changelog:RootPath"] = _root,
            })
            .Build();

        return new ChangelogReader(
            new MemoryCache(new MemoryCacheOptions()),
            config,
            new FakeHostEnvironment(),
            new FakeHttpClientFactory(),
            NullLogger<ChangelogReader>.Instance);
    }

    private const string OneRelease =
        "# Changelog\n\n## [1.0.0] - 2026-05-01\n\n### 2026-05-01\n\n| feat | prd-admin | 初始版本 |\n";

    private const string TwoReleases =
        "# Changelog\n\n## [2.0.0] - 2026-05-20\n\n### 2026-05-20\n\n| feat | prd-api | 新增缓存 |\n\n" +
        "## [1.0.0] - 2026-05-01\n\n### 2026-05-01\n\n| feat | prd-admin | 初始版本 |\n";

    [Fact]
    public async Task GetReleases_ParsesLocalChangelog()
    {
        WriteChangelog(OneRelease);
        var reader = CreateReader();

        var view = await reader.GetReleasesAsync(20);

        Assert.True(view.DataSourceAvailable);
        Assert.Equal("local", view.Source);
        Assert.Single(view.Releases);
        Assert.Equal("1.0.0", view.Releases[0].Version);
        Assert.Single(view.Releases[0].Days.SelectMany(d => d.Entries));
    }

    [Fact]
    public async Task GetReleases_FreshWindow_ReturnsCachedInstance_WithoutRereadingFile()
    {
        WriteChangelog(OneRelease);
        var reader = CreateReader();

        var first = await reader.GetReleasesAsync(20);
        // 新鲜期内（默认 5 分钟）即便文件被改写，非 force 仍返回同一缓存实例
        WriteChangelog(TwoReleases);
        var second = await reader.GetReleasesAsync(20);

        Assert.Same(first, second);
        Assert.Single(second.Releases); // 仍是旧值（1 个版本），证明走了缓存而非重读
    }

    [Fact]
    public async Task GetReleases_Force_BypassesCacheAndRereads()
    {
        WriteChangelog(OneRelease);
        var reader = CreateReader();

        var cached = await reader.GetReleasesAsync(20);
        Assert.Single(cached.Releases);

        WriteChangelog(TwoReleases);
        var forced = await reader.GetReleasesAsync(20, force: true);

        Assert.NotSame(cached, forced);
        Assert.Equal(2, forced.Releases.Count); // force 重读拿到 2 个版本

        // force 之后新值进缓存：再次非 force 读到的是刷新后的 2 个版本
        var afterForce = await reader.GetReleasesAsync(20);
        Assert.Equal(2, afterForce.Releases.Count);
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Development";
        public string ApplicationName { get; set; } = "PrdAgent.Tests";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class FakeHttpClientFactory : IHttpClientFactory
    {
        // 本地源可用时不会被调用；仅为满足构造函数依赖
        public HttpClient CreateClient(string name) => new HttpClient();
    }
}
