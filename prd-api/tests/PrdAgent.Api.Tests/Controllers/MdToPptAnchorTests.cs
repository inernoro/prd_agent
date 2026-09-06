using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 锚定 deck 模式（2026-06-12 质量目标）回归测试：
/// 资产加载 / 版式挑选 / slide 块平衡提取 / 消毒 / 装配回环。
/// </summary>
public class MdToPptAnchorTests
{
    [Fact]
    public void Resolve_AllOfficialThemes_HaveAnchor()
    {
        var themes = new[]
        {
            "tech-dark", "cobalt-grid", "editorial-ink", "warm-zine", "swiss-minimal",
            "aurora-gradient", "sunset-bold", "forest-organic", "royal-velvet", "ocean-glass",
            "atelier-zero", "kami-paper",
        };
        foreach (var t in themes)
        {
            var anchor = MdToPptAnchors.Resolve(t);
            Assert.True(anchor != null, $"theme {t} 无锚定模板（资产缺失或映射缺口）");
            Assert.True(anchor!.Slides.Count >= 3, $"theme {t} 锚定 {anchor.Name} 版式不足");
            Assert.Contains("slide", anchor.Cover.ClassAttr);
        }
        Assert.Equal("soft-editorial", MdToPptAnchors.Resolve("editorial-ink")!.Name);
        Assert.Equal("soft-editorial", MdToPptAnchors.Resolve("ocean-glass")!.Name);
    }

    [Fact]
    public void SoftEditorial_InlinesRequiredOpenDesignRuntimeAndKeepsAuthoredMobileCanvas()
    {
        var anchor = MdToPptAnchors.Resolve("editorial-ink")!;
        var guarded = MdToPptAnchors.EnsureMobilePresentationGuard(anchor.Prefix, anchor.Name);

        Assert.Equal("soft-editorial", anchor.Name);
        Assert.Contains("data-open-design-runtime", guarded);
        Assert.Contains("customElements.define('deck-stage'", guarded);
        Assert.DoesNotContain("src=\"assets/deck-stage.js\"", guarded);
        Assert.Contains("deck-stage { position:fixed", guarded);
        Assert.DoesNotContain("padding:48px 22px 112px", guarded);
    }

    [Fact]
    public void HistoricalSoftEditorial_NormalizationCreatesSelfContainedRunnableDocument()
    {
        const string historical = "<!doctype html><html><head><script src=\"assets/deck-stage.js\"></script></head><body><deck-stage width=\"1920\" height=\"1080\"><section class=\"slide\">内容</section></deck-stage></body></html>";

        var normalized = MdToPptController.NormalizePresentationDocument(historical);
        var normalizedAgain = MdToPptController.NormalizePresentationDocument(normalized);

        Assert.Equal(normalized, normalizedAgain);
        Assert.Contains("data-open-design-runtime", normalized);
        Assert.Contains("customElements.define('deck-stage'", normalized);
        Assert.Contains("data-mdppt-fonts", normalized);
        Assert.False(MdToPptAnchors.HasUnresolvedRuntimeReference(normalized));
    }

    [Fact]
    public void EnsureMobilePresentationGuard_InjectsOnceAndUsesReadableNarrowLayout()
    {
        var anchor = MdToPptAnchors.Load("cyber-terminal")!;
        var guarded = MdToPptAnchors.EnsureMobilePresentationGuard(anchor.Prefix, anchor.Name);
        var guardedAgain = MdToPptAnchors.EnsureMobilePresentationGuard(guarded);

        Assert.Equal(guarded, guardedAgain);
        Assert.Contains("@media (max-width: 640px)", guarded);
        Assert.Contains("overflow-y:auto !important", guarded);
        Assert.Contains("font-size:clamp(32px, 9.5vw, 44px) !important", guarded);
        Assert.Contains("padding:48px 22px 112px !important", guarded);
        Assert.Contains("overflow-x:auto !important", guarded);
        Assert.Contains("data-mdppt-anchor=\"cyber-terminal\"", guarded);
    }

    [Fact]
    public void PickLayout_CoverClosingAndIntentMatching()
    {
        var anchor = MdToPptAnchors.Load("monochrome")!;
        Assert.Equal(anchor.Cover.Layout, MdToPptAnchors.PickLayout(anchor, 0, 8, null).Layout);
        Assert.Equal(anchor.Closing.Layout, MdToPptAnchors.PickLayout(anchor, 7, 8, null).Layout);
        // 数据意图 → stats/chart 族
        var data = MdToPptAnchors.PickLayout(anchor, 3, 8, "视觉装置：大数字看板；版式：数据指标");
        Assert.Contains(data.Layout, new[] { "slide--stats", "slide--chart", "slide--pie" });
        // 对比意图 → compare/split
        var cmp = MdToPptAnchors.PickLayout(anchor, 4, 8, "版式：两栏对比");
        Assert.Contains(cmp.Layout, new[] { "slide--compare", "slide--split" });
    }

