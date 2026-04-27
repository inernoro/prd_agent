using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// Markdown 导入周报的单元测试。覆盖：
/// 1. Prompt 构造包含所有 inputType 的 schema 片段（尤其 issue-list 的留空硬规则）
/// 2. 规则兜底按 H2 标题 normalize 后匹配模板章节
/// 3. issue-list 章节的 issueCategoryKey / issueStatusKey 始终留 null
/// 4. 标题 normalize：中英混排 + emoji + 符号
/// 5. Levenshtein 距离早停
/// </summary>
public class ReportImportMarkdownTests
{
    private static ReportTemplate CreateTemplateAllInputTypes() => new()
    {
        Id = "tpl-test",
        Name = "测试模板",
        Sections = new List<ReportTemplateSection>
        {
            new() { Title = "本周完成", InputType = "bullet-list", IsRequired = true, MaxItems = 5 },
            new() { Title = "关键指标", InputType = "key-value", IsRequired = true, MaxItems = 5 },
            new() { Title = "项目进度", InputType = "progress-table", IsRequired = false, MaxItems = 5 },
            new() { Title = "本周问题", InputType = "issue-list", IsRequired = true, MaxItems = 10 },
            new() { Title = "下周计划", InputType = "rich-text", IsRequired = false },
            new() { Title = "备注", InputType = "free-text", IsRequired = false }
        }
    };

    [Fact]
    public void BuildImportUserPrompt_ShouldEmbedAllInputTypeSchemas()
    {
        var prompt = ReportGenerationService.BuildImportUserPrompt(
            CreateTemplateAllInputTypes(),
            "## 本周完成\n- 完成了 A\n",
            2026, 17);

        Assert.Contains("本周完成", prompt);
        // bullet-list schema
        Assert.Contains("\"content\": \"<条目文本>\"", prompt);
        // key-value schema
        Assert.Contains("\"sourceRef\": \"<数值或文本值>\"", prompt);
        // progress-table schema
        Assert.Contains("\"sourceRef\": \"<进度描述", prompt);
        // issue-list schema + 硬规则
        Assert.Contains("\"issueCategoryKey\": null, \"issueStatusKey\": null", prompt);
        Assert.Contains("issueCategoryKey 和 issueStatusKey 必须留 null", prompt);
        // rich-text / free-text
        Assert.Contains("<段落文本，可含 markdown>", prompt);
        // source 固定
        Assert.Contains("markdown-import", prompt);
        // 禁编造
        Assert.Contains("禁止编造", prompt);
    }

    [Fact]
    public void BuildImportUserPrompt_ShouldIncludeUploadedMarkdownWrappedByDelimiters()
    {
        var md = "## 本周完成\n- 重构了账户中心\n";
        var prompt = ReportGenerationService.BuildImportUserPrompt(
            CreateTemplateAllInputTypes(), md, 2026, 17);

        Assert.Contains("<<<MARKDOWN", prompt);
        Assert.Contains("MARKDOWN>>>", prompt);
        Assert.Contains("重构了账户中心", prompt);
    }

    [Fact]
    public void BuildFallbackFromMarkdown_ShouldMatchH2HeadingsIntoTemplateSections()
    {
        var md = @"# 2026 W17 周报

## 本周完成
- 完成账户中心重构
- 发布 v2.1

## 下周计划
继续推进 v2.2 规划

## 不在模板的无关章节
某些自由内容";

        var sections = ReportGenerationService.BuildFallbackFromMarkdown(md, CreateTemplateAllInputTypes());

        // "本周完成" 匹配到第 0 个 bullet-list 章节
        Assert.Equal(6, sections.Count);
        Assert.Equal(2, sections[0].Items.Count);
        Assert.Contains(sections[0].Items, i => i.Content.Contains("账户中心"));
        // 所有 source 都应该是 markdown-import
        Assert.All(sections[0].Items, i => Assert.Equal("markdown-import", i.Source));

        // "下周计划" 匹配到 rich-text 章节 — 整段作为 1 条 item
        var richTextIdx = sections.FindIndex(s => s.TemplateSection.InputType == "rich-text");
        Assert.True(richTextIdx >= 0);
        Assert.NotEmpty(sections[richTextIdx].Items);
    }

