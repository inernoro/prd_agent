using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 并行逐页生成的 section 消毒回归测试（2026-06-11 P0：页 2 黑屏根因）。
/// 根因：子智能体在 section 根元素 inline style 写 display:flex / min-height:100vh，
/// inline 优先级覆盖 reveal.css 的隐藏规则，非当前页藏不掉、当前页被推出视口。
/// </summary>
public class MdToPptSectionSanitizeTests
{
    [Fact]
    public void RootDisplayFlex_MovedToWrapper_NotLeftOnSection()
    {
        var input = "<section data-background-color=\"var(--bg)\" style=\"padding: 4rem; min-height: 100vh; " +
                    "display: flex; flex-direction: column; justify-content: center; align-items: center; " +
                    "position: relative; overflow: hidden;\"><h1>标题</h1></section>";
        var output = MdToPptController.SanitizeSection(input);

        // 根元素不得保留 display / min-height / position（这三类是黑屏根因）
        var rootTag = output[..(output.IndexOf('>') + 1)];
        Assert.DoesNotContain("display", rootTag);
        Assert.DoesNotContain("min-height", rootTag);
        Assert.DoesNotContain("position", rootTag);
        // padding 这类无害属性保留在根上
        Assert.Contains("padding: 4rem", rootTag);
        // data 属性保留（reveal 背景色）
        Assert.Contains("data-background-color=\"var(--bg)\"", rootTag);
        // 布局意图（flex 居中）搬到 pp-root 包裹层
        Assert.Contains("class=\"pp-root\"", output);
        Assert.Contains("display: flex", output);
        Assert.Contains("justify-content: center", output);
        // 内容完整
        Assert.Contains("<h1>标题</h1>", output);
        Assert.EndsWith("</section>", output);
    }

    [Fact]
    public void VhUnits_ReplacedWithSafeValue()
    {
        var input = "<section style=\"padding:2rem\"><div style=\"min-height:100vh\">x</div></section>";
        var output = MdToPptController.SanitizeSection(input);
        Assert.DoesNotContain("100vh", output);
        Assert.Contains("min-height:100%", output);
    }

    [Fact]
    public void NoRootStyle_StillWrapsWithPpRoot_ForOverflowFitTarget()
    {
        var input = "<section><h2>无样式页</h2><ul><li>a</li></ul></section>";
        var output = MdToPptController.SanitizeSection(input);
        Assert.Contains("class=\"pp-root\"", output);
        Assert.Contains("<h2>无样式页</h2>", output);
    }

    [Fact]
    public void SizingAndPositioning_Dropped_NotMovedToWrapper()
    {
        var input = "<section style=\"width: 960px; height: 700px; margin: 0 auto; transform: scale(1.1); top: 10px;\">y</section>";
        var output = MdToPptController.SanitizeSection(input);
        Assert.DoesNotContain("width: 960px", output);
        Assert.DoesNotContain("height: 700px", output);
        Assert.DoesNotContain("margin", output);
        Assert.DoesNotContain("transform: scale", output);
        Assert.DoesNotContain("top: 10px", output);
    }

    [Fact]
    public void InnerElementStyles_Untouched()
    {
        var input = "<section style=\"display:flex\"><div style=\"display:flex;gap:12px;width:48%\">cards</div></section>";
        var output = MdToPptController.SanitizeSection(input);
        // 内层元素的布局样式不受影响（消毒只针对 section 根）
        Assert.Contains("<div style=\"display:flex;gap:12px;width:48%\">cards</div>", output);
    }

    // ─── 标签碎片检测（2026-06-11 真实事故：上游丢 "<"，标签退化成可见正文）───

    [Fact]
    public void CorruptedSection_MissingAngleBrackets_Detected()
    {
        // 真实事故样本形态：多处 "<" 丢失，div class=... 变成正文
        var corrupted = "<section> div style=\"position: relative; width: 960px;\"> " +
                        "<div style=\"flex:1\"> div class=\"step-num\" style=\"width: 80px;\"> 内容 " +
                        " div class=\"card\" style=\"background: var(--card);\"> 更多内容</div></section>";
        Assert.True(MdToPptController.LooksCorruptedSection(corrupted));
    }