    [Fact]
    public void PagePrompts_UseGithubHtmlPptSkillContract()
    {
        var freePrompt = MdToPptController.BuildPageSystemPrompt("tech-dark", 1, 8);
        Assert.Contains("GitHub html-ppt 技能契约", freePrompt);
        Assert.Contains("templates/single-page", freePrompt);
        Assert.Contains("data-title", freePrompt);
        Assert.Contains(".notes", freePrompt);

        var anchor = MdToPptAnchors.Load("cobalt-grid")!;
        var anchoredPrompt = MdToPptController.BuildAnchoredPageSystemPrompt(anchor, anchor.ContentSlides[0], 1, 8);
        Assert.Contains("GitHub html-ppt 技能契约", anchoredPrompt);
        Assert.Contains("上游 lewislulu/html-ppt-skill", anchoredPrompt);
        Assert.Contains("本页版式范本", anchoredPrompt);
        Assert.Contains("禁止编造人名、命令、版本、时间、token、费用", anchoredPrompt);
        Assert.DoesNotContain("缺数据就给合理示意值", anchoredPrompt);
    }

    [Fact]
    public void ExtractSlideBlock_NestedDivs_Balanced()
    {
        var text = "好的，这是结果：\n```html\n<div class=\"slide slide-3\"><div class=\"a\"><div>x</div></div><p>y</p></div>\n```";
        var block = MdToPptController.ExtractSlideBlock(text);
        Assert.NotNull(block);
        Assert.StartsWith("<div class=\"slide slide-3\">", block);
        Assert.EndsWith("</div>", block);
        Assert.Contains("<p>y</p>", block);
    }

    [Fact]
    public void SanitizeAnchoredSlide_StripsLayoutInlineAndActive()
    {
        var block = "<div class=\"slide s-data active\"><div style=\"position:absolute;top:10px;color:red;padding:4px\">x</div></div>";
        var clean = MdToPptController.SanitizeAnchoredSlide(block)!;
        Assert.DoesNotContain("active", clean);
        Assert.DoesNotContain("position", clean);
        Assert.DoesNotContain("top:10px", clean);
        Assert.Contains("color:red", clean);
        Assert.Contains("padding:4px", clean);
    }

    [Fact]
    public void AddActive_InsertsIntoFirstClassAttr()
    {
        var withActive = MdToPptController.AddActiveToFirstSlide("<div class=\"slide s-cover hairlines\"><span class=\"x\">a</span></div>");
        Assert.StartsWith("<div class=\"slide s-cover hairlines active is-active\">", withActive);
        // 幂等
        Assert.Equal(withActive, MdToPptController.AddActiveToFirstSlide(withActive));
    }

    [Fact]
    public void AssemblyRoundTrip_RealAnchorAssets()
    {
        // 用 cobalt-grid 自己的范本当"生成结果"装配整 deck，再用拆装扫描验证完整性
        var anchor = MdToPptAnchors.Load("cobalt-grid")!;
        var slides = anchor.Slides.Take(5).Select(s => s.Html).ToArray();
        slides[0] = MdToPptController.AddActiveToFirstSlide(slides[0]);
        var html = anchor.Prefix + string.Join("\n", slides) + anchor.Suffix;

        var blocks = MdToPptController.FindSlideBlocks(html);
        Assert.Equal(5, blocks.Count);
        Assert.Contains("active", html.Substring(blocks[0].Start, blocks[0].Length));
        // 自带导航运行时还在（OD 规则：runtime 原样保留）
        Assert.Contains("<script", anchor.Suffix);
    }

    [Fact]
    public void FindSlideBlocks_IgnoresSlideCounterAndContainer()
    {
        var html = "<div class=\"slides-container\"><div class=\"slide-counter\">1</div>" +
                   "<div class=\"slide a\">one</div><div class=\"slide b\"><div>nest</div></div></div>";
        var blocks = MdToPptController.FindSlideBlocks(html);
        Assert.Equal(2, blocks.Count);
    }

