using System.Net;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 守卫：**挂上首页槽位的地址，必须是我们自己存的那份，不能是供应商给的那串。**
///
/// 这条的代价不对称，所以值得一条专门的用例：供应商的临时/签名地址挂上去，生成当天
/// 首页一切正常，等它过期，未登录访客看到的是一排裂图，而管理端不报错——**没有人会在
/// 过期那天恰好在看那一屏**。等发现时已经过去几个月。
///
/// 判据读的是 <see cref="HomepageAssetCopier.CopyAsync"/> 的返回值（真正会写进槽位的那个
/// 地址），不是扫源码里有没有调 upload：值来自哪、有没有真的上传，只有跑一遍才知道。
/// </summary>
public sealed class HomepageAssetCopierTests
{
    private const string ProviderUrl = "https://provider.example.com/gen/abc.png?sig=expires-in-an-hour";
    private static readonly byte[] PngBytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

    [Fact]
    public async Task 复制之后拿到的是本站地址而不是供应商地址()
    {
        var storage = new RecordingAssetStorage();
        var copier = Build(storage, PngBytes, "image/png");

        var copied = await copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None);

        copied.Url.ShouldBe("https://cdn.example.com/icon/homepage/landing/hero.png");
        copied.Url.ShouldNotBe(ProviderUrl);
        copied.ObjectKey.ShouldBe("icon/homepage/landing/hero.png");
        copied.SizeBytes.ShouldBe(PngBytes.LongLength);
    }

    [Fact]
    public async Task 字节真的被上传到了那个key()
    {
        var storage = new RecordingAssetStorage();
        var copier = Build(storage, PngBytes, "image/png");

        await copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None);

        storage.Uploaded.ShouldContainKey("icon/homepage/landing/hero.png");
        storage.Uploaded["icon/homepage/landing/hero.png"].bytes.ShouldBe(PngBytes);
        storage.Uploaded["icon/homepage/landing/hero.png"].mime.ShouldBe("image/png");
    }

    /// <summary>
    /// CDN 常回 application/octet-stream。照它落库，前端 img 认不出这个 mime；
    /// 所以通用类型要按字节里的魔数重判，扩展名也跟着走。
    /// </summary>
    [Fact]
    public async Task 通用mime按字节重判而不是照单全收()
    {
        var storage = new RecordingAssetStorage();
        var copier = Build(storage, PngBytes, "application/octet-stream");

        var copied = await copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None);

        copied.Mime.ShouldBe("image/png");
        copied.ObjectKey.ShouldEndWith(".png");
    }

    [Fact]
    public async Task 地址已经失效时明确报错而不是把坏地址写进槽位()
    {
        var storage = new RecordingAssetStorage();
        var copier = Build(storage, PngBytes, "image/png", HttpStatusCode.Forbidden);

        var ex = await Should.ThrowAsync<HomepageAssetCopier.CopyFailedException>(
            () => copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None));

        ex.Message.ShouldContain("403");
        storage.Uploaded.ShouldBeEmpty();
    }

    [Fact]
    public async Task 空内容不落库()
    {
        var storage = new RecordingAssetStorage();
        var copier = Build(storage, [], "image/png");

        await Should.ThrowAsync<HomepageAssetCopier.CopyFailedException>(
            () => copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None));
        storage.Uploaded.ShouldBeEmpty();
    }

    [Fact]
    public async Task 超过上限的图不落库()
    {
        var storage = new RecordingAssetStorage();
        var tooBig = new byte[HomepageAssetCopier.MaxBytes + 1];
        tooBig[0] = 0x89; tooBig[1] = 0x50; tooBig[2] = 0x4E; tooBig[3] = 0x47;
        var copier = Build(storage, tooBig, "image/png");

        var ex = await Should.ThrowAsync<HomepageAssetCopier.CopyFailedException>(
            () => copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None));

        ex.Message.ShouldContain("20MB");
        storage.Uploaded.ShouldBeEmpty();
    }

    private static HomepageAssetCopier Build(
        RecordingAssetStorage storage,
        byte[] body,
        string contentType,
        HttpStatusCode status = HttpStatusCode.OK)
        => new(new StubHttpClientFactory(body, contentType, status), storage);

    // ── 手写替身（本测试项目没有 mock 库）────────────────────

    private sealed class StubHttpClientFactory(byte[] body, string contentType, HttpStatusCode status)
        : IHttpClientFactory
    {
        public HttpClient CreateClient(string name = "") => new(new StubHandler(body, contentType, status));
    }

    private sealed class StubHandler(byte[] body, string contentType, HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var content = new ByteArrayContent(body);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
            return Task.FromResult(new HttpResponseMessage(status) { Content = content });
        }
    }

    private sealed class RecordingAssetStorage : IAssetStorage
    {
        public Dictionary<string, (byte[] bytes, string? mime)> Uploaded { get; } = new();

        public Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null)
        {
            Uploaded[key] = (bytes, contentType);
            return Task.CompletedTask;
        }

        public string BuildUrlForKey(string key) => $"https://cdn.example.com/{key}";

        // 以下成员本用例用不到
        public Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null, string? fileName = null, string? extensionHint = null)
            => throw new NotSupportedException();
        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => throw new NotSupportedException();
        public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => throw new NotSupportedException();
        public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
            => throw new NotSupportedException();
        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct) => throw new NotSupportedException();
        public Task<bool> ExistsAsync(string key, CancellationToken ct) => throw new NotSupportedException();
        public Task DeleteByKeyAsync(string key, CancellationToken ct) => throw new NotSupportedException();
        public string BuildSiteKey(string siteId, string filePath) => $"{siteId}/{filePath}";
    }
}
