using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 风格目录与真实样张（2026-09-24：风格缩略图必须是这个风格真实的样子，不能是手画的色块）。
/// 守五件事：快照真的内嵌且与钉住的 OpenDesign 版本一致；缺失或写坏时报错而不是空目录；
/// 目录接口给出的三色来自真实 tokens；样张只用真实 tokens、标题被转义且没有脚本；
/// 8 套预设的三色与快照一致，库里存过的旧三色不再生效。
/// </summary>
public sealed class DesignSystemCatalogTests
{
    private static readonly IDesignSystemCatalog Catalog = DesignSystemCatalog.LoadEmbedded();

    // ---------- 快照加载 ----------

    [Fact]
    public void 内嵌快照可加载_版本与OpenDesign运行时镜像钉住的版本一致()
    {
        Assert.True(Catalog.All.Count >= 150, $"快照只有 {Catalog.All.Count} 套设计系统");
        var dockerfile = Path.Combine(FindRepoRoot(), "cds", "open-design-runtime", "Dockerfile");
        var from = File.ReadLines(dockerfile).First(line => line.TrimStart().StartsWith("FROM ", StringComparison.OrdinalIgnoreCase));
        Assert.Equal($"ghcr.io/nexu-io/od:{Catalog.EngineVersion}", from.Split(' ', StringSplitOptions.RemoveEmptyEntries)[1]);
        Assert.Equal($"ghcr.io/nexu-io/od:{Catalog.EngineVersion}", Catalog.EngineImage);
        Assert.NotEqual(DateTime.MinValue, Catalog.GeneratedAt);
    }

    [Fact]
    public void 每套设计系统都有真实三色与字体_编号唯一且有序()
    {
        var ids = Catalog.All.Select(system => system.Id).ToList();
        Assert.Equal(ids.OrderBy(id => id, StringComparer.Ordinal), ids);
        Assert.Equal(ids.Count, ids.Distinct(StringComparer.Ordinal).Count());
        Assert.All(Catalog.All, system =>
        {
            Assert.False(string.IsNullOrWhiteSpace(system.Swatches.Bg), system.Id);
            Assert.False(string.IsNullOrWhiteSpace(system.Swatches.Fg), system.Id);
            Assert.False(string.IsNullOrWhiteSpace(system.Swatches.Accent), system.Id);
            Assert.False(string.IsNullOrWhiteSpace(system.Fonts.Display), system.Id);
            Assert.False(string.IsNullOrWhiteSpace(system.Fonts.Body), system.Id);
            Assert.False(string.IsNullOrWhiteSpace(system.Category), system.Id);
            Assert.False(string.IsNullOrWhiteSpace(system.Summary), system.Id);
        });
        // 真实值抽查：editorial 的 accent 就是 OpenDesign 0.21.1 tokens.css 里的 #9a5a2f。
        var editorial = Catalog.Find("editorial")!;
        Assert.Equal(new DesignSystemSwatches("#fbf7f0", "#1f1a16", "#9a5a2f"), editorial.Swatches);
        Assert.Equal("Georgia, \"Times New Roman\", serif", editorial.Fonts.Display);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("not json")]
    [InlineData("""{"schemaVersion":"map-design-system-catalog/v1","engine":{"version":"0.21.1"},"designSystems":[]}""")]
    [InlineData("""{"schemaVersion":"other/v9","engine":{"version":"0.21.1"},"designSystems":[{"id":"a","tokensCss":":root{--bg:#fff}"}]}""")]
    public void 快照缺失或写坏时抛出并说明原因_不退化成空目录(string json)
    {
        var error = Assert.Throws<DesignSystemCatalogUnavailableException>(() => DesignSystemCatalog.Parse(json));
        Assert.False(string.IsNullOrWhiteSpace(error.Message));
    }

