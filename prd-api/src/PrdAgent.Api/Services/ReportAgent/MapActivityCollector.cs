using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// MAP 系统内活动采集器 — 按需查询现有集合获取用户一周活动
/// Phase 0 (v3.0): 从 6 个数据流扩展到 14 个，确保零配置也有内容
/// </summary>
public class MapActivityCollector
{
    private readonly MongoDbContext _db;

    public MapActivityCollector(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 采集指定用户在指定时间段内的活动数据
    /// </summary>
    public async Task<CollectedActivity> CollectAsync(
        string userId, DateTime periodStart, DateTime periodEnd, CancellationToken ct)
    {
        var result = new CollectedActivity
        {
            UserId = userId,
            PeriodStart = periodStart,
            PeriodEnd = periodEnd
        };

        // 并行执行多个查询
        var tasks = new List<Task>();

        // 1. PRD Agent：本周参与的对话会话数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.Sessions.Find(
                    s => s.OwnerUserId == userId && s.CreatedAt >= periodStart && s.CreatedAt <= periodEnd
                ).CountDocumentsAsync(ct);
                result.PrdSessions = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 2. 缺陷 Agent：本周提交的缺陷数 + 详情统计
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var defects = await _db.DefectReports.Find(
                    d => d.ReporterId == userId && d.CreatedAt >= periodStart && d.CreatedAt <= periodEnd
                ).ToListAsync(ct);
                result.DefectsSubmitted = defects.Count;

                // 增强：缺陷详情统计
                var resolved = defects.Where(d => d.ResolvedAt.HasValue).ToList();
                var reopened = defects.Count(d => d.Status == "rejected");
                var avgHours = resolved.Count > 0
                    ? resolved.Average(d => (d.ResolvedAt!.Value - d.CreatedAt).TotalHours)
                    : 0;
                result.DefectDetails = new DefectStats
                {
                    Submitted = defects.Count,
                    Resolved = resolved.Count,
                    Reopened = reopened,
                    AvgResolutionHours = Math.Round(avgHours, 1)
                };
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 3. 视觉创作：本周创作会话数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.ImageMasterSessions.Find(
                    s => s.OwnerUserId == userId && s.CreatedAt >= periodStart && s.CreatedAt <= periodEnd
                ).CountDocumentsAsync(ct);
                result.VisualSessions = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 4. LLM 调用次数
        // 重要：必须排除 report-agent.* 的 AppCallerCode，否则出现自噬循环：
        //   报告生成过程本身调用 LLM Gateway 时会将 Context.UserId 写成「被报告用户」
        //   → 下次生成时这些日志被计入「用户行为」→ AI 根据虚假计数编造出
        //   「本周调用 AI 辅助功能 N 次」这样的伪工作记录。
        // 同时排除 TeamSummary 的调用（同样是系统代用户调用，不是用户亲自发起）。
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.LlmRequestLogs.Find(
                    l => l.UserId == userId
                         && l.StartedAt >= periodStart
                         && l.StartedAt <= periodEnd
                         && (l.AppCallerCode == null
                             || (!l.AppCallerCode.StartsWith("report-agent.")))
                ).CountDocumentsAsync(ct);
                result.LlmCalls = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 5. 每日打点
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var startDate = periodStart.Date;
                var endDate = periodEnd.Date;
                var logs = await _db.ReportDailyLogs.Find(
                    dl => dl.UserId == userId && dl.Date >= startDate && dl.Date <= endDate
                ).SortBy(dl => dl.Date).ToListAsync(ct);
                result.DailyLogs = logs;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 6. Git 提交记录
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var commits = await _db.ReportCommits.Find(
                    c => c.MappedUserId == userId && c.CommittedAt >= periodStart && c.CommittedAt <= periodEnd
                ).SortByDescending(c => c.CommittedAt).Limit(100).ToListAsync(ct);
                result.Commits = commits;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // ====== Phase 0 新增数据流 ======

        // 7. PRD 消息量（对话深度）
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.Messages.Find(
                    m => m.SenderId == userId && m.Timestamp >= periodStart && m.Timestamp <= periodEnd
                        && !m.IsDeleted
                ).CountDocumentsAsync(ct);
                result.PrdMessageCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 8. 图片生成完成数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.ImageGenRuns.Find(
                    r => r.OwnerAdminId == userId && r.CreatedAt >= periodStart && r.CreatedAt <= periodEnd
                        && r.Status == ImageGenRunStatus.Completed
                ).CountDocumentsAsync(ct);
                result.ImageGenCompletedCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 9. 视频生成完成数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.VideoGenRuns.Find(
                    r => r.OwnerAdminId == userId && r.CreatedAt >= periodStart && r.CreatedAt <= periodEnd
                        && r.Status == "Completed"
                ).CountDocumentsAsync(ct);
                result.VideoGenCompletedCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 10. PRD 项目创建（用户创建的 Group 数量，每个 Group 对应一个 PRD 文档）
        // 注意：ParsedPrd 模型没有 UserId 字段，文档归属必须通过 Group.OwnerId 关联
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.Groups.Find(
                    g => g.OwnerId == userId && g.CreatedAt >= periodStart && g.CreatedAt <= periodEnd
                ).CountDocumentsAsync(ct);
                result.DocumentEditCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 11. 工作流执行完成数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.WorkflowExecutions.Find(
                    w => w.TriggeredBy == userId && w.CreatedAt >= periodStart && w.CreatedAt <= periodEnd
                        && w.Status == "completed"
                ).CountDocumentsAsync(ct);
                result.WorkflowExecutionCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 12. 工具箱使用次数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.ToolboxRuns.Find(
                    t => t.UserId == userId && t.CreatedAt >= periodStart && t.CreatedAt <= periodEnd
                ).CountDocumentsAsync(ct);
                result.ToolboxRunCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 13. 网页发布/更新
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.HostedSites.Find(
                    h => h.OwnerUserId == userId && h.UpdatedAt >= periodStart && h.UpdatedAt <= periodEnd
                ).CountDocumentsAsync(ct);
                result.WebPagePublishCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        // 14. 附件上传数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.Attachments.Find(
                    a => a.UploaderId == userId && a.UploadedAt >= periodStart && a.UploadedAt <= periodEnd
                ).CountDocumentsAsync(ct);
                result.AttachmentUploadCount = (int)count;
            }
            catch { /* 集合可能不存在 */ }
        }, ct));

        await Task.WhenAll(tasks);
        return result;
    }

    /// <summary>
    /// 判定一条 LlmRequestLog 是否应计入「用户 AI 调用」统计。
    /// 抽取为可测试的静态方法，与 CollectAsync 中的 Find 表达式保持同一语义。
    /// 规则：
    /// - AppCallerCode 为空 → 计入（兼容历史日志）
    /// - 以 "report-agent." 开头 → 不计入（报告生成自身的调用会被写到被报告用户名下，属于系统代调用）
    /// - 其他 → 计入
    /// </summary>
    internal static bool ShouldCountLlmLog(string? appCallerCode)
    {
        if (string.IsNullOrEmpty(appCallerCode)) return true;
        if (appCallerCode.StartsWith("report-agent.", StringComparison.Ordinal)) return false;
        return true;
    }
}

