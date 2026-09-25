using System.Text;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 离线 HTML 内嵌器：路径解析、CSS 内嵌、url() 转 data:、缺失上报、不越出站点根、体积上限。
/// 纯逻辑，不碰存储——读字节由测试给的字典回答，并记下被读过哪些文件。
/// </summary>
public sealed class HostedSiteHtmlInlinerTests
{
    private sealed class FakeSite
    {
        private readonly Dictionary<string, byte[]> _bytes = new(StringComparer.Ordinal);
        private readonly HashSet<string> _unreadable = new(StringComparer.Ordinal);
        public List<string> Reads { get; } = new();

        public FakeSite Add(string path, string text, string? mime = null) => Add(path, Encoding.UTF8.GetBytes(text), mime);

        public FakeSite Add(string path, byte[] bytes, string? mime = null)
        {
            _bytes[path] = bytes;
            _mimes[path] = mime;
            return this;
        }

        public FakeSite Unreadable(string path, long size = 10)
        {
            _unreadable.Add(path);
            _sizes[path] = size;
            return this;
        }

        private readonly Dictionary<string, string?> _mimes = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _sizes = new(StringComparer.Ordinal);

        public IEnumerable<HostedSiteInlineFile> Files =>
            _bytes.Select(kv => new HostedSiteInlineFile(kv.Key, kv.Value.Length, _mimes[kv.Key], "key/" + kv.Key))
                .Concat(_unreadable.Select(p => new HostedSiteInlineFile(p, _sizes[p], null, "key/" + p)));

        public HostedSiteHtmlInliner Inliner(long max = HostedSiteHtmlInliner.DefaultMaxOutputBytes) =>
            new(Files, (file, _) =>
            {
                Reads.Add(file.StorageKey!);
                return Task.FromResult(_bytes.TryGetValue(file.Path, out var b) ? b : null);
            }, max);
    }

    private static string B64(string text) => Convert.ToBase64String(Encoding.UTF8.GetBytes(text));

    [Theory]
    [InlineData("index.html", "css/a.css", HostedSiteReferenceKind.Site, "css/a.css")]
    [InlineData("pages/p.html", "../img/x.png", HostedSiteReferenceKind.Site, "img/x.png")]
    [InlineData("pages/p.html", "./x.png?v=3#frag", HostedSiteReferenceKind.Site, "pages/x.png")]
    [InlineData("pages/p.html", "/img/x.png", HostedSiteReferenceKind.Site, "img/x.png")]
    [InlineData("index.html", "img%20dir/a%20b.png", HostedSiteReferenceKind.Site, "img dir/a b.png")]
    [InlineData("index.html", "img\\x.png", HostedSiteReferenceKind.Site, "img/x.png")]
    [InlineData("index.html", "../secret.css", HostedSiteReferenceKind.OutsideSiteRoot, null)]
    [InlineData("a/b.html", "../../x.css", HostedSiteReferenceKind.OutsideSiteRoot, null)]
    [InlineData("index.html", "%2e%2e/x.css", HostedSiteReferenceKind.OutsideSiteRoot, null)]
    [InlineData("index.html", "https://cdn.example.com/a.css", HostedSiteReferenceKind.External, null)]
    [InlineData("index.html", "//cdn.example.com/a.js", HostedSiteReferenceKind.External, null)]
    [InlineData("index.html", "data:image/png;base64,AAAA", HostedSiteReferenceKind.Ignored, null)]
    [InlineData("index.html", "#top", HostedSiteReferenceKind.Ignored, null)]
    [InlineData("index.html", "javascript:void(0)", HostedSiteReferenceKind.Ignored, null)]
    [InlineData("index.html", "", HostedSiteReferenceKind.Ignored, null)]
    public void ResolveReference_规范化相对路径且不越出站点根(
        string basePath, string reference, HostedSiteReferenceKind kind, string? path)
    {
        var resolved = HostedSiteHtmlInliner.ResolveReference(basePath, reference);
        Assert.Equal(kind, resolved.Kind);
        Assert.Equal(path, resolved.Path);
    }

