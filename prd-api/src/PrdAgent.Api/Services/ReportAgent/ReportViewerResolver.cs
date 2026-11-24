using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services.ReportAgent;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 把「当前用户 + 一份报告」解析成 ReportViewer，再交给 ReportAccessPolicy 判定。
/// 周报互动与月报的所有入口共用这一处，团队角色查询只写一遍。
/// </summary>
public sealed class ReportViewerResolver
{
    private readonly MongoDbContext _db;

    public ReportViewerResolver(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<string?> GetTeamRoleAsync(string teamId, string userId)
    {
        var member = await _db.ReportTeamMembers
            .Find(m => m.TeamId == teamId && m.UserId == userId)
            .FirstOrDefaultAsync();
        return member?.Role;
    }

    public async Task<ReportViewer> ResolveAsync(string teamId, string ownerUserId, string userId, bool hasViewAll)
    {
        var role = await GetTeamRoleAsync(teamId, userId);
        return new ReportViewer(ownerUserId == userId, role, hasViewAll);
    }
}
