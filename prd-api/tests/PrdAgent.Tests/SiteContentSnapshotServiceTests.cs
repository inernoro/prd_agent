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

    private static SiteContentSnapshotService NewService(FakeAssetStorage storage, StubHttpHandler handler) =>
        new(storage,
            new FakeExtractor(),
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<SiteContentSnapshotService>.Instance,
            new FakeHttpClientFactory(handler));

    private static HostedSite SiteWith(params (string Path, string Key)[] files) => new()
    {
        Id = "site-1",
        Title = "测试站点",
        EntryFile = "index.html",
        SiteUrl = "https://legacy-storage.example/data/web-hosting/sites/site-1/index.html",
        Files = files.Select(f => new HostedSiteFile
        {
            Path = f.Path,
            CosKey = f.Key,
            Size = 100,
            MimeType = "text/html",
        }).ToList(),
    };

    private static HostedSite SiteWithSized(params (string Path, string Key, long Size)[] files) => new()
    {
        Id = "site-1",
        Title = "测试站点",
        EntryFile = "index.html",
        Files = files.Select(f => new HostedSiteFile
        {
            Path = f.Path,
            CosKey = f.Key,
            Size = f.Size,
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
    public async Task 单文件长页面_使用完整总预算而不是固定截在八千字()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["entry"] = new string('前', 9_000) + "三元决策思想：风险分、置信度、业务价值";

        var snap = await NewService(storage).GetAsync(SiteWith(("index.html", "entry")));

        Assert.Null(snap.Unavailable);
        Assert.Contains("风险分、置信度、业务价值", snap.Text);
        Assert.False(snap.Truncated, "不足总预算的单页正文不应在 8000 字处被截断");
    }

    [Fact]
    public async Task React单文件页面_提取模块脚本中的可见中文文案()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["entry"] = """
            <!doctype html><html><head><title>扫码风控</title></head><body>
            <div id="root"></div>
            <script type="module">
            const quotePattern=/"/g;
            const page={className:"grid gap-8",children:["借鉴三元决策思想：",jsx("strong",{children:"风险分 + 置信度 + 业务价值"})]};
            </script></body></html>
            """;

        var snap = await NewService(storage).GetAsync(SiteWith(("index.html", "entry")));

        Assert.Null(snap.Unavailable);
        Assert.Contains("借鉴三元决策思想", snap.Text);
        Assert.Contains("风险分 + 置信度 + 业务价值", snap.Text);
        Assert.DoesNotContain("grid gap-8", snap.Text);
    }

    [Fact]
    public async Task 服务端已有可见正文时_不把隐藏脚本字符串当成页面内容()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["entry"] = """
            <!doctype html><html><head><title>公开报告</title></head><body>
            <main><h1>访客可见结论</h1></main>
            <script type="module">
            const hiddenAdminLabel="管理员专用密钥已失效";
            const hydrationCopy="访客可见结论";
            </script></body></html>
            """;

        var snap = await NewService(storage).GetAsync(SiteWith(("index.html", "entry")));

        Assert.Null(snap.Unavailable);
        Assert.Contains("访客可见结论", snap.Text);
        Assert.DoesNotContain("管理员专用密钥已失效", snap.Text);
        Assert.Equal(1, System.Text.RegularExpressions.Regex.Matches(snap.Text, "访客可见结论").Count);
    }

    [Fact]
    public async Task 当前存储缺少存量入口时_从落库站点地址读取正文()
    {
        var storage = new FakeAssetStorage();
        var factory = new FakeHttpClientFactory(new StubHttpHandler(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent("旧腾讯云入口仍可读取的正文"),
        }));

        var snap = await new SiteContentSnapshotService(
            storage,
            new FakeExtractor(),
            new MemoryCache(new MemoryCacheOptions()),
            NullLogger<SiteContentSnapshotService>.Instance,
            factory).GetAsync(SiteWith(("index.html", "old-cos-key")));

        Assert.Null(snap.Unavailable);
        Assert.False(snap.TransientFailure);
        Assert.Contains("旧腾讯云入口仍可读取的正文", snap.Text);
        Assert.Equal(new[] { "SafeOutbound" }, factory.ClientNames);
        Assert.Single(factory.Handler.Requests);
        Assert.Equal("legacy-storage.example", factory.Handler.Requests[0].RequestUri?.Host);
    }

    [Fact]
    public async Task 公网回退只允许入口文件_兄弟文件缺失仍标截断()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["entry"] = "入口正文";
        var handler = new StubHttpHandler(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent("不应被拿来冒充兄弟文件"),
        });

        var snap = await NewService(storage, handler).GetAsync(
            SiteWith(("index.html", "entry"), ("chapter.html", "missing")));

        Assert.Contains("入口正文", snap.Text);
        Assert.DoesNotContain("不应被拿来冒充兄弟文件", snap.Text);
        Assert.True(snap.Truncated);
        Assert.Empty(handler.Requests);
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

    // ── 体积上限：下载之前就挡住 ──────────────────────────────

    /// <summary>
    /// 核心用例：超大文件在**下载之前**就被剔掉。
    ///
    /// 由 PR #1351 第十一轮 review 抓出，与已修的匿名正文代理是同一个形状：
    /// 托管上传允许到 500MB，而提问端点匿名可达。没有这道闸，一次未命中缓存的提问
    /// 就会把几百 MB 读进内存再对整串跑正则，反复打即可拖垮 API。
    /// PerFileBudget 只截「抽完之后」的文本，拦不住下载与抽取本身。
    /// </summary>
    [Fact]
    public async Task 超大文件不下载_且如实标截断()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["big"] = "巨大的正文";
        storage.Objects["small"] = "正常正文";

        var site = SiteWithSized(
            ("index.html", "small", 100),
            ("huge.txt", "big", 50L * 1024 * 1024));

        var snap = await NewService(storage).GetAsync(site);

        Assert.Contains("正常正文", snap.Text);
        Assert.DoesNotContain("巨大的正文", snap.Text);
        Assert.True(snap.Truncated, "被体积上限挡掉的文件必须反映到 Truncated 上");
        // 关键：那个 key 根本不该被读过
        Assert.DoesNotContain("big", storage.RequestedKeys);
    }

    [Fact]
    public async Task 入口文件超大时也不下载()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["entry"] = "入口正文";

        var site = SiteWithSized(("index.html", "entry", 50L * 1024 * 1024));

        var snap = await NewService(storage).GetAsync(site);

        Assert.DoesNotContain("entry", storage.RequestedKeys);
        Assert.NotNull(snap.Unavailable);
    }

    /// <summary>
    /// 核心用例：PDF 包装站同样受体积上限约束。
    ///
    /// 由 PR #1351 第十二轮 review 抓出：上一版把体积过滤放在 PDF 分支**之后**，
    /// 于是 PDF 站整条路绕过闸门——一个 200MB 的 PDF，拿公开分享 token 每问一次就整份下载 + 抽取。
    /// 修法不是给 PDF 分支再补一道判断，而是把闸门提到所有分支之前，
    /// 让任何新增站点形态都不可能绕过。这条用例锁的就是「提到分支之前」这件事。
    /// </summary>
    [Fact]
    public async Task 超大PDF包装站也不下载()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["pdfkey"] = "PDF 正文";

        var site = SiteWithSized(("doc.pdf", "pdfkey", 200L * 1024 * 1024));
        site.WrappedAssetType = "pdf";

        var snap = await NewService(storage).GetAsync(site);

        Assert.False(storage.RequestedKeys.Contains("pdfkey"), "超大 PDF 仍被下载——闸门放在了分支之后");
        Assert.NotNull(snap.Unavailable);
    }

    [Fact]
    public async Task 正常体积的PDF包装站照常读取()
    {
        var storage = new FakeAssetStorage();
        storage.Objects["pdfkey"] = "PDF 正文";

        var site = SiteWithSized(("doc.pdf", "pdfkey", 1024));
        site.WrappedAssetType = "pdf";

        var snap = await NewService(storage).GetAsync(site);

        Assert.Null(snap.Unavailable);
        Assert.Contains("PDF 正文", snap.Text);
    }

    // ── 手写替身（本测试项目没有 mock 库） ────────────────────

    private sealed class FakeAssetStorage : IAssetStorage
    {
        public Dictionary<string, string> Objects { get; } = new();
        public int DownloadCalls { get; private set; }
        /// <summary>实际发起过下载的 key。用来断言「超大文件根本没被读」。</summary>
        public HashSet<string> RequestedKeys { get; } = new();

        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
        {
            DownloadCalls++;
            RequestedKeys.Add(key);
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

    private sealed class FakeHttpClientFactory(StubHttpHandler handler) : IHttpClientFactory
    {
        public StubHttpHandler Handler { get; } = handler;
        public List<string> ClientNames { get; } = new();

        public HttpClient CreateClient(string name)
        {
            ClientNames.Add(name);
            return new HttpClient(Handler, disposeHandler: false);
        }
    }

    private sealed class StubHttpHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(response);
        }
    }
}