    [Fact]
    public void HealthySection_WithManyInlineStyles_NotFlagged()
    {
        // 完好页：标签完整，inline style 再多也不该误判
        var healthy = "<section><div style=\"display:flex\"><div class=\"card\" style=\"padding:20px\">A</div>" +
                      "<div class=\"card\" style=\"padding:20px\">B</div><div class=\"stat\" style=\"color:red\">C</div></div></section>";
        Assert.False(MdToPptController.LooksCorruptedSection(healthy));
    }

    [Fact]
    public void CodeSampleSection_FewAttrLiterals_NotFlagged()
    {
        // 展示代码片段的合法页（1-2 处属性字样在正文中）低于阈值，不误伤
        var codePage = "<section><h2>示例</h2><pre>用法：写 class=\"card\" 即可</pre></section>";
        Assert.False(MdToPptController.LooksCorruptedSection(codePage));
    }

    [Fact]
    public void OpenAiCompatibleProfile_UsesGatewayDirect()
    {
        var profile = new InfraAgentRuntimeProfile
        {
            Runtime = InfraAgentRuntimes.ClaudeSdk,
            Protocol = InfraAgentRuntimeProtocols.OpenAiCompatible,
            Model = "qwen-max",
        };

        Assert.True(MdToPptController.ShouldUseGatewayDirect(profile));
    }

    [Fact]
    public void AnthropicProfile_UsesGatewayDirect()
    {
        var profile = new InfraAgentRuntimeProfile
        {
            Runtime = InfraAgentRuntimes.ClaudeSdk,
            Protocol = InfraAgentRuntimeProtocols.Anthropic,
            Model = "claude-sonnet",
        };

        Assert.True(MdToPptController.ShouldUseGatewayDirect(profile));
    }

    [Fact]
    public void CustomRuntime_KeepsCdsAgentCompatibilityPath()
    {
        var profile = new InfraAgentRuntimeProfile
        {
            Runtime = InfraAgentRuntimes.Custom,
            Protocol = InfraAgentRuntimeProtocols.Anthropic,
            Model = "custom-agent-model",
        };

        Assert.False(MdToPptController.ShouldUseGatewayDirect(profile));
    }

    [Fact]
    public void RunnableSlideFragment_RejectsFullHtmlAndScript()
    {
        Assert.False(MdToPptController.IsRunnableSlideFragment("<html><body><section>x</section></body></html>", anchored: false));
        Assert.False(MdToPptController.IsRunnableSlideFragment("<section><script>alert(1)</script></section>", anchored: false));
        Assert.True(MdToPptController.IsRunnableSlideFragment(
            "<section><div class=\"pp-root\"><h2>产品发布</h2><div class=\"grid g3\"><div class=\"card\">A</div><div class=\"stat\">42%</div></div></div></section>",
            anchored: false));
    }

    [Fact]
    public void RunnableSlideFragment_RejectsGenericTitleAndPlainBulletPage()
    {
        Assert.False(MdToPptController.IsRunnableSlideFragment(
            "<section><div class=\"pp-root\"><h2>封面</h2><ul><li>A</li><li>B</li></ul></div></section>",
            anchored: false));
        Assert.False(MdToPptController.IsRunnableSlideFragment(
            "<section><div class=\"pp-root\"><h2>产品发布</h2><ul><li>A</li><li>B</li><li>C</li></ul></div></section>",
            anchored: false));
        Assert.True(MdToPptController.LooksLikeLowQualitySlide(
            "<section><h2>总结</h2><ul><li>A</li><li>B</li></ul></section>"));
    }

    [Fact]
    public void RunnableAnchoredSlide_AcceptsOfficialHtmlPptSectionRoot()
    {
        var slide = "<section class=\"slide s-cover hairlines\" data-title=\"封面\"><h1>产品发布</h1><div class=\"card\">A</div><div class=\"stat\">42%</div></section>";
        Assert.True(MdToPptController.IsRunnableSlideFragment(slide, anchored: true));
    }

