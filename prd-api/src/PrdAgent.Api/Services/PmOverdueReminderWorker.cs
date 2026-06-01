using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 项目逾期/临近截止提醒 —— 每天（中国时区 09:00 后）扫描在管项目，
/// 按负责人聚合「逾期 + 临近截止」任务，外加项目 leader 的逾期里程碑，
/// 给每个相关用户生成一条站内汇总通知（AdminNotification）。不刷屏。
/// </summary>
public class PmOverdueReminderWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<PmOverdueReminderWorker> _logger;
    private static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(30);
    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");

    // 去重：每天只发一次汇总（key = year*1000 + dayOfYear）
    private int _lastDigestDay = -1;

    public PmOverdueReminderWorker(IServiceScopeFactory scopeFactory, ILogger<PmOverdueReminderWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("PmOverdueReminderWorker started");
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(CheckInterval, stoppingToken);
                await ScanAsync(stoppingToken);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { _logger.LogWarning(ex, "PmOverdueReminderWorker loop error"); }
        }
        _logger.LogInformation("PmOverdueReminderWorker stopped");
    }

    private async Task ScanAsync(CancellationToken ct)
    {
        var china = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, ChinaTimeZone);
        if (china.Hour < 9) return; // 每天 09:00 后才发
        var dayKey = china.Year * 1000 + china.DayOfYear;
        if (_lastDigestDay == dayKey) return;
        _lastDigestDay = dayKey;

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        var running = await db.PmProjects.Find(p => !p.IsDeleted && p.Lifecycle == PmProjectLifecycle.Running).ToListAsync(ct);
        if (running.Count == 0) return;
        var pidSet = running.Select(p => p.Id).ToHashSet();
        var pidTitle = running.ToDictionary(p => p.Id, p => p.Title);

        var now = DateTime.UtcNow;
        var soon = now.AddDays(2);

        // 任务：逾期 + 临近（未完成/未取消，有负责人与截止日）
        var tasks = await db.PmTasks.Find(t => pidSet.Contains(t.ProjectId)
            && t.AssigneeId != null && t.DueAt != null && t.DueAt < soon
            && t.Status != PmTaskStatus.Done && t.Status != PmTaskStatus.Cancelled).ToListAsync(ct);

        // 按负责人聚合
        var byUser = new Dictionary<string, (int overdue, int soon, List<string> samples)>();
        void Add(string uid, bool isOverdue, string sample)
        {
            if (!byUser.TryGetValue(uid, out var e)) e = (0, 0, new List<string>());
            if (isOverdue) e.overdue++; else e.soon++;
            if (e.samples.Count < 6) e.samples.Add(sample);
            byUser[uid] = e;
        }
        foreach (var t in tasks)
        {
            var isOverdue = t.DueAt < now;
            Add(t.AssigneeId!, isOverdue, $"{(isOverdue ? "[逾期]" : "[临近]")} {t.Title}（{pidTitle.GetValueOrDefault(t.ProjectId, "项目")}）");
        }

        // 逾期里程碑 → 通知项目 leader
        var milestones = await db.PmMilestones.Find(m => pidSet.Contains(m.ProjectId)
            && m.Status == PmMilestoneStatus.Planned && m.DueAt != null && m.DueAt < now).ToListAsync(ct);
        foreach (var m in milestones)
        {
            var leaderId = running.First(p => p.Id == m.ProjectId).LeaderId;
            if (!string.IsNullOrEmpty(leaderId))
                Add(leaderId, true, $"[里程碑逾期] {m.Title}（{pidTitle.GetValueOrDefault(m.ProjectId, "项目")}）");
        }

        var notifications = new List<AdminNotification>();
        foreach (var kv in byUser)
        {
            var (overdue, soonN, samples) = kv.Value;
            if (overdue + soonN == 0) continue;
            var parts = new List<string>();
            if (overdue > 0) parts.Add($"{overdue} 项逾期");
            if (soonN > 0) parts.Add($"{soonN} 项临近截止");
            notifications.Add(new AdminNotification
            {
                TargetUserId = kv.Key,
                Title = $"项目待办提醒：{string.Join("、", parts)}",
                Message = string.Join("\n", samples),
                Level = overdue > 0 ? "warning" : "info",
                Source = "pm-reminder",
                ActionLabel = "查看项目管理",
                ActionUrl = "/pm",
                ActionKind = "route",
                ExpiresAt = DateTime.UtcNow.AddDays(3),
            });
        }
        if (notifications.Count > 0)
        {
            await db.AdminNotifications.InsertManyAsync(notifications, cancellationToken: ct);
            _logger.LogInformation("PmOverdueReminderWorker sent {Count} digest notifications", notifications.Count);
        }
    }
}