    [Fact]
    public void BuildFallbackFromMarkdown_IssueListSection_MustHaveNullCategoryAndStatus()
    {
        var md = @"# 周报

## 本周问题
- 登录页报错 #1234
- 图表加载慢 #2210";

        var sections = ReportGenerationService.BuildFallbackFromMarkdown(md, CreateTemplateAllInputTypes());
        var issueSection = sections.First(s => s.TemplateSection.InputType == "issue-list");

        Assert.NotEmpty(issueSection.Items);
        Assert.All(issueSection.Items, item =>
        {
            Assert.Null(item.IssueCategoryKey);
            Assert.Null(item.IssueStatusKey);
            Assert.Null(item.ImageUrls);
            Assert.Equal("markdown-import", item.Source);
        });
    }

    [Fact]
    public void BuildFallbackFromMarkdown_KeyValueSection_ShouldSplitContentAndSourceRef()
    {
        var md = @"# 周报

## 关键指标
代码提交: 32 次
任务闭环: 8 / 10";

        var sections = ReportGenerationService.BuildFallbackFromMarkdown(md, CreateTemplateAllInputTypes());
        var kvSection = sections.First(s => s.TemplateSection.InputType == "key-value");

        Assert.NotEmpty(kvSection.Items);
        var firstItem = kvSection.Items.FirstOrDefault(i => i.Content.Contains("代码提交"));
        Assert.NotNull(firstItem);
        Assert.Equal("32 次", firstItem!.SourceRef);
    }

    [Fact]
    public void BuildFallbackFromMarkdown_UnmatchedContent_ShouldFallIntoFirstFreeTextSection()
    {
        var md = @"# 周报

## 完全不在模板中的段落标题
这是一段无法归类的内容";

        var sections = ReportGenerationService.BuildFallbackFromMarkdown(md, CreateTemplateAllInputTypes());

        // 未匹配内容应进入第一个 rich-text / free-text 章节
        var richOrFree = sections.First(s =>
            s.TemplateSection.InputType == "rich-text" || s.TemplateSection.InputType == "free-text");
        Assert.NotEmpty(richOrFree.Items);
        Assert.Contains(richOrFree.Items, i => i.Content.Contains("无法归类"));
    }

    [Theory]
    [InlineData("📝 本周完成", "本周完成")]
    [InlineData("本周 · 完成!", "本周完成")]
    [InlineData("  Weekly   Progress  ", "weeklyprogress")]
    [InlineData("", "")]
    [InlineData("💼 项目 —— 进度", "项目进度")]
    public void NormalizeHeading_ShouldStripSymbolsAndEmojiAndLowercase(string input, string expected)
    {
        Assert.Equal(expected, ReportGenerationService.NormalizeHeading(input));
    }

    [Fact]
    public void LevenshteinDistance_ShouldReturnZeroForIdentical()
    {
        Assert.Equal(0, ReportGenerationService.LevenshteinDistance("abc", "abc", 3));
    }

    [Fact]
    public void LevenshteinDistance_ShouldEarlyStopWhenOverMax()
    {
        // 完全不同的长字符串，距离应早停在 maxDistance+1
        var result = ReportGenerationService.LevenshteinDistance("abcdefghij", "1234567890", 2);
        Assert.True(result > 2);
    }

    [Fact]
    public void LevenshteinDistance_CloseStrings_ShouldMeasureCorrectly()
    {
        Assert.Equal(1, ReportGenerationService.LevenshteinDistance("abc", "abd", 3));
        Assert.Equal(2, ReportGenerationService.LevenshteinDistance("本周完成", "本周结束", 5));
    }
}