    [Fact]
    public void AnchoredFallbackSlide_InheritsTemplateDecorationsButReplacesSampleFooter()
    {
        // 兜底页不再裸奔：继承 cyber-terminal 范本的装饰块（网格/扫描线），但不继承样例页脚
        var anchor = MdToPptAnchors.Load("cyber-terminal")!;
        var layout = anchor.ContentSlides[0];
        var page = new MdToPptOutlinePageDto
        {
            Title = "测试标题",
            Bullets = new List<string> { "要点一", "要点二" },
        };
        var slide = MdToPptController.AnchoredFallbackSlide(layout, page, 1, 6);

        Assert.Contains("测试标题", slide);
        Assert.Contains("要点一", slide);
        Assert.Contains("mdppt-fallback-layout", slide);
        Assert.Contains("mdppt-fallback-card", slide);
        // 模板装饰（无文本块）被继承
        Assert.Contains("hc-grid", slide);
        // 样例页脚不继承，改为当前页面身份与正确页码
        Assert.DoesNotContain("hc-footer", slide);
        Assert.Contains("mdppt-fallback-footer", slide);
        Assert.Contains("02 / 06", slide);
        Assert.Contains("mdppt-fallback-split", slide);
        // 根元素仍是合法 slide 块（拆装扫描可识别）
        var blocks = MdToPptController.FindSlideBlocks(slide);
        Assert.Single(blocks);
    }

    [Theory]
    [InlineData(0, 6, "终端风格封面", "mdppt-fallback-cover")]
    [InlineData(2, 6, "四阶段横向流程图", "mdppt-fallback-flow")]
    [InlineData(3, 6, "四象限能力卡片", "mdppt-fallback-quadrant")]
    [InlineData(5, 6, "结论页", "mdppt-fallback-closing")]
    public void AnchoredFallbackSlide_UsesSemanticLayoutVariants(int index, int total, string design, string expectedClass)
    {
        var anchor = MdToPptAnchors.Load("cyber-terminal")!;
        var page = new MdToPptOutlinePageDto
        {
            Title = "页面标题",
            Design = design,
            Bullets = new List<string> { "要点一", "要点二", "要点三", "要点四" },
        };

        var slide = MdToPptController.AnchoredFallbackSlide(anchor.ContentSlides[0], page, index, total);

        Assert.Contains(expectedClass, slide);
        Assert.Contains($"{index + 1:00} / {total:00}", slide);
        Assert.DoesNotContain("设计兜底", slide);
    }

    [Fact]
    public void ExtractAnchorDecorations_EmptyOnUnparsableHtml()
    {
        var (lead, tail) = MdToPptController.ExtractAnchorDecorations("plain text no tags");
        Assert.Equal("", lead);
        Assert.Equal("", tail);
    }

    [Fact]
    public void ContainsAnchorSampleResidue_RejectsUnsupportedTemplateFacts()
    {
        var layout = new MdToPptAnchors.AnchorSlide(
            "terminal.html",
            "terminal",
            "slide terminal",
            "终端版式",
            "<section class=\"slide terminal\"><div><span>hermes</span><span>lewis</span></div><footer>14k tokens · $0.21</footer></section>");
        var page = new MdToPptOutlinePageDto
        {
            Title = "统一工作区",
            Bullets = new List<string> { "知识文件只读挂载", "产物写入输出目录" },
        };
        var generated = "<section class=\"slide terminal\"><h1>统一工作区</h1><div><span>hermes</span><span>lewis</span></div></section>";

        Assert.True(MdToPptController.ContainsAnchorSampleResidue(generated, layout, page, "OpenDesign", "共享工作区"));
    }

    [Fact]
    public void ContainsAnchorSampleResidue_AllowsFactsProvidedByCurrentPage()
    {
        var layout = new MdToPptAnchors.AnchorSlide(
            "terminal.html",
            "terminal",
            "slide terminal",
            "终端版式",
            "<section class=\"slide terminal\"><div>共享工作区</div><footer>项目状态</footer></section>");
        var page = new MdToPptOutlinePageDto
        {
            Title = "共享工作区",
            Bullets = new List<string> { "项目状态可追踪" },
        };
        var generated = "<section class=\"slide terminal\"><h1>共享工作区</h1><div>项目状态可追踪</div></section>";

        Assert.False(MdToPptController.ContainsAnchorSampleResidue(generated, layout, page, "OpenDesign", null));
    }

