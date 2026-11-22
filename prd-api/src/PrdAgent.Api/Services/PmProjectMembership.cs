using MongoDB.Driver;
using System.Linq.Expressions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>项目写入时的授权及成员一致性约束；读取范围仍由控制器维护。</summary>
public static class PmProjectMembership
{
    public static bool CanManage(PmProject project, string userId) =>
        project.OwnerId == userId || project.LeaderId == userId;

    // 在实际写入时复核身份和软删除状态，不能只相信先前读取的快照。
    public static FilterDefinition<PmProject> WriteFilter(string projectId, string userId) =>
        Builders<PmProject>.Filter.Where(p => p.Id == projectId && !p.IsDeleted &&
            (p.OwnerId == userId || p.LeaderId == userId));

    // 成员与观察者是一组互斥状态。并发修改任一名单时拒绝过期快照，调用者重新读取后重试。
    public static FilterDefinition<PmProject> SnapshotFilter(PmProject project, string userId) =>
        WriteFilter(project.Id, userId) &
        Builders<PmProject>.Filter.Eq(p => p.LeaderId, project.LeaderId) &
        ListSnapshot(p => p.MemberIds, project.MemberIds) &
        ListSnapshot(p => p.ObserverIds, project.ObserverIds);

    private static FilterDefinition<PmProject> ListSnapshot(Expression<Func<PmProject, List<string>>> field, List<string> ids)
    {
        var b = Builders<PmProject>.Filter;
        var exact = b.Eq(field, ids);
        // 旧项目可能尚未存储空名单；模型读出来的默认值仍是空列表。
        var untyped = Expression.Lambda<Func<PmProject, object>>(Expression.Convert(field.Body, typeof(object)), field.Parameters);
        return ids.Count == 0 ? exact | b.Exists(untyped, false) : exact;
    }

    public static async Task<List<string>> ValidUsersAsync(MongoDbContext db, IEnumerable<string> requested)
    {
        var ids = requested.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        var valid = await db.Users.Find(u => ids.Contains(u.UserId)).Project(u => u.UserId).ToListAsync();
        return ids.Where(valid.Contains).ToList();
    }

    public static async Task<(List<string> Members, List<string> Observers)> MembersAsync(
        MongoDbContext db, PmProject project, IEnumerable<string> requested)
    {
        var members = await ValidUsersAsync(db, requested.Append(project.LeaderId));
        var observers = project.ObserverIds.Where(x => !members.Contains(x)).Distinct().ToList();
        return (members, observers);
    }
}
