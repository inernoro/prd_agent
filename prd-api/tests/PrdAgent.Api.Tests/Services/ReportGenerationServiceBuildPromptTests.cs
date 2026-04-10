using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// ReportGenerationService.BuildUserPrompt 单元测试：验证 MAP 平台零数据指标不会进入提示词
/// </summary>
public class ReportGenerationServiceBuildPromptTests
{
    private static ReportTemplate CreateSimpleTemplate() => new()
    {
        Id = "tpl-test",
        Name = "测试模板",
        Sections = new List<ReportTemplateSection>
        {
            new() { Title = "本周任务进展", IsRequired = true, MaxItems = 5 },
            new() { Title = "下周计划", IsRequired = true, MaxItems = 5 }
        }
    };

    private static ReportGenerationService.GenerationSourcePrefs MapEnabledPrefs =>
        new(DailyLogEnabled: true, MapPlatformEnabled: true);

    [Fact]
    public void BuildUserPrompt_AllZeroMapMetrics_ShouldNotIncludeMapPlatformSection()
    {
        var activity = new CollectedActivity
        {
            UserId = "user-empty",
            // 所有 MAP 指标均为 0
            PrdSessions = 0,
            PrdMessageCount = 0,
            DefectsSubmitted = 0,
            VisualSessions = 0,
            ImageGenCompletedCount = 0,
            VideoGenCompletedCount = 0,
            DocumentEditCount = 0,
            WorkflowExecutionCount = 0,
            ToolboxRunCount = 0,
            WebPagePublishCount = 0,
            AttachmentUploadCount = 0,
            LlmCalls = 0,
            Commits = new List<ReportCommit>(),
            DailyLogs = new List<ReportDailyLog>()
        };

        var prompt = ReportGenerationService.BuildUserPrompt(
            CreateSimpleTemplate(), activity, 2026, 15, MapEnabledPrefs, "写作要求");

        Assert.DoesNotContain("MAP 平台工作记录（行为统计）", prompt);
        Assert.DoesNotContain("MAP 平台工作记录（代码提交）", prompt);
        Assert.DoesNotContain("PRD 对话会话", prompt);
        Assert.DoesNotContain("缺陷提交", prompt);
        Assert.DoesNotContain("视觉创作会话", prompt);
        Assert.DoesNotContain("AI 调用", prompt);
    }

    [Fact]
    public void BuildUserPrompt_ZeroPrdSessions_ShouldNotOutputPrdSessionsLine()
    {
        // 只有文档编辑和工作流有数据，其他均为 0
        var activity = new CollectedActivity
        {
            UserId = "user-partial",
            PrdSessions = 0,
            DefectsSubmitted = 0,
            VisualSessions = 0,
            LlmCalls = 0,
            DocumentEditCount = 3,
            WorkflowExecutionCount = 5,
            Commits = new List<ReportCommit>(),
            DailyLogs = new List<ReportDailyLog>()
        };

        var prompt = ReportGenerationService.BuildUserPrompt(
            CreateSimpleTemplate(), activity, 2026, 15, MapEnabledPrefs, "写作要求");

        Assert.Contains("MAP 平台工作记录（行为统计）", prompt);
        Assert.Contains("创建 PRD 项目: 3 个", prompt);
        Assert.Contains("自动化工作流执行: 5 次", prompt);

        // 零值指标绝对不应出现（既不能 "PRD 对话会话: 0 次" 也不能 "PRD 对话会话"）
        Assert.DoesNotContain("PRD 对话会话", prompt);
        Assert.DoesNotContain("缺陷提交", prompt);
        Assert.DoesNotContain("视觉创作会话", prompt);
        Assert.DoesNotContain("AI 调用", prompt);
    }

    [Fact]
    public void BuildUserPrompt_HasCommits_ShouldIncludeCommitSection()
    {
        var activity = new CollectedActivity
        {
            UserId = "user-coder",
            PrdSessions = 0,
            Commits = new List<ReportCommit>
            {
                new() { Message = "fix: login bug", CommittedAt = new DateTime(2026, 4, 8), Additions = 10, Deletions = 2 },
                new() { Message = "feat: add search", CommittedAt = new DateTime(2026, 4, 9), Additions = 30, Deletions = 0 }
            },
            DailyLogs = new List<ReportDailyLog>()
        };

        var prompt = ReportGenerationService.BuildUserPrompt(
            CreateSimpleTemplate(), activity, 2026, 15, MapEnabledPrefs, "写作要求");

        Assert.Contains("MAP 平台工作记录（代码提交）", prompt);
        Assert.Contains("fix: login bug", prompt);
        Assert.Contains("feat: add search", prompt);
        // PRD 会话为 0，不应出现
        Assert.DoesNotContain("PRD 对话会话", prompt);
    }

