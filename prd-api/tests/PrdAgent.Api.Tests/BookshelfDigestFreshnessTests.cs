using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 精读稿的新鲜度判据。
///
/// 这组守卫盯的是一个会静默发生的退化：第三段「我们在哪儿栽过」整段来自这本书挂的
/// relatedRules，给它改挂一条规则、或者规则正文本身改了，提示词一个字没动、版本号照旧，
/// 于是库里那篇用旧材料写的稿子会一直被当成新鲜的端给读者——第三段和当前挂的规则对不上，
/// 还没有任何东西提示它过期。
///
/// 把 MaterialFingerprint 从判据里拿掉，下面第三条会红。
/// </summary>
public class BookshelfDigestFreshnessTests
{
    private static BookshelfDigestPrompt.Material MakeMaterial(params string[] ruleNames)
    {
        return new BookshelfDigestPrompt.Material
        {
            Book = new BookshelfDigestPrompt.BookCtx
            {
                Id = "b-demo",
                Title = "示例之书",
                Author = "示例作者",
                Level = 1,
                Why = "编者理由",
                Takeaway = "一句话收获",
                RelatedRules = ruleNames.ToList(),
            },
            Volume = new BookshelfDigestPrompt.VolumeCtx
            {
                Id = "vol-demo", Index = 1, Name = "示例卷", Subtitle = "副标题",
                PainQuote = "处境", Cure = "药方",
            },
            Rules = ruleNames.Select(n => new BookshelfDigestPrompt.RuleCtx
            {
                Name = n, Title = n, OneLine = "要求 " + n, WhenHit = "什么时候撞上 " + n, History = "事故 " + n,
            }).ToList(),
        };
    }

    private static BookDigest MakeDigest(BookshelfDigestPrompt.Material material) => new()
    {
        BookId = material.Book.Id,
        Content = "## 这本书在说什么\n正文",
        PromptVersion = BookshelfDigestPrompt.Version,
        MaterialFingerprint = BookshelfDigestPrompt.ComputeMaterialFingerprint(material),
    };

    [Fact]
    public void 同一份材料算出来的指纹稳定()
    {
        var m = MakeMaterial("rule-a", "rule-b");
        BookshelfDigestPrompt.ComputeMaterialFingerprint(m)
            .ShouldBe(BookshelfDigestPrompt.ComputeMaterialFingerprint(m));
    }

    [Fact]
    public void 刚生成的那一篇是新鲜的()
    {
        var m = MakeMaterial("rule-a");
        BookshelfDigestPrompt.IsFresh(MakeDigest(m), m).ShouldBeTrue();
    }

    /*
     * 这条是整组的要害：改挂规则之后旧稿必须判过期。
     * 把 MaterialFingerprint 从 IsFresh 里删掉，只留 PromptVersion，这条就会红——
     * 因为提示词版本在这个场景里根本没变。
     */
    [Fact]
    public void 给这本书改挂一条规则之后旧稿判过期()
    {
        var before = MakeMaterial("rule-a");
        var digest = MakeDigest(before);

        var after = MakeMaterial("rule-a", "rule-b");

        BookshelfDigestPrompt.IsFresh(digest, after).ShouldBeFalse(
            customMessage: "多挂了一条规则，第三段的材料已经变了，这一篇必须判过期");
    }

    [Fact]
    public void 规则正文改了之后旧稿也判过期()
    {
        var before = MakeMaterial("rule-a");
        var digest = MakeDigest(before);

        var after = MakeMaterial("rule-a");
        after.Rules[0].History = "事故 rule-a（补充了新的复盘）";

        BookshelfDigestPrompt.IsFresh(digest, after).ShouldBeFalse(
            customMessage: "规则正文变了，喂给模型的材料就变了，这一篇必须判过期");
    }

    [Fact]
    public void 提示词升版之后旧稿判过期()
    {
        var m = MakeMaterial("rule-a");
        var digest = MakeDigest(m);
        digest.PromptVersion = "v-old";

        BookshelfDigestPrompt.IsFresh(digest, m).ShouldBeFalse();
    }

    [Fact]
    public void 加这个字段之前写的稿子一律判过期()
    {
        var m = MakeMaterial("rule-a");
        var digest = MakeDigest(m);
        digest.MaterialFingerprint = string.Empty;

        BookshelfDigestPrompt.IsFresh(digest, m).ShouldBeFalse(
            customMessage: "存量文档没有指纹，没有任何依据说它还对得上当前材料");
    }

    [Fact]
    public void 书单里已经没有这本书时判过期()
    {
        var m = MakeMaterial("rule-a");
        BookshelfDigestPrompt.IsFresh(MakeDigest(m), null).ShouldBeFalse(
            customMessage: "材料都取不到了，没有依据说它还新鲜");
    }

    [Fact]
    public void 空正文判过期()
    {
        var m = MakeMaterial("rule-a");
        var digest = MakeDigest(m);
        digest.Content = "   ";

        BookshelfDigestPrompt.IsFresh(digest, m).ShouldBeFalse();
    }
}