    [Fact]
    public async Task 样式表变成style_脚本变成内联script_图片变成dataUri()
    {
        var site = new FakeSite()
            .Add("css/app.css", "body{color:red}")
            .Add("js/app.js", "console.log('hi')")
            .Add("img/logo.png", new byte[] { 1, 2, 3 }, "image/png");
        const string html = """
            <html><head>
            <link rel="stylesheet" href="css/app.css?v=2" media="screen">
            <script src="js/app.js" integrity="sha384-x" defer></script>
            </head><body><img src="img/logo.png" alt="logo"></body></html>
            """;

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.True(result.Succeeded);
        Assert.Contains("<style media=\"screen\">body{color:red}</style>", result.Html);
        Assert.Contains("<script defer>console.log('hi')</script>", result.Html);
        Assert.DoesNotContain("integrity", result.Html);
        Assert.Contains($"src=\"data:image/png;base64,{Convert.ToBase64String(new byte[] { 1, 2, 3 })}\"", result.Html);
        Assert.Contains("alt=\"logo\"", result.Html);
        Assert.Empty(result.Missing);
        Assert.Equal(3, result.InlinedCount);
    }

    [Fact]
    public async Task 内嵌样式表里的url按样式表自己的目录解析()
    {
        var site = new FakeSite()
            .Add("assets/css/theme.css", "@font-face{src:url('../fonts/a.woff2') format('woff2')} .h{background:url(bg.svg)}")
            .Add("assets/fonts/a.woff2", "FONT")
            .Add("assets/css/bg.svg", "<svg/>");
        const string html = "<link rel=\"stylesheet\" href=\"assets/css/theme.css\">";

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.Contains($"url(data:font/woff2;base64,{B64("FONT")})", result.Html);
        Assert.Contains($"url(data:image/svg+xml;base64,{B64("<svg/>")})", result.Html);
        Assert.Empty(result.Missing);
    }

    [Fact]
    public async Task import会被展开_且被导入文件里的url认它自己的目录()
    {
        var site = new FakeSite()
            .Add("css/main.css", "@import url(\"parts/base.css\") print; .m{}")
            .Add("css/parts/base.css", ".b{background:url(../../img/b.png)}")
            .Add("img/b.png", "PNG", "image/png");
        const string html = "<style>@import 'css/main.css';</style>";

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.Contains($"@media print{{.b{{background:url(data:image/png;base64,{B64("PNG")})}}}}", result.Html);
        Assert.Contains(".m{}", result.Html);
        Assert.DoesNotContain("@import", result.Html);
    }

    [Fact]
    public async Task import成环不会死循环()
    {
        var site = new FakeSite()
            .Add("a.css", "@import 'b.css'; .a{}")
            .Add("b.css", "@import 'a.css'; .b{}");

        var result = await site.Inliner().InlineAsync("index.html", "<link rel=stylesheet href=a.css>", CancellationToken.None);

        Assert.True(result.Succeeded);
        Assert.Contains(".a{}", result.Html);
        Assert.Contains(".b{}", result.Html);
    }

    [Fact]
    public async Task 缺失的资源保留原引用并上报_外部地址原样保留()
    {
        var site = new FakeSite().Unreadable("img/broken.png");
        const string html = """
            <img src="img/missing.png"><img src="img/broken.png">
            <link rel="stylesheet" href="https://cdn.example.com/x.css">
            <script src="https://cdn.example.com/x.js"></script>
            """;

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.True(result.Succeeded);
        Assert.Contains("<img src=\"img/missing.png\">", result.Html);
        Assert.Contains("<img src=\"img/broken.png\">", result.Html);
        Assert.Contains("href=\"https://cdn.example.com/x.css\"", result.Html);
        Assert.Contains("<script src=\"https://cdn.example.com/x.js\"></script>", result.Html);
        Assert.Contains(result.Missing, m => m.Reference == "img/missing.png" && m.Reason == HostedSiteInlineMissingReason.NotInSite);
        Assert.Contains(result.Missing, m => m.Reference == "img/broken.png" && m.Reason == HostedSiteInlineMissingReason.ReadFailed);
    }

