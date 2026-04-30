using PrdAgent.Infrastructure.Services.MarketplaceSkills;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 单测 SkillZipMetadataExtractor.ParseFrontmatter — 这是 2026-05-01
/// 加的"幂等覆盖上传"链路的关键纯函数,决定 slug + version 兜底取值。
/// 边缘情况:无 frontmatter / 不规范引号 / 多余空行 / 大小写 / 中文。
/// </summary>
public class SkillZipMetadataExtractorTests
{
    [Fact]
    public void ParseFrontmatter_WithNameAndVersion_BothExtracted()
    {
        var content = "---\nname: foo\nversion: 1.2.3\ndescription: bar\n---\n# heading";
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter(content);
        Assert.Equal("foo", name);
        Assert.Equal("1.2.3", version);
    }

    [Fact]
    public void ParseFrontmatter_WithQuotes_StripsQuotes()
    {
        var content = "---\nname: \"my-skill\"\nversion: '1.0.0'\n---";
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter(content);
        Assert.Equal("my-skill", name);
        Assert.Equal("1.0.0", version);
    }

    [Fact]
    public void ParseFrontmatter_NoFrontmatter_ReturnsNulls()
    {
        var content = "# Just a heading\nno frontmatter here";
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter(content);
        Assert.Null(name);
        Assert.Null(version);
    }

    [Fact]
    public void ParseFrontmatter_OnlyName_VersionIsNull()
    {
        var content = "---\nname: cds\ndescription: blah\n---";
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter(content);
        Assert.Equal("cds", name);
        Assert.Null(version);
    }

    [Fact]
    public void ParseFrontmatter_LeadingBlankLines_StillParses()
    {
        var content = "\n\n---\nname: foo\nversion: 2.0.0\n---";
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter(content);
        Assert.Equal("foo", name);
        Assert.Equal("2.0.0", version);
    }

    [Fact]
    public void ParseFrontmatter_CaseInsensitiveKeys()
    {
        var content = "---\nName: foo\nVersion: 1.0.0\n---";
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter(content);
        Assert.Equal("foo", name);
        Assert.Equal("1.0.0", version);
    }

    [Fact]
    public void ParseFrontmatter_EmptyContent_ReturnsNulls()
    {
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter("");
        Assert.Null(name);
        Assert.Null(version);
    }

    [Fact]
    public void ParseFrontmatter_MalformedFrontmatter_NotCrash()
    {
        // 没闭合的 ---,只能抓到我们识别的行
        var content = "---\nname: foo\nbroken-no-colon-line\nversion: 1.0.0";
        var (name, version) = SkillZipMetadataExtractor.ParseFrontmatter(content);
        Assert.Equal("foo", name);
        Assert.Equal("1.0.0", version);
    }
}
