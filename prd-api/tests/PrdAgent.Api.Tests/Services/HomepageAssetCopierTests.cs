using System.Net;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 守卫两件事。
///
/// 一、**挂上首页槽位的地址，必须是我们自己存的那份，不能是供应商给的那串。**
/// 这条的代价不对称，所以值得一条专门的用例：供应商的临时/签名地址挂上去，生成当天
/// 首页一切正常，等它过期，未登录访客看到的是一排裂图，而管理端不报错——**没有人会在
/// 过期那天恰好在看那一屏**。等发现时已经过去几个月。
///
/// 二、**那个地址是模型供应商给的，不是我们写的**，所以「连去哪、回来多少、回来的是什么」
/// 三处都得当它是敌意的：它可以指向内网或云元数据（我们的服务端会去连）、可以无限长
/// （我们会整包吃进内存）、可以根本不是图片（我们会把它存进公网可读的存储）。
///
/// 判据读的是 <see cref="HomepageAssetCopier.CopyAsync"/> 的返回值与替身记下的实际调用，
/// 不是扫源码里有没有调 upload / 有没有出现 SafeOutbound 字样：值来自哪、请求发没发出去，
/// 只有跑一遍才知道。
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
    /// mime 由字节说了算，不是由对方说了算：Content-Type 是响应头，谁发响应谁写。
    /// 照它落库，存储里就躺着一个 MIME 由外人决定的对象，扩展名也跟着错。
    /// </summary>
    [Fact]
    public async Task mime以字节为准而不是照对方自报的()
    {
        var storage = new RecordingAssetStorage();
        var copier = Build(storage, PngBytes, "image/jpeg");

        var copied = await copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None);

        copied.Mime.ShouldBe("image/png");
        copied.ObjectKey.ShouldEndWith(".png");
    }

    /// <summary>
    /// 签名地址过期时，对象存储回的常常是一页 XML/HTML 错误说明，而且照样带着
    /// 一个像模像样的 Content-Type。认字节就不会被这种响应骗进存储。
    /// </summary>
    [Fact]
    public async Task 不是图片的内容一律拒收()
    {
        var storage = new RecordingAssetStorage();
        var html = "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code></Error>"u8.ToArray();
        var copier = Build(storage, html, "image/png");

        var ex = await Should.ThrowAsync<HomepageAssetCopier.CopyFailedException>(
            () => copier.CopyAsync(ProviderUrl, ext => $"icon/homepage/landing/hero.{ext}", CancellationToken.None));

        ex.Message.ShouldContain("不是我们认得的图片");
        storage.Uploaded.ShouldBeEmpty();
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

    /// <summary>
    /// 上一条走的是「对方自报长度」那条路。可自报的长度也可以不报——先整包读进内存再
    /// 判断大小的写法，那个上限只是个事后说法：对方给多少我们就吃多少，判断发生在
    /// 内存已经被撑起来之后。所以这里给一份 40MB、不带 Content-Length 的响应，
    /// 断言读到的字节数停在上限附近，而不是读完。
    /// </summary>
    [Fact]
    public async Task 对方不报长度时边读边数并且到上限就停()
    {
        var storage = new RecordingAssetStorage();
        var body = new CountingStream(HomepageAssetCopier.MaxBytes * 2);
        var copier = Build(storage, _ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(body),
        });

        var ex = await Should.ThrowAsync<HomepageAssetCopier.CopyFailedException>(
            () => copier.CopyAsync(ProviderUrl, e => $"icon/homepage/landing/hero.{e}", CancellationToken.None));

        ex.Message.ShouldContain("20MB");
        storage.Uploaded.ShouldBeEmpty();
        body.ReadBytes.ShouldBeLessThan(HomepageAssetCopier.MaxBytes + 1024 * 1024);
    }

    /// <summary>
    /// 这个地址来自模型供应商的响应，而发请求的是我们的服务端——它站在内网里。
    /// 一个指向 169.254.169.254 / 127.0.0.1 / 内网段的地址，会让首页认领变成
    /// 「让服务器替你去打内网，再把打回来的东西存进公网可读的存储」。
    /// 判据是**请求压根没发出去**，不是「发出去但失败了」。
    /// </summary>
    [Fact]
    public async Task 地址指向内网时压根不发请求()
    {
        var storage = new RecordingAssetStorage();
        var validator = new StubUrlValidator();
        validator.BlockedHosts.Add("169.254.169.254");
        var handler = new StubHandler(_ => Ok(PngBytes, "image/png"));
        var copier = new HomepageAssetCopier(new StubHttpClientFactory(handler), storage, validator);

        var ex = await Should.ThrowAsync<HomepageAssetCopier.CopyFailedException>(
            () => copier.CopyAsync("http://169.254.169.254/latest/meta-data/iam/security-credentials/",
                e => $"icon/homepage/landing/hero.{e}", CancellationToken.None));

        ex.Message.ShouldContain("内网");
        handler.Requests.ShouldBeEmpty();
        storage.Uploaded.ShouldBeEmpty();
    }

    /// <summary>
    /// 只校验第一跳等于没校验：一个公网地址 302 跳到 127.0.0.1 就绕过去了。
    /// 所以跳转不交给 HttpClient 自动跟，而是自己跟、每一跳重新过校验。
    /// </summary>
    [Fact]
    public async Task 跳转的每一跳都重新校验()
    {
        var storage = new RecordingAssetStorage();
        var validator = new StubUrlValidator();
        validator.BlockedHosts.Add("127.0.0.1");
        var handler = new StubHandler(req => req.RequestUri!.Host == "provider.example.com"
            ? Redirect("http://127.0.0.1:9200/_cluster/health")
            : Ok(PngBytes, "image/png"));
        var copier = new HomepageAssetCopier(new StubHttpClientFactory(handler), storage, validator);

        var ex = await Should.ThrowAsync<HomepageAssetCopier.CopyFailedException>(
            () => copier.CopyAsync(ProviderUrl, e => $"icon/homepage/landing/hero.{e}", CancellationToken.None));

        ex.Message.ShouldContain("内网");
        validator.Checked.Count.ShouldBe(2);
        validator.Checked[1].ShouldStartWith("http://127.0.0.1:9200/");
        // 第一跳发出去了，第二跳被拦在发请求之前
        handler.Requests.Count.ShouldBe(1);
        storage.Uploaded.ShouldBeEmpty();
    }

    /// <summary>
    /// 接线守卫：内网校验的另一半在 HttpClient 那侧——`SafeOutbound` 这个命名客户端
    /// 的 handler 会在**建连时**再把解析出的每个 IP 过一遍（DNS 重绑定就是靠这一层挡的）。
    /// 取成默认客户端的话，上面那两条用例照样绿，而真实出站没有任何防护。
    /// </summary>
    [Fact]
    public async Task 用的是SafeOutbound那个命名客户端()
    {
        var storage = new RecordingAssetStorage();
        var factory = new StubHttpClientFactory(new StubHandler(_ => Ok(PngBytes, "image/png")));
        var copier = new HomepageAssetCopier(factory, storage, new StubUrlValidator());

        await copier.CopyAsync(ProviderUrl, e => $"icon/homepage/landing/hero.{e}", CancellationToken.None);

        factory.RequestedNames.ShouldBe(["SafeOutbound"]);
    }

    // ── 组装与响应构造 ────────────────────────────────────────

    private static HomepageAssetCopier Build(
        RecordingAssetStorage storage,
        byte[] body,
        string contentType,
        HttpStatusCode status = HttpStatusCode.OK)
        => Build(storage, _ => Ok(body, contentType, status));

    private static HomepageAssetCopier Build(
        RecordingAssetStorage storage,
        Func<HttpRequestMessage, HttpResponseMessage> responder)
        => new(new StubHttpClientFactory(new StubHandler(responder)), storage, new StubUrlValidator());

    private static HttpResponseMessage Ok(byte[] body, string contentType, HttpStatusCode status = HttpStatusCode.OK)
    {
        var content = new ByteArrayContent(body);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
        return new HttpResponseMessage(status) { Content = content };
    }

    private static HttpResponseMessage Redirect(string location)
    {
        var resp = new HttpResponseMessage(HttpStatusCode.Found) { Content = new ByteArrayContent([]) };
        resp.Headers.Location = new Uri(location);
        return resp;
    }

    // ── 手写替身（本测试项目没有 mock 库）────────────────────

    private sealed class StubHttpClientFactory(StubHandler handler) : IHttpClientFactory
    {
        public List<string> RequestedNames { get; } = [];

        public HttpClient CreateClient(string name)
        {
            RequestedNames.Add(name);
            return new HttpClient(handler, disposeHandler: false);
        }
    }

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request.RequestUri!);
            return Task.FromResult(responder(request));
        }
    }

    private sealed class StubUrlValidator : ISafeOutboundUrlValidator
    {
        public List<string> Checked { get; } = [];
        public HashSet<string> BlockedHosts { get; } = new(StringComparer.OrdinalIgnoreCase);

        public Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default)
        {
            Checked.Add(url ?? string.Empty);
            var uri = new Uri(url!);
            if (BlockedHosts.Contains(uri.Host))
                throw new InvalidOperationException($"{purpose} 不允许指向内网或保留地址");
            return Task.FromResult(uri);
        }

        public bool IsSafeAddress(System.Net.IPAddress address) => true;
    }

    /// <summary>一份很大的响应体，记录实际被读走多少字节；开头是 PNG 魔数，免得先被 mime 判据拦下。</summary>
    private sealed class CountingStream(long total) : Stream
    {
        private static readonly byte[] Magic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

        public long ReadBytes { get; private set; }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (ReadBytes >= total) return 0;
            var n = (int)Math.Min(count, total - ReadBytes);
            Array.Clear(buffer, offset, n);
            for (var i = 0; i < n && ReadBytes + i < Magic.Length; i++)
                buffer[offset + i] = Magic[(int)(ReadBytes + i)];
            ReadBytes += n;
            return n;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override void Flush() { }
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
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
