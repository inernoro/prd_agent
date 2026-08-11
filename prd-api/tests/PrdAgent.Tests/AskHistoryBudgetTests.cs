using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 对话历史预算闸的守卫。
///
/// 由 PR #1351 的 Codex review 抓出：提问端点在分享路径上是**匿名可达**的，
/// 历史由客户端提交，原实现只限条数（TakeLast 8）不限长度——直接打端点的人
/// 可以塞 8 条几 MB 的字符串。配额闸数的是「请求次数」，拦不住「单次超大」，
/// 一次请求就能啃掉站点主一大块 token 额度。
/// </summary>
public class AskHistoryBudgetTests
{
    [Fact]
    public void 空输入返回空表()
    {
        Assert.Empty(AskHistoryBudget.Trim(null));
        Assert.Empty(AskHistoryBudget.Trim(new List<(string?, string?)>()));
    }

    [Fact]
    public void 丢掉空白条目()
    {
        var result = AskHistoryBudget.Trim(new List<(string?, string?)>
        {
            ("user", "有内容"), ("user", ""), ("assistant", "   "), ("assistant", null),
        });
        Assert.Single(result);
        Assert.Equal("有内容", result[0].Content);
    }

    [Fact]
    public void 角色只认assistant其余归为user()
    {
        var result = AskHistoryBudget.Trim(new List<(string?, string?)>
        {
            ("ASSISTANT", "a"), ("user", "b"), ("system", "c"), (null, "d"),
        });
        Assert.Equal(new[] { "assistant", "user", "user", "user" }, result.Select(r => r.Role));
    }

    [Fact]
    public void 超过条数上限只留最近几条()
    {
        var many = Enumerable.Range(1, AskHistoryBudget.MaxMessages + 5)
            .Select(i => ((string?)"user", (string?)$"第{i}条"))
            .ToList();

        var result = AskHistoryBudget.Trim(many);

        Assert.Equal(AskHistoryBudget.MaxMessages, result.Count);
        // 保留的是最近的，不是最早的
        Assert.Equal($"第{AskHistoryBudget.MaxMessages + 5}条", result[^1].Content);
    }

    /// <summary>
    /// 核心用例：单条超长必须被截断。
    /// 只限条数不限长度等于没限——这正是 review 抓到的那个洞。
    /// </summary>
    [Fact]
    public void 单条超长被截断而不是原样放行()
    {
        var huge = new string('字', 5_000_000);
        var result = AskHistoryBudget.Trim(new List<(string?, string?)> { ("user", huge) });

        Assert.Single(result);
        Assert.Equal(AskHistoryBudget.MaxCharsPerMessage, result[0].Content.Length);
    }

    [Fact]
    public void 多条超长时总量不超过总预算()
    {
        var big = new string('字', AskHistoryBudget.MaxCharsPerMessage);
        var many = Enumerable.Range(1, AskHistoryBudget.MaxMessages)
            .Select(_ => ((string?)"user", (string?)big))
            .ToList();

        var result = AskHistoryBudget.Trim(many);

        var total = result.Sum(r => r.Content.Length);
        Assert.True(total <= AskHistoryBudget.MaxTotalChars,
            $"历史总量 {total} 超过预算 {AskHistoryBudget.MaxTotalChars}");
    }

    [Fact]
    public void 攻击载荷_八条各五百万字_被压到预算之内()
    {
        // 原实现下这会是 4000 万字符直接进 prompt
        var payload = Enumerable.Range(1, AskHistoryBudget.MaxMessages)
            .Select(_ => ((string?)"user", (string?)new string('攻', 5_000_000)))
            .ToList();

        var result = AskHistoryBudget.Trim(payload);

        Assert.True(result.Sum(r => r.Content.Length) <= AskHistoryBudget.MaxTotalChars);
    }

    [Fact]
    public void 保留时间先后顺序()
    {
        var result = AskHistoryBudget.Trim(new List<(string?, string?)>
        {
            ("user", "先"), ("assistant", "中"), ("user", "后"),
        });
        Assert.Equal(new[] { "先", "中", "后" }, result.Select(r => r.Content));
    }

    [Fact]
    public void 预算不足时优先保住最近的上下文()
    {
        // 每条都占满单条上限，总预算只装得下前几条——应当保住靠后的
        var per = AskHistoryBudget.MaxCharsPerMessage;
        var items = new List<(string?, string?)>
        {
            ("user", new string('旧', per)),
            ("user", new string('中', per)),
            ("user", new string('新', per)),
        };

        var result = AskHistoryBudget.Trim(items);

        Assert.NotEmpty(result);
        Assert.Equal('新', result[^1].Content[0]);
    }
}