    [Fact]
    public void GatewayPageRequest_PinsExpectedModelAndKeepsStream()
    {
        var profile = new InfraAgentRuntimeProfile
        {
            Protocol = InfraAgentRuntimeProtocols.OpenAiCompatible,
            Model = "qwen-max",
            TimeoutSeconds = 120,
        };

        var request = MdToPptController.BuildGatewayPageRequest(profile, "sys", "usr", "md-to-ppt-test::chat", "req1", "u1", "page1");

        Assert.True(request.Stream);
        Assert.Equal("qwen-max", request.ExpectedModel);
        Assert.Equal("md-to-ppt-test::chat", request.AppCallerCode);
        Assert.Equal("req1", request.Context?.RequestId);
        Assert.Equal("u1", request.Context?.UserId);
        Assert.Equal(4096, request.RequestBody?["max_tokens"]?.GetValue<int>());
    }

    [Fact]
    public void SystemGatewayProfile_ProvidesZeroConfigurationFallback()
    {
        var profile = MdToPptController.CreateSystemGatewayProfile("user-1");

        Assert.Equal(MdToPptController.SystemGatewayProfileId, profile.Id);
        Assert.Equal(string.Empty, profile.Model);
        Assert.True(profile.IsDefault);
        Assert.True(MdToPptController.ShouldUseGatewayDirect(profile));
        Assert.Equal("自动选择", MdToPptController.GenerationModelLabel(profile));
    }

    [Fact]
    public void OutlineCompletionBudget_StaysWithinGatewayCompatibilityCeiling()
    {
        Assert.Equal(4096, MdToPptController.OutlineCompletionTokenBudget);
    }

    [Fact]
    public void RunnableDeckDocument_RejectsCssOnlyTruncationAndAcceptsRealDecks()
    {
        var truncated = "<!DOCTYPE html><html><head><style>" + new string('x', 220) +
                        ".deck{}.slide{}.reveal{}.slides{}";
        Assert.False(MdToPptController.IsRunnableDeckDocument(truncated));

        var fakeClasses = "<!DOCTYPE html><html><head><style>.deck{}.slide{}</style></head><body>" +
                          new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(fakeClasses));

        var scriptedFake = "<!DOCTYPE html><html><head></head><body><script>" +
                           "const fake = '<div class=\"deck\"><section class=\"slide\">x</section></div>';" +
                           "</script>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(scriptedFake));

