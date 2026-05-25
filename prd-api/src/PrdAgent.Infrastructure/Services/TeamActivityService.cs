using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>团队活动日志服务实现 —— 写入永不抛出，绝不打断主业务</summary>
public class TeamActivityService : ITeamActivityService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<TeamActivityService> _logger;

    public TeamActivityService(MongoDbContext db, ILogger<TeamActivityService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task LogAsync(
        string teamId, string appKey, string actorUserId,
        string action, string targetType, string? targetId, string? targetTitle,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(teamId)) return;
        await LogForTeamsAsync(new[] { teamId }, appKey, actorUserId, action, targetType, targetId, targetTitle, ct);
    }

    public async Task LogForTeamsAsync(
        IEnumerable<string> teamIds, string appKey, string actorUserId,
        string action, string targetType, string? targetId, string? targetTitle,
        CancellationToken ct = default)
    {
        var ids = teamIds?.Where(t => !string.IsNullOrWhiteSpace(t)).Distinct().ToList() ?? new List<string>();
        if (ids.Count == 0) return;

        try
        {
            // actor 快照只解析一次
            var actor = await _db.Users.Find(u => u.UserId == actorUserId).FirstOrDefaultAsync(ct);
            var actorName = actor != null && !string.IsNullOrWhiteSpace(actor.DisplayName)
                ? actor.DisplayName
                : (actor?.Username ?? "未知用户");
            var avatar = actor?.AvatarFileName;

            var now = DateTime.UtcNow;
            var logs = ids.Select(teamId => new TeamActivityLog
            {
                TeamId = teamId,
                AppKey = appKey,
                ActorUserId = actorUserId,
                ActorName = actorName,
                ActorAvatarFileName = avatar,
                Action = action,
                TargetType = targetType,
                TargetId = targetId,
                TargetTitle = targetTitle,
                CreatedAt = now,
            }).ToList();

            await _db.TeamActivityLogs.InsertManyAsync(logs, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            // 活动日志失败不影响主流程
            _logger.LogWarning(ex, "[TeamActivity] 写入团队活动日志失败 action={Action} target={TargetType}/{TargetId}",
                action, targetType, targetId);
        }
    }
}