    [Fact]
    public void 某套设计系统缺语义令牌时指名道姓地报错()
    {
        const string json = """
            {"schemaVersion":"map-design-system-catalog/v1","engine":{"version":"0.21.1"},
             "designSystems":[{"id":"broken","name":"Broken","category":"X",
               "tokensCss":":root { --bg: #fff; --fg: #000; --font-display: serif; --font-body: serif; }"}]}
            """;
        var error = Assert.Throws<DesignSystemCatalogUnavailableException>(() => DesignSystemCatalog.Parse(json));
        Assert.Contains("broken", error.Message);
        Assert.Contains("--accent", error.Message);
    }

    [Fact]
    public void 读令牌只读第一段root_同块重复声明取最后一条_不读暗色覆盖块()
    {
        const string css = """
            :root {
              --accent: #111111;
              --accent-hover: color-mix(in oklab, var(--accent), black 8%);
              --accent: #222222;
            }
            [data-theme="dark"] { --accent: #ffffff; }
            """;
        Assert.Equal("#222222", DesignSystemCatalog.ReadRootToken(css, "--accent"));
        Assert.Null(DesignSystemCatalog.ReadRootToken(css, "--bg"));
        Assert.Null(DesignSystemCatalog.ReadRootToken("[data-theme=\"dark\"] { --bg: #000; }", "--bg"));
    }

    // ---------- 目录接口 ----------