        var unclosedScript = "<!DOCTYPE html><html><head></head><body><script>" +
                             "const fake = '<section class=\"slide\">伪页面</section>';" +
                             new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(unclosedScript));

        var unclosedHeadScript = "<!DOCTYPE html><html><head><script>const fake='</head><body>" +
                                 "<section class=\"slide\">伪页面</section>" + new string('x', 220) +
                                 "</body></html>'";
        Assert.False(MdToPptController.IsRunnableDeckDocument(unclosedHeadScript));

        var balancedHeadScriptFake = "<!DOCTYPE html><html><head><script>const fake='</head><body>" +
                                     "<section class=\"slide\">伪页面</section>" + new string('x', 220) +
                                     "</body></html>';</script></head></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(balancedHeadScriptFake));

        var emptySlide = "<!DOCTYPE html><html><head><style>" + new string('x', 220) +
                         "</style></head><body><section class=\"slide\"></section></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(emptySlide));

        var unclosedSlide = "<!DOCTYPE html><html><head></head><body><section class=\"slide\"><h1>标题</h1>" +
                            new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(unclosedSlide));

        var hiddenBody = "<!DOCTYPE html><html><head><style>body{display:none}</style></head><body>" +
                         "<section class=\"slide\"><h1>标题</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenBody));

        var hiddenInlineBody = "<!DOCTYPE html><html><head></head><body style='visibility:hidden'>" +
                               "<section class=\"slide\"><h1>标题</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenInlineBody));

        var hiddenSlide = "<!DOCTYPE html><html><head></head><body><section class=\"slide\" hidden>" +
                          "<h1>标题</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenSlide));

        var hiddenAriaSlide = "<!DOCTYPE html><html><head></head><body><section class=\"slide\" aria-hidden=\"true\">" +
                              "<h1>标题</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenAriaSlide));

        var emptySvg = "<!DOCTYPE html><html><head></head><body><section class=\"slide\"><svg></svg></section>" +
                       new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(emptySvg));

        var emptySvgPath = "<!DOCTYPE html><html><head></head><body><section class=\"slide\"><svg><defs>" +
                           "<path d=\"M0 0\"></path></defs><path d=\"\"></path></svg></section>" +
                           new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(emptySvgPath));

        var hiddenSlidesWithoutActive = "<!DOCTYPE html><html><head><style>.slide{display:none}</style></head><body>" +
                                        "<section class=\"slide\"><h1>标题</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenSlidesWithoutActive));

        var hiddenSlidesAfterComment = "<!DOCTYPE html><html><head><style>/* deck */ .slide{display:none}</style></head><body>" +
                                       "<section class=\"slide\"><h1>标题</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenSlidesAfterComment));

        var printOnlyHidden = "<!DOCTYPE html><html><head><style>@media print{body{display:none}}</style></head><body>" +
                              "<section class=\"slide active\"><h1>序</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(printOnlyHidden));

        var screenHidden = "<!DOCTYPE html><html><head><style>@media screen{body{display:none}}</style></head><body>" +
                           "<section class=\"slide active\"><h1>序</h1></section>" + new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(screenHidden));

        var hiddenNotesOnly = "<!DOCTYPE html><html><head><style>.slide .notes{display:none}</style></head><body>" +
                              "<section class=\"slide active\"><h1>序</h1><div class=\"notes\">备注</div></section>" +
                              new string('x', 220) + "</body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(hiddenNotesOnly));

        var hideInactiveOnly = "<!DOCTYPE html><html><head><style>.slide:not(.active){display:none}</style></head><body>" +
                               "<section class=\"slide active\"><h1>序</h1></section>" +
                               new string('x', 220) + "</body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(hideInactiveOnly));

        var hiddenAncestor = "<!DOCTYPE html><html><head></head><body><div class=\"deck\" hidden>" +
                             "<section class=\"slide active\"><h1>" + new string('x', 220) + "</h1></section></div></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenAncestor));

        var hiddenDeckClass = "<!DOCTYPE html><html><head><style>.deck{display:none}</style></head><body><div class=\"deck\">" +
                              "<section class=\"slide active\"><h1>" + new string('x', 220) + "</h1></section></div></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenDeckClass));

        var unrelatedHiddenDeckClass = "<!DOCTYPE html><html><head><style>.missing .deck{display:none}</style></head><body><div class=\"deck\">" +
                                       "<section class=\"slide active\"><h1>" + new string('x', 220) + "</h1></section></div></body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(unrelatedHiddenDeckClass));

        var restoredDeckClass = "<!DOCTYPE html><html><head><style>.deck{display:none}.deck.active{display:block}</style></head>" +
                                "<body><div class=\"deck active\"><section class=\"slide active\"><h1>" +
                                new string('x', 220) + "</h1></section></div></body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(restoredDeckClass));

        var importantHidden = "<!DOCTYPE html><html><head><style>.slide{opacity:0!important}.slide.active{opacity:1}</style></head><body>" +
                              "<section class=\"slide active\"><h1>" + new string('x', 220) + "</h1></section></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(importantHidden));

        var importantRestored = "<!DOCTYPE html><html><head><style>.slide{opacity:0!important}.slide.active{opacity:1!important}</style></head><body>" +
                                "<section class=\"slide active\"><h1>" + new string('x', 220) + "</h1></section></body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(importantRestored));

        var impossibleActiveSelector = "<!DOCTYPE html><html><head><style>.slide{display:none!important}" +
                                       ".missing .slide.active{display:block!important}</style></head><body>" +
                                       "<section class=\"slide active\"><h1>" + new string('x', 220) + "</h1></section></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(impossibleActiveSelector));

        var wrongPropertyRestore = "<!DOCTYPE html><html><head><style>.slide{display:none}.slide.active{opacity:1}</style></head><body>" +
                                   "<section class=\"slide active\"><h1>" + new string('x', 220) + "</h1></section></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(wrongPropertyRestore));

        var anchored = "<!DOCTYPE html><html><head><style>.slide{}</style></head><body><div class=\"deck\">" +
                       "<section class=\"slide active\"><h1>标题</h1></section></div>" +
                       new string('x', 220) + "</body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(anchored));

        var reveal = "<!DOCTYPE html><html><head></head><body><div class='reveal'><div class='slides'>" +
                     "<section><h1>标题</h1></section></div></div>" + new string('x', 220) + "</body></html>";
        Assert.True(MdToPptController.IsRunnableDeckDocument(reveal));

        var revealWithBlankPage = "<!DOCTYPE html><html><head></head><body><div class='reveal'><div class='slides'>" +
                                  "<section><h1>标题</h1></section><section></section></div></div>" +
                                  new string('x', 220) + "</body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(revealWithBlankPage));

        var hiddenReveal = "<!DOCTYPE html><html><head><style>.reveal{display:none}</style></head><body>" +
                           "<div class='reveal'><div class='slides'><section><h1>" + new string('x', 220) + "</h1></section></div></div></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenReveal));

        var hiddenRevealPages = "<!DOCTYPE html><html><head><style>.reveal .slides section{display:none}</style></head><body>" +
                                "<div class='reveal'><div class='slides'><section><h1>" + new string('x', 220) + "</h1></section></div></div></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(hiddenRevealPages));

        var revealVerticalBlankPage = "<!DOCTYPE html><html><head></head><body><div class='reveal'><div class='slides'>" +
                                      "<section><section><h1>" + new string('x', 220) + "</h1></section><section></section></section>" +
                                      "</div></div></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(revealVerticalBlankPage));

        var fakeRevealRelation = "<!DOCTYPE html><html><head></head><body><div class='reveal'><div class='slides'></div></div>" +
                                 "<template><section><h1>" + new string('x', 220) + "</h1></section></template></body></html>";
        Assert.False(MdToPptController.IsRunnableDeckDocument(fakeRevealRelation));
    }

    [Fact]
    public void SlideBlockScanner_AgreesWithValidatorAcrossQuotesAndCase()
    {
        var html = "<div class='SLIDE active'><h1>第一页</h1></div>" +
                   "<section class=\"slide-counter\">计数器</section>" +
                   "<article class=\"card slide\"><p>第二页</p></article>";
        var blocks = MdToPptController.FindSlideBlocks(html);

        Assert.Equal(2, blocks.Count);
        Assert.Contains("第一页", html.Substring(blocks[0].Start, blocks[0].Length));
        Assert.Contains("第二页", html.Substring(blocks[1].Start, blocks[1].Length));
    }

    [Fact]
    public void StructuralMask_PreventsScriptTemplateFromBecomingPatchTarget()
    {
        var html = "<script>const tpl = '<section class=\"slide\">模板</section>';</script>" +
                   "<div class=\"slide active\"><h1>真实页面</h1></div>";
        var masked = MdToPptController.MaskNonStructuralMarkup(html);
        var blocks = MdToPptController.FindSlideBlocks(masked);

        Assert.Single(blocks);
        Assert.Contains("真实页面", html.Substring(blocks[0].Start, blocks[0].Length));
    }

    [Fact]
    public void PatchPageScanner_UsesRevealLeafSectionsForVerticalDecks()
    {
        var html = "<div class='reveal'><div class='slides'><section>" +
                   "<section><h1>纵向第一页</h1></section><section><h1>纵向第二页</h1></section>" +
                   "</section></div></div>";
        var blocks = MdToPptController.FindPatchPageBlocks(html);

        Assert.Equal(2, blocks.Count);
        Assert.Contains("纵向第一页", html.Substring(blocks[0].Start, blocks[0].Length));
        Assert.Contains("纵向第二页", html.Substring(blocks[1].Start, blocks[1].Length));
        Assert.DoesNotContain("纵向第二页", html.Substring(blocks[0].Start, blocks[0].Length));
        Assert.False(MdToPptController.IsAnchoredPatchBlock(html.Substring(blocks[0].Start, blocks[0].Length)));

        var anchored = "<section class='slide active'><h1>锚定页</h1></section>";
        Assert.True(MdToPptController.IsAnchoredPatchBlock(anchored));
    }

    [Theory]
    [InlineData("bold-poster")]
    [InlineData("cobalt-grid")]
    [InlineData("coral")]
    [InlineData("cyber-terminal")]
    [InlineData("dark-graph")]
    [InlineData("grove")]
    [InlineData("monochrome")]
    [InlineData("retro-zine")]
    [InlineData("soft-editorial")]
    [InlineData("vellum")]
    public void RunnableDeckDocument_AcceptsEveryBundledOpenDesignAnchor(string anchorName)
    {
        var anchor = MdToPptAnchors.Load(anchorName);
        Assert.NotNull(anchor);
        var html = anchor!.Prefix + MdToPptController.AddActiveToFirstSlide(anchor.Slides[0].Html) + anchor.Suffix;
        Assert.True(MdToPptController.IsRunnableDeckDocument(html), anchorName);
    }

    [Fact]
    public void PatchSlideIndex_UsesExplicitFieldThenBoundedPagePhrase()
    {
        Assert.Equal(4, MdToPptController.ResolvePatchSlideIndex(4, "修改第 2 页"));
        Assert.Equal(2, MdToPptController.ResolvePatchSlideIndex(null, "仅调整第 2 页的布局"));
        Assert.Equal(12, MdToPptController.ResolvePatchSlideIndex(null, "重绘第十二页"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "生成 5 页演示稿"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "修改第 99 页"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "删除第 3 页"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "第 2 页与第 3 页对调"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "把第 2 页移动到第 5 页"));
        Assert.Equal(3, MdToPptController.ResolvePatchSlideIndex(null, "增加第 3 页标题字号"));
        Assert.Equal(3, MdToPptController.ResolvePatchSlideIndex(null, "把第 3 页标题移动到左侧"));
        Assert.Equal(3, MdToPptController.ResolvePatchSlideIndex(null, "合并第 3 页的两栏间距"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "在第 3 页后插入一页"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "把第 3 页移到最后"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "把第 3 页和封面交换"));
        Assert.Null(MdToPptController.ResolvePatchSlideIndex(null, "将第 3 页与下一页对调"));
    }

    [Fact]
    public void PagePrompt_IncludesCustomTemplateStyleForSinglePagePatch()
    {
        var prompt = MdToPptController.BuildPageSystemPrompt(
            "tech-dark",
            1,
            5,
            "奶油纸底、钴蓝细线、编辑部排版");

        Assert.Contains("自定义模板", prompt);
        Assert.Contains("奶油纸底、钴蓝细线、编辑部排版", prompt);
        Assert.Contains("第 2/5 页", prompt);
    }

    [Fact]
    public void GatewayPageRequest_CanExposeThinkingForWholeDeck()
    {
        var profile = MdToPptController.CreateSystemGatewayProfile("user-1");

        var request = MdToPptController.BuildGatewayPageRequest(
            profile,
            "sys",
            "usr",
            "md-to-ppt-test::chat",
            includeThinking: true);

        Assert.True(request.IncludeThinking);
        Assert.Null(request.ExpectedModel);
    }

    [Fact]
    public void ResolveTargetPages_UsesExplicitPageCountBeforeDefault()
    {
        var req = new MdToPptOutlineRequest { Content = "严格生成 2 页高级产品发布会 PPT" };
        Assert.Equal(2, MdToPptController.ResolveTargetPages(req));
        Assert.Equal(12, MdToPptController.ParseExplicitPageCount("输出十二页技术方案"));
    }

    [Fact]
    public void NormalizeOutlinePayload_TrimsExtraPages()
    {
        var raw = "{\"totalPages\":4,\"summary\":\"x\",\"outline\":[" +
                  "{\"title\":\"A\",\"bullets\":[]}," +
                  "{\"title\":\"B\",\"bullets\":[]}," +
                  "{\"title\":\"C\",\"bullets\":[]}]}";
        var normalized = MdToPptController.NormalizeOutlinePayload(raw, 2);
        Assert.Equal(2, normalized["totalPages"]?.GetValue<int>());
        Assert.Equal(2, normalized["outline"]?.AsArray().Count);
    }

    [Fact]
    public void ConsoleDashboardBrief_AvoidsPosterTheme()
    {
        var theme = MdToPptController.EffectiveThemeForRequest(
            "sunset-bold",
            "严格生成 2 页高级控制台操作面板 PPT",
            null);
        Assert.Equal("cobalt-grid", theme);
        Assert.Equal("cobalt-grid", MdToPptController.EffectiveThemeForRequest(
            "ocean-glass",
            "高级控制台 dashboard",
            null));
        Assert.True(MdToPptController.LooksLikeConsoleVisualMismatch(
            "<div class=\"slide\"><h1 style=\"font-family:Playfair Display;font-style:italic\">控制台总览</h1></div>",
            "soft-editorial"));
        Assert.True(MdToPptController.LooksLikeConsoleVisualMismatch(
            "<div class=\"slide\"><h1>CONTROL PANEL KNOWLEDGE PUBLISHER</h1><p>今日生成 342 次</p></div>",
            "cyber-terminal"));
        Assert.True(MdToPptController.LooksLikeConsoleVisualMismatch(
            "<div class=\"slide\"><h1>知识库发布控制台</h1><p>panel status queue preview publish flow task card grid progress 指标 任务队列 发布状态</p></div>",
            "cobalt-grid"));
        Assert.False(MdToPptController.LooksLikeConsoleVisualMismatch(
            "<div class=\"console-dashboard\"><div class=\"panel metric\">指标</div><div class=\"panel queue\">任务队列</div><div class=\"panel preview\">发布状态</div></div>",
            "cobalt-grid"));
    }

    [Fact]
    public void ConsoleDashboardFallbackSlide_UsesOperationalPanels()
    {
        var page = new MdToPptOutlinePageDto
        {
            Title = "控制台总览",
            Bullets = new List<string> { "知识库引用", "生成海报教程文案 HTML", "自动发布到网页托管", "可预览可编辑" },
        };
        var html = MdToPptController.ConsoleDashboardFallbackSlide(null, page, 0, 2);
        Assert.Contains("console-dashboard", html);
        Assert.Contains("任务队列", html);
        Assert.Contains("网页托管预览", html);
        Assert.Contains("知识库引用", html);
    }

    [Fact]
    public void PatchProvenance_IsClonedOnlyFromPersistedParentRun()
    {
        var parent = new MdToPptRun
        {
            Id = "parent-run",
            UserId = "user-1",
            SourceSurface = DesignArtifactSourceSurfaces.KnowledgeBase,
            KnowledgeReferences =
            [
                new DesignKnowledgeSnapshot
                {
                    EntryId = "entry-1",
                    StoreId = "store-1",
                    StoreName = "产品知识",
                    Title = "发布方案",
                    Content = "服务端正文",
                    ContentHash = "hash-1",
                },
            ],
        };

        var inherited = MdToPptController.InheritPatchProvenance(parent);

        Assert.Equal(DesignArtifactSourceSurfaces.KnowledgeBase, inherited.SourceSurface);
        var snapshot = Assert.Single(inherited.KnowledgeReferences);
        Assert.Equal("服务端正文", snapshot.Content);
        Assert.NotSame(parent.KnowledgeReferences[0], snapshot);

        var noParent = MdToPptController.InheritPatchProvenance(null);
        Assert.Equal(DesignArtifactSourceSurfaces.HtmlPpt, noParent.SourceSurface);
        Assert.Empty(noParent.KnowledgeReferences);
    }
}