    [Fact]
    public async Task 越出站点根的引用一律不读()
    {
        var site = new FakeSite().Add("index.css", "x");
        const string html = "<img src=\"../../other-site/secret.png\"><link rel=stylesheet href=\"%2e%2e/a.css\">";

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.Empty(site.Reads);
        Assert.Equal(2, result.Missing.Count(m => m.Reason == HostedSiteInlineMissingReason.OutsideSiteRoot));
        Assert.Contains("../../other-site/secret.png", result.Html);
    }

    [Fact]
    public async Task srcset与行内style里的url都会内嵌()
    {
        var site = new FakeSite()
            .Add("a.png", "A", "image/png")
            .Add("b.png", "B", "image/png")
            .Add("bg.jpg", "J", "image/jpeg");
        const string html = "<img srcset=\"a.png 1x, b.png 2x\"><div style=\"background:url('bg.jpg')\"></div>";

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.Contains($"srcset=\"data:image/png;base64,{B64("A")} 1x, data:image/png;base64,{B64("B")} 2x\"", result.Html);
        Assert.Contains($"style=\"background:url(data:image/jpeg;base64,{B64("J")})\"", result.Html);
    }

    [Fact]
    public async Task 内嵌脚本里的结束标签会被转义_不会提前闭合script()
    {
        var site = new FakeSite().Add("a.js", "document.write('</script><b>x</b>')");

        var result = await site.Inliner().InlineAsync("index.html", "<script src=\"a.js\"></script>", CancellationToken.None);

        Assert.Contains("<\\/script><b>x</b>", result.Html);
        Assert.Equal(1, CountOf(result.Html, "</script>"));
    }

    [Fact]
    public async Task 注释与已有内联脚本不被改动()
    {
        var site = new FakeSite().Add("a.png", "A");
        const string html = "<!-- <img src=\"a.png\"> --><script>var s='<img src=\"a.png\">'</script>";

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.Equal(html, result.Html);
        Assert.Empty(site.Reads);
    }

    [Fact]
    public async Task 预加载提示与候选样式表不内嵌()
    {
        var site = new FakeSite().Add("f.woff2", "F").Add("alt.css", ".x{}");
        const string html = "<link rel=\"preload\" href=\"f.woff2\" as=\"font\"><link rel=\"alternate stylesheet\" href=\"alt.css\">";

        var result = await site.Inliner().InlineAsync("index.html", html, CancellationToken.None);

        Assert.Equal(html, result.Html);
    }

    [Fact]
    public async Task 超过体积上限时不产出_并在读大文件之前就判出来()
    {
        var site = new FakeSite()
            .Add("small.png", new byte[10])
            .Unreadable("huge.mp4", size: 500L * 1024 * 1024);
        const string html = "<img src=\"small.png\"><video src=\"huge.mp4\"></video>";

        var result = await site.Inliner(max: 4096).InlineAsync("index.html", html, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("huge.mp4", result.OverLimitAt);
        Assert.DoesNotContain("key/huge.mp4", site.Reads);
    }

    [Fact]
    public async Task 同一个文件被引用多次只读一次()
    {
        var site = new FakeSite().Add("a.png", "A");

        var result = await site.Inliner().InlineAsync("index.html", "<img src=a.png><img src=\"a.png\">", CancellationToken.None);

        Assert.Single(site.Reads);
        Assert.Equal(2, CountOf(result.Html, "data:"));
    }

    [Fact]
    public void srcset切分不会切开dataUri里的逗号()
    {
        var parts = HostedSiteHtmlInliner.ParseSrcSet("data:image/png;base64,AAA= 1x, b.png 2x");
        Assert.Equal(2, parts.Count);
        Assert.Equal("data:image/png;base64,AAA=", parts[0].Url);
        Assert.Equal("b.png", parts[1].Url);
        Assert.Equal("2x", parts[1].Descriptor);
    }

    private static int CountOf(string text, string needle)
    {
        var count = 0;
        for (var i = text.IndexOf(needle, StringComparison.Ordinal); i >= 0; i = text.IndexOf(needle, i + needle.Length, StringComparison.Ordinal))
            count++;
        return count;
    }
}
