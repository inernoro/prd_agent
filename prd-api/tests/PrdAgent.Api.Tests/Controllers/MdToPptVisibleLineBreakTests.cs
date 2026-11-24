using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class MdToPptVisibleLineBreakTests
{
    [Theory]
    [InlineData("<br>")]
    [InlineData("<br />")]
    [InlineData("<BR class=\"line-break\">")]
    public void QualityGate_DoesNotJoinRemainingCapacityWithNextActivityDate(string lineBreak)
    {
        const string source = "剩余名额0。2026-09-19 10:00—11:00 旧物的新故事。";
        var page = new MdToPptOutlinePageDto { Title = "活动名额", Bullets = new() };
        var html = "<section class=\"slide\"><span style=\"color:var(--hc-amber)\">剩余名额0</span>"
                   + lineBreak + "2026-09-19 10:00—11:00 旧物的新故事。</section>";

        var result = MdToPptController.ValidateUnsupportedVisibleClaims(html, page, null, source);

        Assert.False(result.Rejected, $"实际换行不应拼成无来源数字：{result.Kind}/{result.NormalizedToken}");
    }

    [Theory]
    [InlineData("<span>9<span>9</span></span>")]
    [InlineData("<span>99</span><br>2026-09-19")]
    public void QualityGate_StillRejectsInventedNumbersAndInlineDigitSplitting(string html)
    {
        var page = new MdToPptOutlinePageDto { Title = "活动名额", Bullets = new() };
        var result = MdToPptController.ValidateUnsupportedVisibleClaims(
            html, page, null, "剩余名额9。2026-09-19。");

        Assert.True(result.Rejected);
        Assert.Equal("99", result.NormalizedToken);
    }
}
