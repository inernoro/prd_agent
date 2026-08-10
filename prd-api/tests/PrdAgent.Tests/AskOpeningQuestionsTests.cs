using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 开场问题的三态取舍守卫。
///
/// 为什么值得一条专门的测试：「分享时自选开场问题」整个功能的正确性都压在
/// `null`（没选过，继承站点题库）与 `[]`（明确选了一条都不显示）能被区分上。
/// 一旦有人给 WebPageShareLink.AskSuggestedQuestions 补个 `= new()` 初始化器，
/// 或者把 `??` 图省事写成 `?.Count > 0 ? ... : ...`，两种状态就糊成一个，
/// 表现是「用户取消了全部开场问题、保存后又原样回来」——编译过、其它测试全绿。
/// </summary>
public class AskOpeningQuestionsTests
{
    private static readonly List<string> Library = new() { "站点题库一", "站点题库二" };

    [Fact]
    public void Resolve_没选过_继承站点题库()
    {
        // 存量分享文档没有这个字段，反序列化就是 null
        var result = AskOpeningQuestions.Resolve(null, Library);
        Assert.Equal(Library, result);
    }

    [Fact]
    public void Resolve_选了空数组_不许回退到站点题库()
    {
        // 这条是最容易被写坏的一支：用户明确表示"这条链接不要开场问题"
        var result = AskOpeningQuestions.Resolve(new List<string>(), Library);
        Assert.Empty(result);
    }

    [Fact]
    public void Resolve_选了几条_只用自己选的()
    {
        var picked = new List<string> { "只问这一条" };
        var result = AskOpeningQuestions.Resolve(picked, Library);
        Assert.Equal(picked, result);
    }

    [Fact]
    public void Resolve_两边都没有_返回空表而不是null()
    {
        var result = AskOpeningQuestions.Resolve(null, null);
        Assert.NotNull(result);
        Assert.Empty(result);
    }

    [Fact]
    public void Normalize_去空白丢空串去重并保序()
    {
        var result = AskOpeningQuestions.Normalize(new List<string>
        {
            "  这是一个问题  ",
            "",
            "   ",
            "这是一个问题",   // 与第一条 trim 后重复
            "另一个问题",
        });

        Assert.Equal(new List<string> { "这是一个问题", "另一个问题" }, result);
    }

    [Fact]
    public void Normalize_超长截断到上限()
    {
        var longQuestion = new string('问', AskOpeningQuestions.MaxLength + 20);
        var result = AskOpeningQuestions.Normalize(new List<string> { longQuestion });

        Assert.Single(result);
        Assert.Equal(AskOpeningQuestions.MaxLength, result[0].Length);
    }

    /// <summary>
    /// 存储上限必须大于展示上限。
    ///
    /// 这条原本写反了——断言 Normalize 会把题库砍到 MaxDisplay(4)，等于用测试把 bug 锁死：
    /// 题库是候选池，分享时从中挑子集，砍到 4 条就挑无可挑，owner 存的第 5 条还会静默消失。
    /// PR #1351 第四轮 review 抓出后改成断言正确语义。
    /// </summary>
    [Fact]
    public void 题库存储上限必须大于面板展示上限()
    {
        Assert.True(AskOpeningQuestions.MaxLibrary > AskOpeningQuestions.MaxDisplay,
            "题库若不比展示上限大，「分享时自选开场问题」就没有可挑的余地");
    }

    [Fact]
    public void Normalize_默认限到题库上限_而不是展示上限()
    {
        var many = Enumerable.Range(1, AskOpeningQuestions.MaxLibrary + 5)
            .Select(i => $"问题{i}")
            .ToList();

        var result = AskOpeningQuestions.Normalize(many);

        Assert.Equal(AskOpeningQuestions.MaxLibrary, result.Count);
        Assert.Equal("问题1", result[0]);
    }

    /// <summary>
    /// 核心用例：owner 存 MaxDisplay+1 条题库，必须一条不少地留下来。
    /// 原实现在这里会悄悄丢掉第 5 条及以后——存进去了，回显没了。
    /// </summary>
    [Fact]
    public void 题库存超过展示上限的条数_不许静默丢弃()
    {
        var library = Enumerable.Range(1, AskOpeningQuestions.MaxDisplay + 3)
            .Select(i => $"问题{i}")
            .ToList();

        var stored = AskOpeningQuestions.Normalize(library);

        Assert.Equal(library.Count, stored.Count);
        Assert.Equal(library, stored);
    }

    [Fact]
    public void 面板显示时才限到展示上限()
    {
        var library = Enumerable.Range(1, AskOpeningQuestions.MaxDisplay + 3)
            .Select(i => $"问题{i}")
            .ToList();

        var shown = AskOpeningQuestions.Resolve(null, library);

        Assert.Equal(AskOpeningQuestions.MaxDisplay, shown.Count);
    }

    /// <summary>
    /// 提问默认必须关着。评论默认开（零边际成本），提问默认关（每次都烧 token 和钱）——
    /// 这个差异是刻意的，靠 HostedSite.AskEnabled 不写初始化器实现：
    /// Mongo 反序列化存量文档（没有该字段）时保留默认值 false。
    /// 谁要是顺手补个 `= true`，存量所有站点会在下一次读取时静默变成"已开放提问"。
    /// </summary>
    [Fact]
    public void 新建站点_提问默认关闭_评论默认开启()
    {
        var site = new HostedSite();

        Assert.False(site.AskEnabled);
        Assert.True(site.CommentsEnabled);
        Assert.False(site.AskAllowAnonymous);
    }

    /// <summary>
    /// 分享链接的开场问题字段默认必须是 null，不是空表。
    /// 这条直接锁住"别加初始化器"——加了它就立刻变红。
    /// </summary>
    [Fact]
    public void 新建分享链接_开场问题默认为null表示未选过()
    {
        var share = new WebPageShareLink();

        Assert.Null(share.AskSuggestedQuestions);
        // 且这个默认值经 Resolve 后确实走"继承站点题库"这一支
        Assert.Equal(Library, AskOpeningQuestions.Resolve(share.AskSuggestedQuestions, Library));
    }
}
