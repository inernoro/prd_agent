using PrdAgent.Api.Services.ReportAgent;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// MapActivityCollector 单元测试：验证「AI 调用统计」必须排除报告生成自身的系统代调用。
/// 背景：ReportGenerationService 调用 LLM Gateway 时会把 Context.UserId 设成「被报告用户」，
/// 这些日志以 AppCallerCode "report-agent.generate::chat" 写入 llmrequestlogs 集合。
/// 如果 CollectAsync 不排除它们，下一次生成就会把这些系统调用当作用户行为喂给 AI，
/// 造成「余瑞鹏 本周调用 AI 辅助功能 20 次」这样凭空出现的伪工作记录。
/// </summary>
public class MapActivityCollectorTests
{
    #region ShouldCountLlmLog — 自噬循环修复核心

    [Fact]
    public void ShouldCountLlmLog_ReportAgentGenerate_ShouldReturnFalse()
    {
        // report-agent.generate::chat 是报告生成自身的调用，不能计入
        Assert.False(MapActivityCollector.ShouldCountLlmLog("report-agent.generate::chat"));
    }

    [Fact]
    public void ShouldCountLlmLog_ReportAgentAggregate_ShouldReturnFalse()
    {
        // report-agent.aggregate::chat 是团队汇总调用，不能计入
        Assert.False(MapActivityCollector.ShouldCountLlmLog("report-agent.aggregate::chat"));
    }

    [Fact]
    public void ShouldCountLlmLog_AnyReportAgentPrefix_ShouldReturnFalse()
    {
        // 任意 report-agent.* 前缀都应排除，防止未来新增的 report-agent 代用户调用再次污染
        Assert.False(MapActivityCollector.ShouldCountLlmLog("report-agent.anything::chat"));
        Assert.False(MapActivityCollector.ShouldCountLlmLog("report-agent.future.code::chat"));
    }

    [Fact]
    public void ShouldCountLlmLog_UserChat_ShouldReturnTrue()
    {
        // 用户在 PRD Agent 中发起的对话调用，应计入
        Assert.True(MapActivityCollector.ShouldCountLlmLog("prd-agent-desktop.chat.sendmessage::chat"));
    }

    [Fact]
    public void ShouldCountLlmLog_VisualAgent_ShouldReturnTrue()
    {
        // 用户在视觉创作中发起的调用，应计入
        Assert.True(MapActivityCollector.ShouldCountLlmLog("visual-agent.image.vision::generation"));
    }

    [Fact]
    public void ShouldCountLlmLog_NullOrEmpty_ShouldReturnTrue()
    {
        // 历史日志可能没有 AppCallerCode，默认计入以保持兼容
        Assert.True(MapActivityCollector.ShouldCountLlmLog(null));
        Assert.True(MapActivityCollector.ShouldCountLlmLog(""));
    }

    [Fact]
    public void ShouldCountLlmLog_CaseSensitive_ShouldNotMatchUppercase()
    {
        // StringComparison.Ordinal，保证不会被大小写误伤正常调用
        // "REPORT-AGENT." 这样的变体（理论上不存在）不应命中排除规则
        Assert.True(MapActivityCollector.ShouldCountLlmLog("REPORT-AGENT.something"));
    }

    [Fact]
    public void ShouldCountLlmLog_SimilarPrefix_ShouldNotMatch()
    {
        // "report-agent-fake" 不是我们要排除的前缀，不应被误伤
        Assert.True(MapActivityCollector.ShouldCountLlmLog("report-agent-fake.caller::chat"));
    }

    #endregion

    #region 自噬循环端到端模拟（纯 LINQ 过滤）

    [Fact]
    public void LlmCallFilter_MixedLogs_ShouldOnlyCountUserInitiated()
    {
        // 模拟「余瑞鹏」某周的 LlmRequestLogs：
        // - 3 条 report-agent.generate: 自动周报生成自噬（不应计入）
        // - 1 条 report-agent.aggregate: 团队汇总自噬（不应计入）
        // - 0 条用户主动调用
        var logs = new List<string?>
        {
            "report-agent.generate::chat",
            "report-agent.generate::chat",
            "report-agent.generate::chat",
            "report-agent.aggregate::chat"
        };

        var count = logs.Count(MapActivityCollector.ShouldCountLlmLog);
        Assert.Equal(0, count); // 修复后：真实用户行为为 0
    }

    [Fact]
    public void LlmCallFilter_OnlyUserActions_ShouldCountAll()
    {
        var logs = new List<string?>
        {
            "prd-agent-desktop.chat.sendmessage::chat",
            "visual-agent.image.vision::generation",
            "defect-agent.analyze::chat"
        };

        var count = logs.Count(MapActivityCollector.ShouldCountLlmLog);
        Assert.Equal(3, count);
    }

    [Fact]
    public void LlmCallFilter_MixedUserAndSystem_ShouldCountOnlyUser()
    {
        var logs = new List<string?>
        {
            "report-agent.generate::chat",       // 自噬：排除
            "prd-agent-desktop.chat::chat",      // 用户：计入
            "report-agent.aggregate::chat",      // 自噬：排除
            "visual-agent.image::generation",    // 用户：计入
            null,                                 // 历史数据：计入
            ""                                    // 异常数据：计入
        };

        var count = logs.Count(MapActivityCollector.ShouldCountLlmLog);
        Assert.Equal(4, count);
    }

    #endregion
}
