using PrdAgent.Infrastructure.Services.Changelog;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 更新中心彩蛋：GitHub 作者名 ↔ 系统用户名匹配规则（去数字 + 去分隔符 + 颠倒容忍）。
/// </summary>
public class GitHubAuthorMatcherTests
{
    [Theory]
    [InlineData("inernoro123", "inernoro")]
    [InlineData("Zhang_San 01", "zhangsan")]
    [InlineData("wang-wu.2024", "wangwu")]
    [InlineData("王五", "王五")]
    [InlineData("  ", "")]
    [InlineData(null, "")]
    [InlineData("12345", "")]
    public void Normalize_StripsDigitsSeparatorsAndLowercases(string? raw, string expected)
    {
        Assert.Equal(expected, GitHubAuthorMatcher.Normalize(raw));
    }

    [Theory]
    [InlineData("inernoro", "inernoro", true)]       // 完全相等
    [InlineData("zhangsan", "sanzhang", true)]        // 姓名颠倒（环状旋转）
    [InlineData("xiaomingwang", "wangxiaoming", true)] // 三字名颠倒
    [InlineData("alice", "bob", false)]               // 完全不同
    [InlineData("zhangsan", "zhangsi", false)]        // 同姓不同名
    [InlineData("a", "a", false)]                     // 单字母不匹配（防误伤）
    [InlineData("王五", "王五", true)]                 // CJK 两字
    [InlineData("zhangsan", "zhangsann", false)]      // 长度不同且不相等
    public void IsMatch_HandlesEqualityAndRotation(string a, string b, bool expected)
    {
        Assert.Equal(expected, GitHubAuthorMatcher.IsMatch(a, b));
    }

    [Theory]
    [InlineData("inernoro123", "Inernoro", true)]     // GitHub 名带数字 vs 系统名
    [InlineData("San-Zhang", "zhangsan88", true)]     // 颠倒 + 数字 + 分隔符叠加
    [InlineData("dev-bot", "devuser", false)]
    [InlineData("yurenping-miduo", "yurenping", true)]  // 通用组织后缀剥离
    [InlineData("chenshuhuai-miduo", "chenshuhuai", true)]
    [InlineData("Kitty-0313", "kitty", true)]           // 数字段后缀剥离（归一化天然处理）
    [InlineData("weixisheng-miduo", "shengweixi", true)]  // 剥后缀后再命中颠倒规则
    [InlineData("yurenping-miduo", "renyuping", false)]   // 剥后缀后既不相等也非颠倒
    public void IsRawMatch_NormalizesBothSides(string rawA, string rawB, bool expected)
    {
        Assert.Equal(expected, GitHubAuthorMatcher.IsRawMatch(rawA, rawB));
    }

    [Fact]
    public void NormalizedVariants_StripsCommonOrgSuffix()
    {
        var variants = GitHubAuthorMatcher.NormalizedVariants("yurenping-miduo");
        Assert.Equal(new[] { "yurenpingmiduo", "yurenping" }, variants);

        // 剥后缀后剩余不足 2 字符 → 不产出剥离变体
        Assert.Equal(new[] { "amiduo" }, GitHubAuthorMatcher.NormalizedVariants("a-miduo"));
        // 无后缀 → 只有原始归一化
        Assert.Equal(new[] { "inernoro" }, GitHubAuthorMatcher.NormalizedVariants("inernoro"));
    }

    [Fact]
    public void ParseCoAuthorNames_ExtractsTrailers()
    {
        const string message = "feat: 某功能\n\n正文说明\n\n" +
            "Co-authored-by: yurenping-miduo <yurenping-miduo@users.noreply.github.com>\n" +
            "Co-Authored-By: chenshuhuai-miduo <chenshh@miduonet.com>\n" +
            "Co-authored-by: yurenping-miduo <dup@example.com>\n" +
            "Co-authored-by: NoEmailName\n";
        var names = GitHubAuthorMatcher.ParseCoAuthorNames(message);
        Assert.Equal(new[] { "yurenping-miduo", "chenshuhuai-miduo", "NoEmailName" }, names);
    }

    [Fact]
    public void ParseCoAuthorNames_EmptyWhenNoTrailer()
    {
        Assert.Empty(GitHubAuthorMatcher.ParseCoAuthorNames("fix: 普通提交\n\n没有联合作者"));
        Assert.Empty(GitHubAuthorMatcher.ParseCoAuthorNames(null));
    }

    [Theory]
    [InlineData("yurenping-miduo <a@b.com>", "yurenping-miduo")]
    [InlineData("  Plain Name  ", "Plain Name")]
    [InlineData("<only@email>", null)]
    [InlineData("", null)]
    public void ExtractNameFromTrailerValue_HandlesEmailAndPlain(string? value, string? expected)
    {
        Assert.Equal(expected, GitHubAuthorMatcher.ExtractNameFromTrailerValue(value));
    }
}
