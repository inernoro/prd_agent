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
    public void IsRawMatch_NormalizesBothSides(string rawA, string rawB, bool expected)
    {
        Assert.Equal(expected, GitHubAuthorMatcher.IsRawMatch(rawA, rawB));
    }
}
