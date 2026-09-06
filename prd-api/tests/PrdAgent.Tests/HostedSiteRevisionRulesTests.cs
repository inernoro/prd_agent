using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteRevisionRulesTests
{
    [Fact]
    public void NormalizeGeneratedHtml_RemovesMarkdownFence()
    {
        var result = HostedSiteRevisionRules.NormalizeGeneratedHtml(
            "```html\n<!doctype html><html><body>新版</body></html>\n```");

        Assert.Equal("<!doctype html><html><body>新版</body></html>", result);
    }

    [Theory]
    [InlineData("<!doctype html><html><body></body></html>")]
    [InlineData("<html><body>页面</body></html>")]
    [InlineData("\uFEFF<!doctype html>\n<!-- OpenDesign web-prototype seed. -->\n<html lang=\"zh-CN\"><body>页面</body></html>")]
    public void ValidateHtml_AcceptsCompletePage(string html)
    {
        HostedSiteRevisionRules.ValidateHtml(html);
    }

    [Theory]
    [InlineData("")]
    [InlineData("只有一段解释文字")]
    [InlineData("<!doctype html><body>implicit root bypass</body>")]
    [InlineData("<!doctype html><!-- <html> --><body>comment root bypass</body>")]
    [InlineData("<!doctype html><!-- closed --><script>outside root</script><html><body>late root</body></html>")]
    [InlineData("plain text before <!doctype html><html><body>late root</body></html>")]
    [InlineData("<!doctype html><html data-breakout=\"<\"><body>quoted root delimiter</body></html>")]
    public void ValidateHtml_RejectsEmptyOrNonHtml(string html)
    {
        Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.ValidateHtml(html));
    }

    [Fact]
    public void HardenGeneratedHtml_BlocksScriptsAndExternalReferences()
    {
        var unsafePages = new[]
        {
            "<!doctype html><html><script>globalThis['lo'+'cation']='https://outside.example'</script></html>",
            "<!doctype html><html><img src=\"https://outside.example/pixel\"></html>",
            "<!doctype html><html><a href=\"https://outside.example\">leave</a></html>",
            "<!doctype html><html><a title=\"2 > 1\" href=\"https://tracker.example/out\">leave</a></html>",
            "<!doctype html><html><img title=\"2 > 1\" src=\"https://tracker.example/p.png\"></html>",
            "<!doctype html><html><style>body{background:url(https://outside.example/pixel)}</style></html>",
            "<!doctype html><html><form action=\"/submit\"></form></html>",
            "<!doctype html><html><body background=\"https://tracker.example/pixel.png\"></body></html>",
            "<!doctype html><html><video poster=\"https://tracker.example/poster.png\"></video></html>",
            "<!doctype html><html><a href=\"#ok\" ping=\"https://tracker.example/ping\">leave</a></html>",
        };

        foreach (var html in unsafePages)
            Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.HardenGeneratedHtml(html));
    }

    [Theory]
    [InlineData("<!doctype html><html><head><meta http-equiv=\"re&#102;resh\" content=\"0;url=https://outside.example\"></head></html>")]
    [InlineData("<!doctype html><html><head><meta content=\"custom\" http-equiv=\"x-product-mode\"></head></html>")]
    [InlineData("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></head></html>")]
    [InlineData("<!doctype html><html><head><meta title=\"2 > 1\" http-equiv=\"refresh\" content=\"0;url=https://outside.example\"></head></html>")]
    public void HardenGeneratedHtml_RejectsEveryUserProvidedHttpEquivMeta(string html)
    {
        Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.HardenGeneratedHtml(html));
    }

    [Fact]
    public void HardenGeneratedHtml_ConvertsRelativeKnowledgeLinkIntoInertCitation()
    {
        var result = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html lang=\"zh-CN\"><head><title>阅读地图</title></head><body><a class=\"link\" href=\"./guide.platform.quickstart.md\">快速开始</a></body></html>");

        Assert.Contains("script-src 'none'", result);
        Assert.DoesNotContain("frame-ancestors", result);
        Assert.DoesNotContain("navigate-to", result);
        Assert.Contains("<span data-cds-source-reference=\"./guide.platform.quickstart.md\">快速开始</span>", result);
        Assert.DoesNotContain("href=\"./guide.platform.quickstart.md\"", result);
    }

    [Fact]
    public void HardenGeneratedHtml_PreservesSingleHeadAndMobileViewport()
    {
        var result = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html lang=\"zh-CN\"><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>移动页面</title></head><body>正文</body></html>");

        Assert.Single(System.Text.RegularExpressions.Regex.Matches(
                result,
                @"<head\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Cast<System.Text.RegularExpressions.Match>());
        Assert.Contains("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">", result, StringComparison.Ordinal);
        Assert.True(
            result.IndexOf("Content-Security-Policy", StringComparison.Ordinal)
            < result.IndexOf("name=\"viewport\"", StringComparison.Ordinal));
    }

    [Fact]
    public void HardenGeneratedHtml_InjectsCspBeforeACommentThatPretendsToBeHead()
    {
        var result = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><!--<head>--><style>body{background-image:u\\72l(https://tracker.example/p)}</style><body>ok</body></html>");

        Assert.True(
            result.IndexOf("Content-Security-Policy", StringComparison.Ordinal)
            < result.IndexOf("<!--<head>-->", StringComparison.Ordinal));
        Assert.Contains("img-src data:", result, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("<!doctype html><html><body><header>[REPLACE] Brand</header></body></html>")]
    [InlineData("<!doctype html><html><body><button>[replace] CTA</button></body></html>")]
    [InlineData("<!doctype html><html><body><footer>[email protected]</footer></body></html>")]
    [InlineData("<!doctype html><html><body><footer>[email&#160;protected]</footer></body></html>")]
    public void HardenGeneratedHtml_RejectsVisibleUnresolvedTemplateSentinels(string html)
    {
        var error = Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.HardenGeneratedHtml(html));

        Assert.Contains("未替换的模板占位内容", error.Message, StringComparison.Ordinal);
        Assert.Contains("重新生成", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void HardenGeneratedHtml_AllowsOrdinaryBracketedCopyAndCommentedTemplateNotes()
    {
        var result = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><!-- [REPLACE] Brand --><head><style>.hint::after{content:'[说明]'}</style></head><body>[已验证] 普通方括号文案</body></html>");

        Assert.Contains("[已验证] 普通方括号文案", result, StringComparison.Ordinal);
        Assert.Contains("<!-- [REPLACE] Brand -->", result, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateGeneratedContentQuality_AcceptsRealFragmentsDisabledControlsAndSupportedClaims()
    {
        const string html = """
            <!doctype html><html><head><style>.placeholder{display:none}.metric{width:30%}</style></head><body>
            <!-- 图示占位说明只存在于模板注释 -->
            <a href="#reading-map">查看阅读地图</a>
            <section id=reading-map><p>完整阅读约 40 分钟。</p></section>
            <button disabled aria-disabled="true">暂不提供</button>
            <button popovertarget="details">查看说明</button><aside id="details" popover>说明</aside>
            <p>本文解释占位符机制，不是未完成页面。</p>
            </body></html>
            """;

        HostedSiteRevisionRules.ValidateGeneratedContentQuality(html, "总共约40分钟");
    }

    [Theory]
    [InlineData("<a href=\"#\">开始</a>", "空链接")]
    [InlineData("<a>开始</a>", "没有目标")]
    [InlineData("<a aria-label=\"开始\"><svg></svg></a>", "没有目标")]
    [InlineData("<a href=\"#missing\">开始</a>", "目标不存在")]
    [InlineData("<button>开始</button>", "无法执行动作")]
    [InlineData("<div class=\"diagram-placeholder\">关系图占位</div>", "占位或待补")]
    [InlineData("<p>内容待补充</p>", "占位或待补")]
    public void ValidateGeneratedContentQuality_RejectsUnshippableStaticUi(string body, string expectedMessage)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            HostedSiteRevisionRules.ValidateGeneratedContentQuality(
                $"<!doctype html><html><body>{body}</body></html>",
                "开始"));

        Assert.Contains(expectedMessage, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateGeneratedContentQuality_RejectsUnsupportedMeasuredClaimButIgnoresCssNumbers()
    {
        const string html = """
            <!doctype html><html><head><style>.hero{width:30%;margin:2rem}</style></head>
            <body><p>完整阅读只需 30 分钟。</p></body></html>
            """;

        var error = Assert.Throws<InvalidOperationException>(() =>
            HostedSiteRevisionRules.ValidateGeneratedContentQuality(html, "总共约40分钟"));

        Assert.Contains("30分钟", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateGeneratedContentQuality_AllowsSupportedMetricParaphraseForFinalSemanticReview()
    {
        HostedSiteRevisionRules.ValidateGeneratedContentQuality(
            "<!doctype html><html><body><p>客服平均答复30分钟。</p></body></html>",
            "客服响应耗时30分钟。");
    }

    [Fact]
    public void ValidateGeneratedContentQuality_RejectsCountReassignedToDifferentEntity()
    {
        foreach (var (output, evidence) in new[]
                 {
                     ("文章已有999位读者。", "平台服务999位客户。"),
                     ("面向999位消费者。", "系统注册999位用户。"),
                 })
        {
            var error = Assert.Throws<InvalidOperationException>(() =>
                HostedSiteRevisionRules.ValidateGeneratedContentQuality(
                    $"<!doctype html><html><body><p>{output}</p></body></html>",
                    evidence));
            Assert.Contains("未支持的数值陈述", error.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ValidateGeneratedContentQuality_RejectsUnsupportedPrefixedPricesAndNormalizesCurrencyNotation()
    {
        foreach (var price in new[] { "￥999", "¥999", "$999" })
        {
            Assert.Throws<InvalidOperationException>(() =>
                HostedSiteRevisionRules.ValidateGeneratedContentQuality(
                    $"<!doctype html><html><body><p>售价为{price}</p></body></html>",
                    "来源没有价格"));
        }

        HostedSiteRevisionRules.ValidateGeneratedContentQuality(
            "<!doctype html><html><body><p>套餐售价999元。</p></body></html>",
            "套餐售价￥999");
    }

    [Fact]
    public void ValidateGeneratedContentQuality_RejectsUnsupportedHighRiskQuantityButAllowsStructuralCounts()
    {
        foreach (var claim in new[]
                 {
                     "平台已服务999个项目。",
                     "平台客户999个。",
                     "客户案例：999个。",
                     "平台共有999个项目。",
                     "999个项目正在使用。",
                     "已经帮助999位客户。",
                     "平台已有999个模块。",
                     "服务覆盖999个类别。",
                     "平台提供999种操作。",
                     "产品包含999个章节。",
                     "网站拥有999个栏目。",
                 })
        {
            var error = Assert.Throws<InvalidOperationException>(() =>
                HostedSiteRevisionRules.ValidateGeneratedContentQuality(
                    $"<!doctype html><html><body><p>{claim}</p></body></html>",
                    "来源没有用户规模"));
            Assert.Contains("999", error.Message, StringComparison.Ordinal);
        }
        HostedSiteRevisionRules.ValidateGeneratedContentQuality(
            "<!doctype html><html><body><p>使用方式分为3个步骤。</p></body></html>",
            "来源描述了操作方式");
        foreach (var (output, evidence) in new[]
                 {
                     ("平台已服务999个项目。", "已有999个项目。"),
                     ("目前服务999位客户。", "客户数为999人。"),
                     ("知识库收录100篇文章。", "已有文章100篇。"),
                 })
        {
            HostedSiteRevisionRules.ValidateGeneratedContentQuality(
                $"<!doctype html><html><body><p>{output}</p></body></html>",
                evidence);
        }
    }

    [Fact]
    public void ValidateGeneratedContentQuality_IgnoresHiddenDraftFactsAndHandlesQuotedGreaterThan()
    {
        const string html = """
            <!doctype html><html><body>
            <template><p>内容待补充，发布日期：2026-10-01</p></template>
            <div hidden>平台已服务999个项目</div>
            <div style="display: none">完整阅读只需30分钟</div>
            <section title="2 > 1" id="real">真实内容</section>
            <a href="#real">查看</a>
            </body></html>
            """;

        HostedSiteRevisionRules.ValidateGeneratedContentQuality(html, "来源不包含隐藏草稿");
    }

    [Theory]
    [InlineData("<p>发布日期：2026-10-01</p>", "日期、联系方式或网址")]
    [InlineData("<p>联系 design@example.com</p>", "日期、联系方式或网址")]
    [InlineData("<p>详情 https://example.com/launch</p>", "日期、联系方式或网址")]
    [InlineData("<button popovertarget=\"details\">查看说明</button><div id=\"details\">说明</div>", "无法执行动作")]
    [InlineData("<div title=\"jump to id=missing\">正文</div><a href=\"#missing\">开始</a>", "目标不存在")]
    [InlineData("<div id=\"details\" title=\"contains popover panel\">正文</div><button popovertarget=\"details\">说明</button>", "无法执行动作")]
    public void ValidateGeneratedContentQuality_RejectsUnsupportedSensitiveFactsAndFakePopover(string body, string expectedMessage)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            HostedSiteRevisionRules.ValidateGeneratedContentQuality(
                $"<!doctype html><html><body>{body}</body></html>",
                "来源没有这些信息"));

        Assert.Contains(expectedMessage, error.Message, StringComparison.Ordinal);
    }
}
