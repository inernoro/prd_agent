using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 站点正文快照的诚实性守卫，两条都由 PR #1351 第三轮 Codex review 抓出。
///
/// 共同的病根是**把"没给模型看"说成"页面里没有"**：
///   - 文件数超上限被挡掉，却不置 Truncated → prompt 声称这是全部内容
///   - 对象存储抖一下读不回来，却报"这个页面没有可供阅读的文字内容" → 还被缓存半小时
/// 两种都会让模型斩钉截铁地回答"页面里没有提到"，而事实是我们压根没读到。
/// </summary>
public class SiteContentSnapshotServiceTests
{
    private static SiteContentSnapshotService NewService(FakeAssetStorage storage) =>
        new(storage,
            new FakeExtractor(),
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<SiteContentSnapshotService>.Instance);

    private static HostedSite SiteWith(params (string Path, string Key)[] files) => new()
    {
        Id = "site-1",
        Title = "测试站点",
        EntryFile = "index.html",
        Files = files.Select(f => new HostedSiteFile
        {
            Path = f.Path,
            CosKey = f.Key,
            Size = 100,
            MimeType = "text/html",
        }).ToList(),
    };

    // ── 文件数超上限必须标 Truncated ──────────────────────────

    [Fact]
    public async Task 文件数在上限内_不标截断()
    {
        var files = Enumerable.Range(1, 5).Select(i => ($"p{i}.html", $"k{i}")).ToArray();
        var storage = new FakeAssetStorage();
        foreach (var (_, key) in files) storage.Objects[key] = "内容";

        var snap = await NewService(storage).GetAsync(SiteWith(files));

        Assert.Null(snap.Unavailable);
        Assert.False(snap.Truncated);
    }

    /// <summary>
    /// 核心用例：超过数量上限的文件被挡在门外，必须如实标 Truncated。
    /// 原实现在 SelectFiles 里 Take(12)，BuildAsync 根本看不到被丢掉的文件，
    /// Truncated 恒为 false，于是 prompt 说"以下是页面全部内容"。
    /// </summary>
    [Fact]
    public async Task 文件数超上限_必须标截断()
    {
        // 入口 1 个 + 其余 20 个，远超 12 的上限
        var files = new List<(string, string)> { ("index.html", "k0") };
        files.AddRange(Enumerable.Range(1, 20).Select(i => ($"p{i}.html", $"k{i}")));

        var storage = new FakeAssetStorage();
        foreach (var (_, key) in files) storage.Objects[key] = "内容";

        var snap = await NewService(storage).GetAsync(SiteWith(files.ToArray()));

        Assert.True(snap.Truncated, "被数量上限挡掉的文件没有反映到 Truncated 上——prompt 会声称这是全部内容");
    }

    // ── 读失败与"确实没内容"必须分开 ──────────────────────────

    /// <summary>
    /// 核心用例：全部对象读不回来是**暂时故障**，不能说成"这个页面没有文字内容"，
    /// 更不能缓存——否则存储恢复后每次提问照样吃 ASK_NO_CONTENT，而配额已经先扣了。
    /// </summary>
    [Fact]
    public async Task 全部读失败_标为暂时故障且不缓存()
    {
        var storage = new FakeAssetStorage(); // 什么都没放 → TryDownloadBytesAsync 返回 null
        var site = SiteWith(("index.html", "k0"));
        var svc = NewService(storage);

        var first = await svc.GetAsync(site);

        Assert.NotNull(first.Unavailable);
        Assert.True(first.TransientFailure, "读失败被当成了『这页没有内容』");

        // 存储恢复后，同一个 site 必须能立刻拿到内容——说明上一次的失败没被缓存
        storage.Objects["k0"] = "恢复之后的正文";
        var second = await svc.GetAsync(site);

        Assert.Null(second.Unavailable);
        Assert.Contains("恢复之后的正文", second.Text);
    }

    [Fact]
    public async Task 视频站没有正文是事实_不算暂时故障()
    {
        var site = SiteWith(("index.html", "k0"));
        site.WrappedAssetType = "video";

        var snap = await NewService(new FakeAssetStorage()).GetAsync(site);

        Assert.NotNull(snap.Unavailable);
        Assert.False(snap.TransientFailure, "视频站没有正文是稳定事实，应当可以缓存");
    }

    [Fact]
    public async Task 部分读失败但攒到了正文_标截断而不是不可用()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["k0"] = "读到了的正文";
        // k1 故意不放 → 读不回来

        var snap = await NewService(storage).GetAsync(SiteWith(("index.html", "k0"), ("b.html", "k1")));

        Assert.Null(snap.Unavailable);
        Assert.Contains("读到了的正文", snap.Text);
        Assert.True(snap.Truncated, "有文件没读回来，内容就是不完整的，必须如实标注");
    }

    [Fact]
    public async Task 成功的快照会被缓存_第二次不再打存储()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["k0"] = "正文";
        var site = SiteWith(("index.html", "k0"));
        var svc = NewService(storage);

        await svc.GetAsync(site);
        var callsAfterFirst = storage.DownloadCalls;
        await svc.GetAsync(site);

        Assert.Equal(callsAfterFirst, storage.DownloadCalls);
    }

    // ── 手写替身（本测试项目没有 mock 库） ────────────────────

    private sealed class FakeAssetStorage : IAssetStorage
    {
        public Dictionary<string, string> Objects { get; } = new();
        public int DownloadCalls { get; private set; }

        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
        {
            DownloadCalls++;
            return Task.FromResult(Objects.TryGetValue(key, out var s)
                ? System.Text.Encoding.UTF8.GetBytes(s)
                : null);
        }

        // 以下成员本用例用不到
        public Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null, string? fileName = null, string? extensionHint = null)
            => throw new NotSupportedException();
        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => throw new NotSupportedException();
        public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => throw new NotSupportedException();
        public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
            => throw new NotSupportedException();
        public Task<bool> ExistsAsync(string key, CancellationToken ct) => throw new NotSupportedException();
        public Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null)
            => throw new NotSupportedException();
        public string BuildUrlForKey(string key) => throw new NotSupportedException();
        public Task DeleteByKeyAsync(string key, CancellationToken ct) => throw new NotSupportedException();
        public string BuildSiteKey(string siteId, string filePath) => $"{siteId}/{filePath}";
    }

    private sealed class FakeExtractor : IFileContentExtractor
    {
        public string? Extract(byte[] bytes, string mimeType, string? fileName = null)
            => System.Text.Encoding.UTF8.GetString(bytes);
        public bool IsSupported(string mimeType) => true;
    }
}
