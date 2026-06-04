using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
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
/// 更新中心「终身存储 + 推送」行为回归测试（不触网、不依赖 Mongo，全部用 fake）。
/// 覆盖：
///  - 加载只读存量：内存缓存空时从快照存储 hydrate，不读本地文件（验证「打开即读存量」）
///  - 成功拉取落库 + 内容变化推送（验证后台刷新链路）
///  - 内容未变不重复推送（验证指纹剔除 fetchedAt 后的去重）
/// </summary>
public sealed class ChangelogSnapshotPersistenceTests : IDisposable
{
    private readonly string _root;

    public ChangelogSnapshotPersistenceTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "changelog-snap-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_root, "changelogs"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* best-effort */ }
    }

    private void WriteChangelog(string body) => File.WriteAllText(Path.Combine(_root, "CHANGELOG.md"), body);

    private ChangelogReader CreateReader(IChangelogSnapshotStore store, IChangelogPushHub hub)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Changelog:RootPath"] = _root })
            .Build();

        return new ChangelogReader(
            new MemoryCache(new MemoryCacheOptions()),
            config,
            new FakeHostEnvironment(),
            new FakeHttpClientFactory(),
            NullLogger<ChangelogReader>.Instance,
            store,
            hub);
    }

    private const string OneRelease =
        "# Changelog\n\n## [1.0.0] - 2026-05-01\n\n### 2026-05-01\n\n| feat | prd-admin | 初始版本 |\n";

    [Fact]
    public async Task GetReleases_HydratesFromStore_WithoutReadingLocalFile()
    {
        // 本地文件只有 1 个版本；但存储里预置了 2 个版本的快照。
        WriteChangelog(OneRelease);
        var store = new FakeSnapshotStore();
        var hub = new FakePushHub();

        var seeded = new ReleasesView
        {
            DataSourceAvailable = true,
            Source = "github",
            FetchedAt = DateTime.UtcNow.AddMinutes(-1),
            Releases = new List<ChangelogRelease>
            {
                new() { Version = "2.0.0" },
                new() { Version = "1.0.0" },
            },
        };
        var json = JsonSerializer.Serialize(seeded, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        store.Seed("changelog:releases:20", json, "github", seeded.FetchedAt);

        var reader = CreateReader(store, hub);
        var view = await reader.GetReleasesAsync(20);

        // 命中存量（2 个版本），证明没有去读只有 1 个版本的本地文件
        Assert.Equal(2, view.Releases.Count);
        Assert.Equal("github", view.Source);
    }

    [Fact]
    public async Task ForceRefresh_PersistsAndPublishesOnce_DedupesUnchanged()
    {
        WriteChangelog(OneRelease);
        var store = new FakeSnapshotStore();
        var hub = new FakePushHub();
        var reader = CreateReader(store, hub);

        // 第一次 force：拉本地 → 落库 + 推送
        var first = await reader.GetReleasesAsync(20, force: true);
        Assert.True(first.DataSourceAvailable);
        Assert.True(store.Has("changelog:releases:20"));
        Assert.Single(hub.Events);
        Assert.Equal("releases", hub.Events[0].ViewType);

        // 第二次 force：内容相同（仅 fetchedAt 变化）→ 指纹一致 → 不重复推送
        var second = await reader.GetReleasesAsync(20, force: true);
        Assert.True(second.DataSourceAvailable);
        Assert.Single(hub.Events); // 仍是 1 条，证明去重生效
    }

    // ── Fakes ──────────────────────────────────────────────────────────

    private sealed class FakeSnapshotStore : IChangelogSnapshotStore
    {
        private readonly ConcurrentDictionary<string, (string payload, string hash, string source, DateTime fetchedAt)> _data = new();

        public void Seed(string key, string payload, string source, DateTime fetchedAt)
            => _data[key] = (payload, "seed-hash", source, fetchedAt);

        public bool Has(string key) => _data.ContainsKey(key);

        public Task<PrdAgent.Core.Models.ChangelogSnapshot?> GetAsync(string key, CancellationToken ct = default)
        {
            if (!_data.TryGetValue(key, out var v)) return Task.FromResult<PrdAgent.Core.Models.ChangelogSnapshot?>(null);
            return Task.FromResult<PrdAgent.Core.Models.ChangelogSnapshot?>(new PrdAgent.Core.Models.ChangelogSnapshot
            {
                Key = key,
                PayloadJson = v.payload,
                ContentHash = v.hash,
                Source = v.source,
                FetchedAt = v.fetchedAt,
            });
        }

        public Task<bool> UpsertIfChangedAsync(string key, string payloadJson, string contentHash, string source, DateTime fetchedAt, CancellationToken ct = default)
        {
            var changed = !_data.TryGetValue(key, out var existing) || existing.hash != contentHash;
            _data[key] = (payloadJson, contentHash, source, fetchedAt);
            return Task.FromResult(changed);
        }
    }

    private sealed class FakePushHub : IChangelogPushHub
    {
        public readonly List<ChangelogPushEvent> Events = new();

        public (Guid id, ChannelReader<ChangelogPushEvent> reader) Subscribe()
        {
            var ch = Channel.CreateUnbounded<ChangelogPushEvent>();
            return (Guid.NewGuid(), ch.Reader);
        }

        public void Unsubscribe(Guid id) { }

        public void Publish(ChangelogPushEvent evt) => Events.Add(evt);
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
        public HttpClient CreateClient(string name) => new HttpClient();
    }
}