    [Fact]
    public void BuildUserPrompt_PromptInstruction_ShouldForbidFabrication()
    {
        var activity = new CollectedActivity
        {
            UserId = "user-x",
            Commits = new List<ReportCommit>(),
            DailyLogs = new List<ReportDailyLog>()
        };

        var prompt = ReportGenerationService.BuildUserPrompt(
            CreateSimpleTemplate(), activity, 2026, 15, MapEnabledPrefs, "写作要求");

        // 新指令必须明确禁止编造
        Assert.Contains("只基于实际存在的数据", prompt);
        Assert.Contains("不要提及或编造", prompt);
        // 旧指令必须被移除
        Assert.DoesNotContain("即使数据较少，也要基于已有数据写出有价值的总结", prompt);
    }

    [Fact]
    public void BuildUserPromptV2_AllZeroSystemStats_ShouldNotIncludeSystemStatsSection()
    {
        var activity = new CollectedActivity
        {
            UserId = "user-empty",
            PrdSessions = 0,
            PrdMessageCount = 0,
            DefectsSubmitted = 0,
            VisualSessions = 0,
            ImageGenCompletedCount = 0,
            VideoGenCompletedCount = 0,
            DocumentEditCount = 0,
            WorkflowExecutionCount = 0,
            ToolboxRunCount = 0,
            WebPagePublishCount = 0,
            AttachmentUploadCount = 0,
            LlmCalls = 0,
            Commits = new List<ReportCommit>(),
            DailyLogs = new List<ReportDailyLog>()
        };

        var prompt = ReportGenerationService.BuildUserPromptV2(
            CreateSimpleTemplate(),
            teamStats: null,
            personalStats: new List<SourceStats>(),
            activity: activity,
            weekYear: 2026,
            weekNumber: 15,
            effectivePrompt: "写作要求");

        Assert.DoesNotContain("### 系统活动统计", prompt);
        Assert.DoesNotContain("PRD 对话会话", prompt);
        Assert.DoesNotContain("缺陷提交", prompt);
        Assert.DoesNotContain("AI 调用", prompt);
        Assert.Contains("只基于实际存在的数据", prompt);
        Assert.DoesNotContain("即使数据较少", prompt);
    }

    [Fact]
    public void BuildUserPromptV2_OnlyDocumentEditCount_ShouldUseNewLabel()
    {
        var activity = new CollectedActivity
        {
            UserId = "user-doc",
            DocumentEditCount = 2,
            Commits = new List<ReportCommit>(),
            DailyLogs = new List<ReportDailyLog>()
        };

        var prompt = ReportGenerationService.BuildUserPromptV2(
            CreateSimpleTemplate(),
            teamStats: null,
            personalStats: new List<SourceStats>(),
            activity: activity,
            weekYear: 2026,
            weekNumber: 15,
            effectivePrompt: "写作要求");

        Assert.Contains("### 系统活动统计", prompt);
        Assert.Contains("创建 PRD 项目: 2 个", prompt);
        // 旧标签必须被移除
        Assert.DoesNotContain("文档编辑/创建", prompt);
    }

    [Fact]
    public void BuildUserPrompt_MapDisabled_ShouldNotIncludeAnyMapSection()
    {
        var activity = new CollectedActivity
        {
            UserId = "user-y",
            PrdSessions = 100,
            DefectsSubmitted = 50,
            Commits = new List<ReportCommit>
            {
                new() { Message = "some commit", CommittedAt = DateTime.UtcNow }
            },
            DailyLogs = new List<ReportDailyLog>()
        };

        var disabledPrefs = new ReportGenerationService.GenerationSourcePrefs(
            DailyLogEnabled: true, MapPlatformEnabled: false);

        var prompt = ReportGenerationService.BuildUserPrompt(
            CreateSimpleTemplate(), activity, 2026, 15, disabledPrefs, "写作要求");

        // MAP 完全关闭时，整个 MAP 章节都不应该出现
        Assert.DoesNotContain("MAP 平台工作记录", prompt);
        Assert.DoesNotContain("PRD 对话会话", prompt);
        Assert.DoesNotContain("some commit", prompt);
    }
}
