using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「提问默认全开，除非明确拒绝」的判据守卫（用户口径，2026-08-29）。
///
/// 这条口径是翻转过来的：原先 AskEnabled 是 bool、默认 false，owner 必须显式打开。
/// 翻转时最容易写错的不是「默认开」，而是**把存量一把刷成开**——那样会连 owner 当初
/// 特意关掉的站点一起打开，而在 bool 里这两种状态长得一模一样。所以字段改成三态，
/// 这里钉住三态各自的答案；任何一处退回 `?? false` 或 `=== true`，对应用例就变红。
/// </summary>
public class AskDefaultOnPolicyTests
{
    [Fact]
    public void 从没表过态的站点默认开()
    {
        // 存量站点在 Mongo 里压根没有这个字段，反序列化后就是 null
        Assert.True(AskAccessPolicy.IsAskOn(null, wrappedAssetType: null));
    }

    [Fact]
    public void 明确打开的站点开()
    {
        Assert.True(AskAccessPolicy.IsAskOn(true, null));
    }

    /// <summary>核心用例：明确拒绝必须被尊重，默认值不得把它顶回去。</summary>
    [Fact]
    public void 明确关掉的站点不许被默认值顶开()
    {
        Assert.False(AskAccessPolicy.IsAskOn(false, null));
    }

    /// <summary>形态不支持压过默认值：开关打得开、每个访客吃 422 是耍用户。</summary>
    [Fact]
    public void 视频站即使没表过态也不开()
    {
        Assert.False(AskAccessPolicy.IsAskOn(null, "video"));
        Assert.False(AskAccessPolicy.IsAskOn(true, "video"));
    }

    [Fact]
    public void 非视频形态不受影响()
    {
        Assert.True(AskAccessPolicy.IsAskOn(null, "pdf"));
        Assert.True(AskAccessPolicy.IsAskOn(null, "html"));
    }

    /// <summary>
    /// 分享侧的暴露判定要吃 IsAskOn 的结果：合集仍然一律不开放，
    /// 但单站点分享在「没表过态」时应当暴露入口——这正是用户看到「没有向我提问」的那条路径。
    /// </summary>
    [Fact]
    public void 单站点分享在没表过态时也暴露提问入口()
    {
        var on = AskAccessPolicy.IsAskOn(null, "html");
        Assert.True(AskAccessPolicy.ShouldExposeAskOnShare(sharedSiteCount: 1, siteAskEnabled: on));
        Assert.False(AskAccessPolicy.ShouldExposeAskOnShare(sharedSiteCount: 3, siteAskEnabled: on));
    }

    /// <summary>
    /// 开场问题的生成判据必须与「给不给提问入口」同源。断言打真实的
    /// <see cref="AskOpeningQuestionGenerator.NeedsGeneration"/>，不是把 IsAskOn 再调一遍
    /// ——后者是循环论证，改坏了也不会红。
    /// </summary>
    [Theory]
    [InlineData(false, null)]   // 明确关掉
    [InlineData(null, "video")] // 形态不支持
    [InlineData(true, "video")] // 说了要开，但形态压过
    public void 入口关着时一定不生成开场问题(bool? askEnabled, string? wrappedAssetType)
    {
        var site = new HostedSite { AskEnabled = askEnabled, WrappedAssetType = wrappedAssetType };
        Assert.False(AskAccessPolicy.IsAskOn(site.AskEnabled, site.WrappedAssetType));
        Assert.False(AskOpeningQuestionGenerator.NeedsGeneration(site));
    }

    /// <summary>反面：没表过态的支持形态，入口开着，生成这一关也得放行。</summary>
    [Fact]
    public void 没表过态的支持形态会进入生成流程()
    {
        var site = new HostedSite { AskEnabled = null, WrappedAssetType = "html" };
        Assert.True(AskAccessPolicy.IsAskOn(site.AskEnabled, site.WrappedAssetType));
        Assert.True(AskOpeningQuestionGenerator.NeedsGeneration(site));
    }
}
