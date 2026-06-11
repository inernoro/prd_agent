using PrdAgent.Api.Controllers.Api;
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
}