    [Fact]
    public void 目录接口给出分组字段_三色字体与样张地址来自快照()
    {
        var view = JsonSerializer.SerializeToNode(DesignSystemsController.ToCatalogView(Catalog))!;

        Assert.Equal(Catalog.All.Count, view["count"]!.GetValue<int>());
        Assert.Equal(Catalog.EngineVersion, view["engine"]!["version"]!.GetValue<string>());
        var categories = view["categories"]!.AsArray();
        Assert.Equal(Catalog.All.Count, categories.Sum(category => category!["count"]!.GetValue<int>()));
        var counts = categories.Select(category => category!["count"]!.GetValue<int>()).ToList();
        Assert.Equal(counts.OrderByDescending(count => count), counts);

        var editorial = view["items"]!.AsArray().Single(item => item!["id"]!.GetValue<string>() == "editorial")!;
        Assert.Equal("Creative & Artistic", editorial["category"]!.GetValue<string>());
        Assert.Equal("#9a5a2f", editorial["swatches"]!["accent"]!.GetValue<string>());
        Assert.Equal("#fbf7f0", editorial["swatches"]!["bg"]!.GetValue<string>());
        Assert.Equal("#1f1a16", editorial["swatches"]!["fg"]!.GetValue<string>());
        Assert.Equal("\"Source Serif Pro\", Georgia, serif", editorial["fonts"]!["body"]!.GetValue<string>());
        Assert.Equal("/api/design-artifacts/design-systems/editorial/sample", editorial["sampleUrl"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(editorial["summary"]!.GetValue<string>()));
    }

    // ---------- 样张 ----------

    [Fact]
    public void 样张嵌入该设计系统的真实tokens_共享模板只用语义令牌()
    {
        var editorial = Catalog.Find("editorial")!;
        var html = DesignSystemSampleRenderer.Render(editorial, null, null);

        Assert.StartsWith("<!doctype html>", html);
        Assert.Contains(editorial.TokensCss.Trim(), html);
        Assert.Contains("--accent: #9a5a2f;", html);
        Assert.Contains(DesignSystemSampleRenderer.DefaultTitle, html);
        Assert.Contains("GDPR 罚款上限参照全球营收", html);
        Assert.Contains("窜码与假码", html);

        // 共享模板里不许出现任何具体颜色：颜色只能来自 tokens。
        var template = html[(html.IndexOf("</style>", StringComparison.Ordinal) + "</style>".Length)..];
        Assert.DoesNotMatch(new Regex("#[0-9a-fA-F]{3,8}\\b"), template);
        Assert.DoesNotMatch(new Regex("rgba?\\(|hsla?\\(|oklch\\("), template);
    }

    [Fact]
    public void 样张标题被转义且截到六十字_空标题用示例标题()
    {
        var system = Catalog.Find("minimal")!;
        var html = DesignSystemSampleRenderer.Render(system, "<script>alert(1)</script>\"&'", "page");

        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;", html);

        var longTitle = string.Concat(Enumerable.Repeat("码", 80));
        Assert.Equal(60, new StringInfo(DesignSystemSampleRenderer.NormalizeTitle(longTitle)).LengthInTextElements);
        Assert.Equal(DesignSystemSampleRenderer.DefaultTitle, DesignSystemSampleRenderer.NormalizeTitle("  \n\t "));
        Assert.Equal("第一行 第二行", DesignSystemSampleRenderer.NormalizeTitle("第一行\r\n\u0007第二行"));
    }

    [Fact]
    public void 全部设计系统的样张都自包含_无脚本无外链_样式块不被tokens提前闭合()
    {
        foreach (var system in Catalog.All)
        {
            foreach (var format in DesignSystemSampleRenderer.Formats)
            {
                var html = DesignSystemSampleRenderer.Render(system, "季度复盘", format);
                Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("src=", html, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("href=", html, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("url(", html, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("@import", html, StringComparison.OrdinalIgnoreCase);
                Assert.Equal(2, Regex.Matches(html, "</style>").Count);
            }
        }
    }

    [Fact]
    public void 样张slides格式是十六比九封面()
    {
        var html = DesignSystemSampleRenderer.Render(Catalog.Find("kami")!, "封面标题", "SLIDES");
        Assert.Contains("width:1280px;height:720px", html);
        Assert.Contains("封面标题", html);
        Assert.Throws<ArgumentOutOfRangeException>(() => DesignSystemSampleRenderer.Render(Catalog.Find("kami")!, null, "pdf"));
    }

    [Fact]
    public void 样张接口返回text_html与缓存头_未知编号404且说人话_格式不对400()
    {
        var controller = NewController();

        var ok = Assert.IsType<ContentResult>(controller.Sample("Editorial", "测试<b>", "page"));
        Assert.Equal("text/html; charset=utf-8", ok.ContentType);
        Assert.Contains("测试&lt;b&gt;", ok.Content);
        Assert.Equal(DesignSystemsController.SampleCacheControl, controller.Response.Headers.CacheControl.ToString());
        Assert.Equal("nosniff", controller.Response.Headers["X-Content-Type-Options"].ToString());
        Assert.Contains("default-src 'none'", controller.Response.Headers["Content-Security-Policy"].ToString());

        foreach (var unknown in new[] { "no-such-style", "../etc/passwd" })
        {
            var notFound = Assert.IsType<NotFoundObjectResult>(NewController().Sample(unknown, null, null));
            var body = Assert.IsType<ApiResponse<object>>(notFound.Value);
            Assert.False(body.Success);
            Assert.Equal(ErrorCodes.NOT_FOUND, body.Error!.Code);
            Assert.Contains(unknown, body.Error.Message);
            Assert.Contains("OpenDesign", body.Error.Message);
        }

        var badFormat = Assert.IsType<BadRequestObjectResult>(NewController().Sample("editorial", null, "pdf"));
        Assert.Contains("slides", Assert.IsType<ApiResponse<object>>(badFormat.Value).Error!.Message);
    }

    [Theory]
    [InlineData("/api/design-artifacts/design-systems")]
    [InlineData("/api/design-artifacts/design-systems/editorial/sample")]
    public void 两个接口与网页生成其它接口同权限_要网页托管读权限_不走运行时数据面放行(string path)
    {
        var scanner = new AdminControllerScanner(
            NullLogger<AdminControllerScanner>.Instance, typeof(DesignSystemsController).Assembly);
        Assert.Equal(AdminPermissionCatalog.WebPagesRead, scanner.GetRequiredPermission(path, "GET"));
        Assert.Equal(
            scanner.GetRequiredPermission("/api/design-artifacts/generation-settings", "GET"),
            scanner.GetRequiredPermission(path, "GET"));

        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Path = path;
        Assert.False(AdminPermissionMiddleware.IsDesignArtifactRuntimeDataPlaneRequest(context));
        Assert.Null(typeof(DesignSystemsController).GetCustomAttributes(typeof(Microsoft.AspNetCore.Authorization.AllowAnonymousAttribute), true).FirstOrDefault());
    }

    // ---------- 8 套预设的三色 ----------

    [Fact]
    public void 八套预设的三色从快照真实tokens派生_ink等于fg_paper等于bg_accent等于accent()
    {
        var settings = DesignGenerationSettingsService.Effective(null, Catalog);

        Assert.Equal(8, settings.Styles.Count);
        foreach (var style in settings.Styles)
        {
            var system = Catalog.Find(style.DesignSystemId);
            Assert.NotNull(system);
            Assert.Equal(new[] { system!.Swatches.Fg, system.Swatches.Bg, system.Swatches.Accent }, style.Swatches);
        }
        // 事故值：修之前 editorial 手写的 accent 是 #b3261e。
        Assert.Equal("#9a5a2f", settings.Styles.Single(style => style.Id == "editorial").Swatches[2]);
        Assert.All(DesignGenerationDefaults.Styles, style => Assert.Empty(style.Swatches));
    }

    [Fact]
    public void 库里存过的旧三色读取时以快照为准_提交的色块不采用也不落库()
    {
        var stored = new DesignGenerationSettings
        {
            Styles = new List<DesignStylePreset>
            {
                new()
                {
                    Id = "editorial", Name = "编辑刊物", Description = "d", DesignSystemId = "editorial",
                    Swatches = new List<string> { "#1f1f1f", "#f5f1e8", "#b3261e" }, Enabled = true, IsDefault = true, BuiltIn = true,
                },
                new()
                {
                    Id = "custom-x", Name = "自定义", Description = "", DesignSystemId = "not-in-opendesign",
                    Swatches = new List<string> { "#000000", "#ffffff", "#ff0000" }, Enabled = true,
                },
            },
        };
        var effective = DesignGenerationSettingsService.Effective(stored, Catalog);
        Assert.Equal(new[] { "#1f1a16", "#fbf7f0", "#9a5a2f" }, effective.Styles[0].Swatches);
        // 设计系统不在快照里：拿不到真实颜色就不给，不编一组；也没有样张地址。
        Assert.Empty(effective.Styles[1].Swatches);
        // 生效视图不共享存储对象：派生不回写库里那份。
        Assert.Equal("#b3261e", stored.Styles[0].Swatches[2]);

        var view = JsonSerializer.SerializeToNode(DesignGenerationSettingsController.ToView(effective, canEdit: true, Catalog))!;
        Assert.True(view["swatchesReadOnly"]!.GetValue<bool>());
        var styles = view["styles"]!.AsArray();
        Assert.Equal("/api/design-artifacts/design-systems/editorial/sample", styles[0]!["sampleUrl"]!.GetValue<string>());
        Assert.Null(styles[1]!["sampleUrl"]);

        var saved = DesignGenerationSettingsService.Apply(new DesignGenerationSettings(), new DesignGenerationSettingsUpdate
        {
            Styles = new List<DesignStylePreset>
            {
                new() { Id = "editorial", Name = "编辑刊物", DesignSystemId = "editorial", Swatches = new List<string> { "#fff", "bogus" }, Enabled = true, IsDefault = true },
            },
        }, Catalog);
        Assert.Empty(saved.Styles![0].Swatches);
    }

    private static DesignSystemsController NewController() => new(Catalog)
    {
        ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
    };

    private static string FindRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "cds", "open-design-runtime", "Dockerfile")))
                return directory.FullName;
            directory = directory.Parent;
        }
        throw new InvalidOperationException(
            $"从 {AppContext.BaseDirectory} 往上找不到 cds/open-design-runtime/Dockerfile，无法核对 OpenDesign 版本");
    }
}
