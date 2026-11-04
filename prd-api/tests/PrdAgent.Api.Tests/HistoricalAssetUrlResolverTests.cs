using System.Net;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

public class HistoricalAssetUrlResolverTests
{
    private const string Key = "data/defect-agent/img/abcdefghijklmnopqrstuvwxyz.png";
    private static IConfiguration Config(string provider = "cloudflareR2") => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ASSETS_PROVIDER"] = provider,
            ["R2_PUBLIC_BASE_URL"] = "https://current.example",
            ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://legacy.example"
        }).Build();

    [Fact]
    public async Task 旧附件只探测受信旧源且长度一致后恢复并缓存()
    {
        var transport = new Probe(HttpStatusCode.OK, 42);
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        var attachment = new DefectAttachment { Url = $"https://expired.example/{Key}", FileSize = 42 };
        (await resolver.ResolveAttachmentUrlAsync(attachment, default)).ShouldBe($"https://legacy.example/{Key}");
        (await resolver.ResolveAttachmentUrlAsync(attachment, default)).ShouldBe($"https://legacy.example/{Key}");
        transport.Urls.ShouldHaveSingleItem().ShouldBe($"https://legacy.example/{Key}");
        attachment.Url.ShouldBe($"https://expired.example/{Key}");
    }

    [Theory]
    [InlineData("https://current.example/" + Key)]
    [InlineData("https://legacy.example/" + Key)]
    [InlineData("https://native-assets-1250000000.cos.ap-test.myqcloud.com/" + Key)]
    [InlineData("https://outside.example/other/file.png")]
    [InlineData("https://outside.example/" + Key + "?signature=opaque")]
    [InlineData("https://outside.example/data/defect-agent/img/../../secret.png")]
    public async Task 当前资源及不属于规范附件的链接保持不变且不探测(string url)
    {
        var transport = new Probe(HttpStatusCode.OK, 42);
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        (await resolver.ResolveAttachmentUrlAsync(new() { Url = url, FileSize = 42 }, default)).ShouldBe(url);
        transport.Urls.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound, 42)]
    [InlineData(HttpStatusCode.OK, 41)]
    [InlineData(HttpStatusCode.Redirect, 42)]
    public async Task 旧源缺失长度不符或重定向均不冒充恢复(HttpStatusCode status, long size)
    {
        var transport = new Probe(status, size);
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        var original = $"https://expired.example/{Key}";
        (await resolver.ResolveAttachmentUrlAsync(new() { Url = original, FileSize = 42 }, default)).ShouldBe(original);
    }

    [Fact]
    public async Task 整页仅更改内存响应并保留当前R2对象()
    {
        using var resolver = new HistoricalAssetUrlResolver(Config(), new Probe(HttpStatusCode.OK, 42));
        var old = new DefectAttachment { Url = $"https://expired.example/{Key}", ThumbnailUrl = $"https://expired.example/{Key}", FileSize = 42 };
        var current = new DefectAttachment { Url = $"https://current.example/{Key}", FileSize = 42 };
        await resolver.ResolveAttachmentsForReadAsync(new[] { new DefectReport { Attachments = [old, current] } }, default);
        old.Url.ShouldBe($"https://legacy.example/{Key}");
        old.ThumbnailUrl.ShouldBe(old.Url);
        current.Url.ShouldBe($"https://current.example/{Key}");
    }

    [Fact]
    public void 本地或COS模式不启用跨提供方兼容()
    {
        HistoricalAssetUrlResolver.ResolveLegacyPublicBaseUrl(Config("local")).ShouldBeNull();
        HistoricalAssetUrlResolver.ResolveLegacyPublicBaseUrl(Config("tencentCos")).ShouldBeNull();
    }

    [Fact]
    public async Task 整页探测有共同预算且并发不超过四个()
    {
        var transport = new SlowProbe();
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        var attachments = Enumerable.Range(0, 20).Select(i => new DefectAttachment
        {
            Url = $"https://expired.example/data/defect-agent/img/{i:D26}.png", FileSize = 42
        }).ToList();
        var originals = attachments.Select(x => x.Url).ToList();
        await resolver.ResolveAttachmentsForReadAsync(new[] { new DefectReport { Attachments = attachments } }, default);
        transport.MaxActive.ShouldBeInRange(1, 4);
        transport.Active.ShouldBe(0);
        attachments.Select(x => x.Url).ShouldBe(originals);
    }

    [Fact]
    public async Task 冷列表先核验旧图且正常原生COS与排前日志不会饿死图片()
    {
        var transport = new DelayedProbe();
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        var native = Enumerable.Range(0, 26).Select(i => new DefectAttachment
        {
            Url = $"https://native-assets-1250000000.cos.ap-test.myqcloud.com/data/defect-agent/{(i < 11 ? "img" : "log")}/{i:D26}.{(i < 11 ? "png" : "txt")}",
            MimeType = i < 11 ? "image/png" : "text/plain", FileSize = 42
        }).ToList();
        var logs = Enumerable.Range(0, 29).Select(i => new DefectAttachment
        {
            Url = $"https://expired.example/data/defect-agent/log/{i:D26}.txt", MimeType = "text/plain", FileSize = 42
        }).ToList();
        var images = Enumerable.Range(0, 20).Select(i => new DefectAttachment
        {
            Url = $"https://expired.example/data/defect-agent/img/{i:D26}.png", MimeType = "image/png", FileSize = 42
        }).ToList();
        var nativeOriginals = native.Select(x => x.Url).ToList();
        await resolver.ResolveAttachmentsForReadAsync(new[] { new DefectReport { Attachments = [.. native, .. logs, .. images] } }, default);
        native.Select(x => x.Url).ShouldBe(nativeOriginals);
        images.ShouldAllBe(x => x.Url.StartsWith("https://legacy.example/data/defect-agent/img/"));
        transport.Urls.Count(x => x.Contains("/img/")).ShouldBe(20);
        transport.Urls.Count(x => x.Contains("/log/")).ShouldBeLessThanOrEqualTo(4);
        transport.MaxActive.ShouldBeInRange(1, 4);
        transport.Active.ShouldBe(0);
    }

    private sealed class DelayedProbe : HttpMessageHandler, IHttpClientFactory
    {
        private readonly object _gate = new();
        public int Active { get; private set; }
        public int MaxActive { get; private set; }
        public System.Collections.Concurrent.ConcurrentQueue<string> Urls { get; } = new();
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Urls.Enqueue(request.RequestUri!.AbsoluteUri);
            lock (_gate) { Active++; MaxActive = Math.Max(MaxActive, Active); }
            try
            {
                await Task.Delay(request.RequestUri.AbsolutePath.Contains("/img/") ? 625 : Timeout.Infinite, ct);
                var response = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new ByteArrayContent([]) };
                response.Content.Headers.ContentLength = 42;
                return response;
            }
            finally { lock (_gate) { Active--; } }
        }
    }

    private sealed class SlowProbe : HttpMessageHandler, IHttpClientFactory
    {
        private readonly object _gate = new();
        public int Active { get; private set; }
        public int MaxActive { get; private set; }
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            lock (_gate) { Active++; MaxActive = Math.Max(MaxActive, Active); }
            try
            {
                await Task.Delay(Timeout.Infinite, ct);
                throw new InvalidOperationException("探测应被共同预算取消");
            }
            finally { lock (_gate) { Active--; } }
        }
    }

    private sealed class Probe(HttpStatusCode status, long size) : HttpMessageHandler, IHttpClientFactory
    {
        public List<string> Urls { get; } = [];
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            request.Method.ShouldBe(HttpMethod.Head);
            Urls.Add(request.RequestUri!.AbsoluteUri);
            var response = new HttpResponseMessage(status) { RequestMessage = request, Content = new ByteArrayContent([]) };
            response.Content.Headers.ContentLength = size;
            return Task.FromResult(response);
        }
    }
}
