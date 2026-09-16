using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 精读稿的部署作用域判据。
///
/// 盯的是 `cross-project-isolation` 通道 4 在这个集合上的形态：同一个 CDS 项目下
/// 所有分支共用一个 Mongo，而这个集合原先一本书只有一行。两条分支的提示词版本或
/// 规则材料一旦不同，各自的新鲜度判据都会判对方那篇过期，于是互相覆盖、反复重烧——
/// 钱一直在花，谁也验不准自己这条分支的产出。
///
/// 判据收成纯函数是有意的：作用域来自进程环境变量，挂在 env 上的用例只有真跑在
/// CDS 分支预览容器里才走得到，多半会写成一条永远跳过的绿灯（形状 4）。
/// </summary>
public class BookshelfDigestScopeTests
{
    private static BookDigest Doc(string? slug) => new()
    {
        BookId = "b-lamp",
        Content = "x",
        DeploymentSlug = slug,
    };

    [Fact(DisplayName = "自己写的那篇优先于权威部署那篇")]
    public void PickVisible_PrefersOwn()
    {
        var picked = BookshelfDigestScope.PickVisible(
            new[] { Doc(null), Doc("proj::branch-a") }, "proj::branch-a");
        picked!.DeploymentSlug.ShouldBe(
            "proj::branch-a",
            customMessage: "读到了权威那份：本分支明明生成过，却每次点开都判过期再重烧一篇");
    }

    [Fact(DisplayName = "自己没生成过时，兜底读权威部署那篇")]
    public void PickVisible_FallsBackToAuthoritative()
    {
        var picked = BookshelfDigestScope.PickVisible(new[] { Doc(null) }, "proj::branch-a");
        picked.ShouldNotBeNull(
            customMessage: "不兜底的话每条新预览分支都是一页空书，第一个人要等一篇全新生成");
        picked!.DeploymentSlug.ShouldBeNull();
    }

    [Fact(DisplayName = "看不见兄弟分支写的那篇")]
    public void PickVisible_IgnoresSiblingBranch()
    {
        var picked = BookshelfDigestScope.PickVisible(
            new[] { Doc("proj::branch-b") }, "proj::branch-a");
        picked.ShouldBeNull(
            customMessage: "读到了兄弟分支那篇：两条分支会互相判过期、互相覆盖、反复重烧");
    }

    [Fact(DisplayName = "权威部署读 null 那篇，且读不到任何分支的")]
    public void Authoritative_ReadsOnlyNullScope()
    {
        BookshelfDigestScope.PickVisible(new[] { Doc(null) }, null)
            .ShouldNotBeNull();
        BookshelfDigestScope.PickVisible(new[] { Doc("proj::branch-a") }, null)
            .ShouldBeNull(customMessage: "权威部署读到了分支预览写的稿子");
    }

    [Fact(DisplayName = "存量文档（无该字段）当成权威部署写的，不需要迁移")]
    public void LegacyDocuments_ReadAsAuthoritative()
    {
        BookshelfDigestScope.IsVisible(null, "proj::branch-a").ShouldBeTrue();
        BookshelfDigestScope.IsVisible(null, null).ShouldBeTrue();
    }
}
