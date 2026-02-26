using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// MAP 系统内活动采集器 — 按需查询现有集合获取用户一周活动
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

        // 2. 缺陷 Agent：本周提交的缺陷数
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.DefectReports.Find(
                    d => d.ReporterId == userId && d.CreatedAt >= periodStart && d.CreatedAt <= periodEnd
                ).CountDocumentsAsync(ct);
                result.DefectsSubmitted = (int)count;
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
        tasks.Add(Task.Run(async () =>
        {
            try
            {
                var count = await _db.LlmRequestLogs.Find(
                    l => l.UserId == userId && l.StartedAt >= periodStart && l.StartedAt <= periodEnd
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

        await Task.WhenAll(tasks);
        return result;
    }
}

/// <summary>
/// 采集到的活动数据
/// </summary>
public class CollectedActivity
{
    public string UserId { get; set; } = string.Empty;
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }

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
}
