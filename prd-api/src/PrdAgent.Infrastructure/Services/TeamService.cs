using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>团队成员关系解析服务实现（纯 DB 查询，无内容逻辑）</summary>
public class TeamService : ITeamService
{
    private readonly MongoDbContext _db;

    public TeamService(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<List<string>> GetMyTeamIdsAsync(string userId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userId)) return new List<string>();
        return await _db.TeamMembers
            .Find(m => m.UserId == userId)
            .Project(m => m.TeamId)
            .ToListAsync(ct);
    }

    public async Task<bool> IsMemberAsync(string teamId, string userId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(teamId) || string.IsNullOrWhiteSpace(userId)) return false;
        return await _db.TeamMembers
            .Find(m => m.TeamId == teamId && m.UserId == userId)
            .AnyAsync(ct);
    }

    public async Task<bool> IsAdminAsync(string teamId, string userId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(teamId) || string.IsNullOrWhiteSpace(userId)) return false;
        return await _db.TeamMembers
            .Find(m => m.TeamId == teamId && m.UserId == userId && m.Role == TeamRole.Admin)
            .AnyAsync(ct);
    }

    public async Task<Dictionary<string, string>> GetMyWebHostingTeamRolesAsync(string userId, CancellationToken ct = default)
    {
        var map = new Dictionary<string, string>();
        if (string.IsNullOrWhiteSpace(userId)) return map;

        var memberships = await _db.TeamMembers
            .Find(m => m.UserId == userId)
            .Project(m => new { m.TeamId, m.Role, m.WebHostingRole })
            .ToListAsync(ct);

        foreach (var m in memberships)
        {
            if (string.IsNullOrWhiteSpace(m.TeamId)) continue;
            // 同一团队仅一条成员记录；如有重复，取最宽松角色兜底
            var resolved = WebHostingRoles.Resolve(m.WebHostingRole, m.Role);
            map[m.TeamId] = map.TryGetValue(m.TeamId, out var existing)
                ? (WebHostingPermission.Max(existing, resolved) ?? resolved)
                : resolved;
        }

        return map;
    }
}