    [Fact]
    public void RewriteAnchorSampleResidue_PreservesMarkupAndUsesOnlyPageFacts()
    {
        var layout = new MdToPptAnchors.AnchorSlide(
            "terminal.html",
            "terminal",
            "slide terminal",
            "终端版式",
            "<section class=\"slide terminal\"><div class=\"hermes-shell\"><span>zsh</span><span>lewis</span></div></section>");
        var page = new MdToPptOutlinePageDto
        {
            Title = "端到端调用链",
            Bullets = new List<string> { "MAP 创建隔离会话", "OpenDesign 读写工作区" },
        };
        var generated = "<section class=\"slide terminal\"><div class=\"hermes-shell\"><span>zsh</span><span>lewis</span></div></section>";

        var rewritten = MdToPptController.RewriteAnchorSampleResidue(generated, layout, page, "知识驱动验收", null);

        Assert.Contains("class=\"hermes-shell\"", rewritten);
        Assert.DoesNotContain(">zsh<", rewritten, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(">lewis<", rewritten, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(">端到端调用链<", rewritten);
        Assert.Contains(">MAP 创建隔离会话<", rewritten);
        Assert.False(MdToPptController.ContainsAnchorSampleResidue(rewritten, layout, page, "知识驱动验收", null));
    }

    [Fact]
    public void UnsupportedVisibleClaims_RejectsInventedFactsIncludingSplitInlineText()
    {
        var page = new MdToPptOutlinePageDto
        {
            Title = "四个 MVP",
            Bullets = new List<string> { "知识库生成网页", "网页托管精修与回退", "知识库生成 HTML PPT" },
        };

        Assert.True(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><p>实时协作编辑、文件版本管理、集成第三方应用</p></div>",
            page,
            "共享工作区设计链路",
            "MAP 管理 LLMGW"));
        Assert.True(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><p>总耗时 1m 52s · 8k tokens · $0.12</p></div>",
            page,
            "共享工作区设计链路",
            "MAP 管理 LLMGW"));
        Assert.True(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><h1>四个 MVP</h1><p>知识库生成网页</p><strong>转化率提升 97%</strong></div>",
            page,
            "共享工作区设计链路",
            "MAP 管理 LLMGW"));
        Assert.True(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><h1>四个 MVP</h1><svg><text>客户覆盖 300 家</text></svg></div>",
            page,
            "共享工作区设计链路",
            "MAP 管理 LLMGW"));
        Assert.True(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><h2>核心指标</h2><p>客户满意</p><strong>42</strong></div>",
            new MdToPptOutlinePageDto { Title = "核心指标", Bullets = new List<string> { "客户满意" } },
            null,
            null));
        Assert.False(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><div class=\"flow-num\">01</div><h2>核心指标</h2><p>客户满意</p><div class=\"pagenum\">02 / 05</div></div>",
            new MdToPptOutlinePageDto { Title = "核心指标", Bullets = new List<string> { "客户满意" } },
            null,
            null));
        Assert.False(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><h1>四个 MVP</h1><p>知识库生成网页</p><p>网页托管精修与回退</p></div>",
            page,
            "共享工作区设计链路",
            "MAP 管理 LLMGW"));
        Assert.True(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><span>实时</span><strong>协作编辑</strong></div>",
            page,
            "共享工作区设计链路",
            "MAP 管理 LLMGW"));
        var exactPage = new MdToPptOutlinePageDto
        {
            Title = "核心能力概览",
            Bullets = new List<string> { "支持网页精修和版本回退" },
        };
        Assert.False(MdToPptController.ContainsUnsupportedVisibleClaims(
            "<div class=\"slide\"><h2>核心能力概览</h2><p>支持网页精修和版本回退</p></div>",
            exactPage,
            "共享工作区设计链路",
            "MAP 管理 LLMGW"));
    }

    [Theory]
    [InlineData("<header class=\"slide-chrome\"><span class=\"label\">核心指标</span><span class=\"label\">03</span></header><h2>核心指标</h2><p>客户满意</p>")]
    [InlineData("<div class=\"slide-chrome\"><span class=\"label muted\">核心指标</span><span class=\"label muted\">03</span></div><h2>核心指标</h2><p>客户满意</p>")]
    [InlineData("<div class=\"left-col\"><div class=\"number\">03</div><div class=\"col-title\">核心指标</div></div><p>客户满意</p>")]
    public void UnsupportedVisibleClaims_AllowsKnownAnchorPageChrome(string body)
    {
        Assert.False(MdToPptController.ContainsUnsupportedVisibleClaims(
            $"<section class=\"slide\">{body}</section>",
            new MdToPptOutlinePageDto { Title = "核心指标", Bullets = new List<string> { "客户满意" } },
            null,
            null,
            2,
            5));
    }

    [Theory]
    [InlineData("<span class=\"label\">42</span>")]
    [InlineData("<div class=\"number\">42</div>")]
    [InlineData("<div class=\"left-col\"><p>说明</p><div class=\"number\">42</div></div>")]
    public void UnsupportedVisibleClaims_DoesNotGloballyWhitelistGenericNumericClasses(string body)
    {
        Assert.True(MdToPptController.ContainsUnsupportedVisibleClaims(
            $"<section class=\"slide\"><h2>核心指标</h2><p>客户满意</p>{body}</section>",
            new MdToPptOutlinePageDto { Title = "核心指标", Bullets = new List<string> { "客户满意" } },
            null,
            null));
    }

    [Fact]
    public void NormalizeSlidePageIdentity_RewritesTemplateCountersToActualDeckSize()
    {
        var html = "<div class=\"slide\"><div>SECTION · 02/08</div><span class=\"pin-note\">08 / 08</span>" +
                   "<header class=\"slide-chrome\"><span class=\"label\">标题</span><span class=\"label\">12</span></header>" +
                   "<div class=\"left-col\"><div class=\"number\">09</div><div>正文</div></div>" +
                   "<strong>16 / 9</strong><span>2 / 3</span></div>";
        var normalized = MdToPptController.NormalizeSlidePageIdentity(html, 1, 5);

        Assert.Contains("SECTION · 02/05", normalized);
        Assert.Contains("class=\"pin-note\">02 / 05<", normalized);
        Assert.Contains("class=\"label\">02<", normalized);
        Assert.Contains("class=\"number\">02<", normalized);
        Assert.Contains("<strong>16 / 9</strong>", normalized);
        Assert.Contains("<span>2 / 3</span>", normalized);
    }

    [Theory]
    [InlineData("<div class=\"slide-foot\"><span class=\"label muted\">Grove</span><span class=\"label muted\">05 / 12</span></div>")]
    [InlineData("<footer class=\"slide-foot\"><span class=\"label muted\">Monochrome</span><span class=\"label muted\">11 / 18</span></footer>")]
    public void NormalizeSlidePageIdentity_RewritesOnlyNumericSlideFootCounter(string footer)
    {
        var normalized = MdToPptController.NormalizeSlidePageIdentity($"<section class=\"slide\">{footer}<strong>16 / 9</strong></section>", 2, 5);

        Assert.Contains(">03 / 05</span>", normalized);
        Assert.Contains("<strong>16 / 9</strong>", normalized);
    }

    [Fact]
    public void HtmlHashBinding_DetectsAnyChangedPublishOrPatchPayload()
    {
        const string html = "<!doctype html><html><head></head><body><div class=\"slide active\">版本一</div></body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);

        Assert.Equal(64, hash.Length);
        Assert.True(MdToPptController.HtmlMatchesHash(html, hash));
        Assert.False(MdToPptController.HtmlMatchesHash(html.Replace("版本一", "版本二"), hash));
    }

    [Fact]
    public void EnsurePresentationFontLinks_SolidifiesPreviewFontsBeforeHashing()
    {
        const string html = "<!doctype html><html><head><title>演示</title></head><body><div class=\"slide active\">内容</div></body></html>";

        var normalized = MdToPptController.EnsurePresentationFontLinks(html);
        var normalizedAgain = MdToPptController.EnsurePresentationFontLinks(normalized);

        Assert.Equal(normalized, normalizedAgain);
        Assert.Contains("data-mdppt-fonts", normalized);
        Assert.Contains("fonts.googleapis.com", normalized);
        Assert.True(MdToPptController.HtmlMatchesHash(normalized, MdToPptController.ComputeHtmlHash(normalized)));
    }

    [Theory]
    [InlineData("<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">")]
    [InlineData("<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Inter\">")]
    public void EnsurePresentationFontLinks_DoesNotMistakePartialGoogleFontSetupForFullBundle(string existingLink)
    {
        var html = $"<!doctype html><html><head>{existingLink}</head><body><div class=\"slide active\">内容</div></body></html>";

        var normalized = MdToPptController.EnsurePresentationFontLinks(html);

        Assert.Contains(existingLink, normalized);
        Assert.Contains("data-mdppt-fonts", normalized);
    }

    [Fact]
    public void EnsurePresentationFontLinks_PreservesHistoricalHeadClosingTagForHashCompatibility()
    {
        const string html = "<!doctype html><html><head><title>旧版本</title></HEAD   ><body><div class=\"slide active\">内容</div></body></html>";

        var normalized = MdToPptController.EnsurePresentationFontLinks(html);

        Assert.Contains("data-mdppt-fonts", normalized);
        Assert.Contains("</HEAD   >", normalized);
    }
}