/// <summary>
/// 采集到的活动数据（v3.0 增强版：14 个数据流）
/// </summary>
public class CollectedActivity
{
    public string UserId { get; set; } = string.Empty;
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }

    // ====== 原有数据流 ======

    /// <summary>PRD 对话会话数</summary>
    public int PrdSessions { get; set; }

    /// <summary>提交的缺陷数</summary>
    public int DefectsSubmitted { get; set; }

    /// <summary>视觉创作会话数</summary>
    public int VisualSessions { get; set; }

    /// <summary>LLM 调用次数</summary>
    public int LlmCalls { get; set; }

    /// <summary>每日打点记录</summary>
    public List<ReportDailyLog> DailyLogs { get; set; } = new();

    /// <summary>Git 提交记录</summary>
    public List<ReportCommit> Commits { get; set; } = new();

    // ====== Phase 0 新增数据流 ======

    /// <summary>PRD 对话消息数（对话深度）</summary>
    public int PrdMessageCount { get; set; }

    /// <summary>图片生成完成数</summary>
    public int ImageGenCompletedCount { get; set; }

    /// <summary>视频生成完成数</summary>
    public int VideoGenCompletedCount { get; set; }

    /// <summary>文档编辑/创建数</summary>
    public int DocumentEditCount { get; set; }

    /// <summary>工作流执行完成数</summary>
    public int WorkflowExecutionCount { get; set; }

    /// <summary>工具箱使用次数</summary>
    public int ToolboxRunCount { get; set; }

    /// <summary>网页发布/更新数</summary>
    public int WebPagePublishCount { get; set; }

    /// <summary>附件上传数</summary>
    public int AttachmentUploadCount { get; set; }

    /// <summary>缺陷详情统计（提交/解决/重开/平均解决时间）</summary>
    public DefectStats? DefectDetails { get; set; }
}

/// <summary>
/// 缺陷处理详情统计
/// </summary>
public class DefectStats
{
    /// <summary>提交数</summary>
    public int Submitted { get; set; }

    /// <summary>已解决数</summary>
    public int Resolved { get; set; }

    /// <summary>被退回/重开数</summary>
    public int Reopened { get; set; }

    /// <summary>平均解决时间（小时）</summary>
    public double AvgResolutionHours { get; set; }
}
