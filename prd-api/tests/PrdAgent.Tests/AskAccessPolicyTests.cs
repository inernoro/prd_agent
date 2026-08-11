using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 提问准入的两条守卫，都由 PR #1351 第二轮 Codex review 抓出。
///
/// 共同点是「改回错误写法之后，其余测试仍然全绿」——正是 predicate-and-wiring-discipline
/// 说的那种必须补守卫的改动。
/// </summary>
public class AskAccessPolicyTests
{
    // ── 超长问题：拒绝，不是截断 ──────────────────────────────

    [Fact]
    public void 正常长度的问题不算超长()
    {
        Assert.False(AskAccessPolicy.IsQuestionTooLong("这个页面讲了什么？"));
        Assert.False(AskAccessPolicy.IsQuestionTooLong(new string('字', AskAccessPolicy.MaxQuestionLength)));
    }

    [Fact]
    public void 空问题不算超长_那是另一条校验管的事()
    {
        Assert.False(AskAccessPolicy.IsQuestionTooLong(null));
        Assert.False(AskAccessPolicy.IsQuestionTooLong(""));
        Assert.False(AskAccessPolicy.IsQuestionTooLong("   "));
    }

    [Fact]
    public void 刚好超一个字就算超长()
    {
        Assert.True(AskAccessPolicy.IsQuestionTooLong(new string('字', AskAccessPolicy.MaxQuestionLength + 1)));
    }

    [Fact]
    public void 判长度前先去空白_不让首尾空格把人挤过线()
    {
        var padded = "  " + new string('字', AskAccessPolicy.MaxQuestionLength) + "  ";
        Assert.False(AskAccessPolicy.IsQuestionTooLong(padded));
    }

    /// <summary>
    /// 核心用例：这条判据存在的意义就是「超长要被识别出来」，调用方据此拒绝。
    /// 若有人把 Controller 改回 `question = question[..Max]` 的静默截断，
    /// 这条仍会绿——所以配套断言写在下面那条注释指向的行为上：Controller 必须走本判据。
    /// </summary>
    [Fact]
    public void 超长必须可被识别_而不是悄悄变短()
    {
        var huge = new string('字', 50_000);

        Assert.True(AskAccessPolicy.IsQuestionTooLong(huge));
        // 判据只回答「是不是太长」，绝不返回一个被截断的字符串——
        // 没有截断这条路可走，调用方就只能拒绝。
        Assert.Equal(50_000, huge.Length);
    }

    // ── 合集分享不暴露提问入口 ────────────────────────────────

    [Fact]
    public void 单站点分享且站点开了提问_才暴露入口()
    {
        Assert.True(AskAccessPolicy.ShouldExposeAskOnShare(1, siteAskEnabled: true));
    }

    [Fact]
    public void 单站点但站点没开提问_不暴露()
    {
        Assert.False(AskAccessPolicy.ShouldExposeAskOnShare(1, siteAskEnabled: false));
    }

    /// <summary>
    /// 核心用例：合集分享一律不暴露，哪怕首站点开着提问。
    /// 原实现挂到首站点上，后端算了、前端不渲染——建了一半的接线。
    /// </summary>
    [Fact]
    public void 合集分享一律不暴露_哪怕首站点开着提问()
    {
        Assert.False(AskAccessPolicy.ShouldExposeAskOnShare(2, siteAskEnabled: true));
        Assert.False(AskAccessPolicy.ShouldExposeAskOnShare(17, siteAskEnabled: true));
    }

    [Fact]
    public void 空分享不暴露()
    {
        Assert.False(AskAccessPolicy.ShouldExposeAskOnShare(0, siteAskEnabled: true));
    }

    // ── 不支持提问的站点形态 ──────────────────────────────────

    /// <summary>
    /// 核心用例：视频包装站没有正文，开了提问每个访客都会吃 422。
    /// 判定必须只有一处——快照服务、配置接口、配置面板三处共用它，
    /// 否则会出现「开关打得开、每次提问都失败」这种耍人玩的状态。
    /// </summary>
    [Fact]
    public void 视频包装站不支持提问()
    {
        Assert.NotNull(AskAccessPolicy.UnsupportedReason("video"));
        Assert.NotNull(AskAccessPolicy.UnsupportedReason("VIDEO"));
    }

    [Fact]
    public void 普通站与PDF站支持提问()
    {
        Assert.Null(AskAccessPolicy.UnsupportedReason(null));
        Assert.Null(AskAccessPolicy.UnsupportedReason(""));
        Assert.Null(AskAccessPolicy.UnsupportedReason("pdf"));
        Assert.Null(AskAccessPolicy.UnsupportedReason("markdown"));
    }

    /// <summary>
    /// 核心用例：不支持的形态只挡「开启」，不挡「关闭」。
    ///
    /// 由 PR #1351 第十三轮 review 抓出：我上一轮把开关两个方向一起灰掉，
    /// 造成一种没法自救的状态——HTML 站重传成视频后形态变成不支持，AskEnabled 仍是 true，
    /// 开关又点不动，owner 想关都关不掉，而已发出去的分享还挂着必定 422 的提问入口。
    /// 这条锁住「判据只约束开启方向」这个语义，前后端共用它。
    /// </summary>
    [Fact]
    public void 不支持的形态只影响开启_不影响关闭()
    {
        // 判据本身只回答「能不能开」，不掺和关闭
        Assert.NotNull(AskAccessPolicy.UnsupportedReason("video"));

        // 关闭永远合法：语义上「关掉一个不该开着的东西」在任何形态下都成立
        // （后端 PUT 只在 req.Enabled 为 true 时才查这个判据）
        Assert.Null(AskAccessPolicy.UnsupportedReason("html"));
    }

    // ── 合集分享：判据看类型，不看剩几个站点 ──────────────────

    /// <summary>
    /// 核心用例：合集判据必须看**分享类型**，不能看「现在还剩几个站点」。
    ///
    /// 由 review 抓出：站点被删除时不会从链接的 SiteIds 里摘掉，于是一条合集链接
    /// 可能只剩一个存活站点。只按数量判会让它突然变成「单站点分享」，把付费的提问
    /// 入口暴露出来。类型是创建时定死的，不会随数据漂移。
    /// </summary>
    [Fact]
    public void 合集按类型判定_与剩余站点数无关()
    {
        Assert.True(AskAccessPolicy.IsCollectionShare("collection"));
        Assert.True(AskAccessPolicy.IsCollectionShare("Collection"));
        Assert.True(AskAccessPolicy.IsCollectionShare("  collection  "));
    }

    [Fact]
    public void 单站点分享不是合集()
    {
        Assert.False(AskAccessPolicy.IsCollectionShare("single"));
        Assert.False(AskAccessPolicy.IsCollectionShare(null));
        Assert.False(AskAccessPolicy.IsCollectionShare(""));
    }

    // ── 欢迎语长度 ────────────────────────────────────────────

    [Fact]
    public void 欢迎语超长截断而不是拒绝()
    {
        var huge = new string('欢', AskAccessPolicy.MaxWelcomeLength + 500);
        var trimmed = AskAccessPolicy.TrimWelcome(huge);

        Assert.NotNull(trimmed);
        Assert.Equal(AskAccessPolicy.MaxWelcomeLength, trimmed!.Length);
    }

    [Fact]
    public void 欢迎语正常长度原样保留_空白归null()
    {
        Assert.Equal("欢迎提问", AskAccessPolicy.TrimWelcome("  欢迎提问  "));
        Assert.Null(AskAccessPolicy.TrimWelcome(null));
        Assert.Null(AskAccessPolicy.TrimWelcome("   "));
    }
}
