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
        Assert.StartsWith("<div class=\"slide s-cover hairlines active\">", withActive);
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
}
