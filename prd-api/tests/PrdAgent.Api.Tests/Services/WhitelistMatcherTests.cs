using PrdAgent.Infrastructure.Services.Channels;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 白名单匹配服务单元测试
/// </summary>
public class WhitelistMatcherTests
{
    #region Pattern Matching Tests

    [Theory]
    [InlineData("user@example.com", "user@example.com", true)]  // 精确匹配
    [InlineData("user@example.com", "other@example.com", false)] // 不匹配
    [InlineData("*@example.com", "user@example.com", true)]     // 域名通配符
    [InlineData("*@example.com", "admin@example.com", true)]    // 域名通配符
    [InlineData("*@example.com", "user@other.com", false)]      // 域名不匹配
    [InlineData("user@*.com", "user@example.com", true)]        // 中间通配符
    [InlineData("user@*.com", "user@test.com", true)]           // 中间通配符
    [InlineData("user@*.com", "other@example.com", false)]      // 用户名不匹配
    [InlineData("*", "anything@anywhere.com", true)]            // 全通配符
    [InlineData("*@*.com", "user@example.com", true)]           // 多通配符
    [InlineData("admin*@example.com", "admin123@example.com", true)] // 部分通配符
    [InlineData("admin*@example.com", "user@example.com", false)]    // 部分不匹配
    public void MatchPattern_ShouldMatchCorrectly(string pattern, string identifier, bool expected)
    {
        var result = WhitelistMatcherService.MatchPattern(pattern, identifier);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("USER@EXAMPLE.COM", "user@example.com", true)]  // 大小写不敏感
    [InlineData("*@EXAMPLE.COM", "user@example.com", true)]     // 大小写不敏感
    [InlineData("User@Example.Com", "USER@EXAMPLE.COM", true)]  // 大小写不敏感
    public void MatchPattern_ShouldBeCaseInsensitive(string pattern, string identifier, bool expected)
    {
        var result = WhitelistMatcherService.MatchPattern(pattern, identifier);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("", "user@example.com", false)]     // 空模式
    [InlineData("user@example.com", "", false)]     // 空标识
    [InlineData("", "", false)]                     // 都为空
    [InlineData(null, "user@example.com", false)]   // null 模式
    [InlineData("user@example.com", null, false)]   // null 标识
    public void MatchPattern_ShouldHandleEmptyOrNull(string? pattern, string? identifier, bool expected)
    {
        var result = WhitelistMatcherService.MatchPattern(pattern!, identifier!);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("  user@example.com  ", "user@example.com", true)]  // 前后空格
    [InlineData("*@example.com", "  user@example.com  ", true)]     // 标识有空格
    public void MatchPattern_ShouldTrimWhitespace(string pattern, string identifier, bool expected)
    {
        var result = WhitelistMatcherService.MatchPattern(pattern, identifier);
        Assert.Equal(expected, result);
    }

    #endregion

    #region Phone Number Pattern Tests

    [Theory]
    [InlineData("+86*", "+8613800138000", true)]            // 中国号码通配
    [InlineData("+86138*", "+8613800138000", true)]         // 号段通配
    [InlineData("+86138*", "+8613900138000", false)]        // 号段不匹配
    [InlineData("+8613800138000", "+8613800138000", true)]  // 精确匹配
    public void MatchPattern_ShouldMatchPhonePatterns(string pattern, string identifier, bool expected)
    {
        var result = WhitelistMatcherService.MatchPattern(pattern, identifier);
        Assert.Equal(expected, result);
    }

    #endregion

    #region Special Characters Tests

    [Theory]
    [InlineData("user+tag@example.com", "user+tag@example.com", true)]  // 加号
    [InlineData("user.name@example.com", "user.name@example.com", true)] // 点号
    [InlineData("user-name@example.com", "user-name@example.com", true)] // 连字符
    [InlineData("*+*@example.com", "user+tag@example.com", true)]       // 加号通配
    public void MatchPattern_ShouldHandleSpecialCharacters(string pattern, string identifier, bool expected)
    {
        var result = WhitelistMatcherService.MatchPattern(pattern, identifier);
        Assert.Equal(expected, result);
    }

    #endregion

    #region Regex Special Characters Escaping Tests

    [Theory]
    [InlineData("user.name@example.com", "username@example.com", false)]   // 点号不应作为正则任意字符
    [InlineData("user[1]@example.com", "user[1]@example.com", true)]       // 方括号
    [InlineData("user(1)@example.com", "user(1)@example.com", true)]       // 圆括号
    [InlineData("user$@example.com", "user$@example.com", true)]           // 美元符号
    [InlineData("user^@example.com", "user^@example.com", true)]           // 脱字符
    public void MatchPattern_ShouldEscapeRegexSpecialChars(string pattern, string identifier, bool expected)
    {
        var result = WhitelistMatcherService.MatchPattern(pattern, identifier);
        Assert.Equal(expected, result);
    }

    #endregion
}
