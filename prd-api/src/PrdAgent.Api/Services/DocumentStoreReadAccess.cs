using MongoDB.Driver;
using PrdAgent.Core.Security;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>阅读器与语义检索共用的实时可读判据，不缓存 ACL。</summary>
public sealed class DocumentStoreReadAccess(MongoDbContext db, ITeamService teams, IAdminPermissionService permissions)
{
    public async Task<bool> CanReadAsync(DocumentStore store, string userId)
    {
        var teamIds = await teams.GetMyTeamIdsAsync(userId);
        if (HasDirectAccess(store, userId, teamIds)) return true;
        // root 身份使用现有平台常量，避免后台任务依赖 HTTP claims。
        var effective = await permissions.GetEffectivePermissionsAsync(userId, userId == AdminPermissionCatalog.RootUserId);
        return await CanReadAsync(db, store, userId, teamIds, effective);
    }

    public static bool HasDirectAccess(DocumentStore store, string userId, IReadOnlyCollection<string> teamIds)
        => store.OwnerId == userId || store.IsPublic || (store.SharedTeamIds?.Any(teamIds.Contains) ?? false);

    public static async Task<bool> CanReadAsync(MongoDbContext db, DocumentStore s, string userId,
        IReadOnlyCollection<string> teamIds, IReadOnlyCollection<string> effective)
    {
        if (HasDirectAccess(s, userId, teamIds)) return true;
        if (!string.IsNullOrEmpty(s.ShituCategoryRef) &&
            (effective.Contains(AdminPermissionCatalog.Super) || effective.Contains(AdminPermissionCatalog.ShituAgentUse)
             || effective.Contains(AdminPermissionCatalog.ShituAgentManage))) return true;
        if (!string.IsNullOrEmpty(s.ProductKnowledgeRef))
        {
            if (effective.Contains(AdminPermissionCatalog.Super) || effective.Contains(AdminPermissionCatalog.ProductAgentAdmin)
                || effective.Contains(AdminPermissionCatalog.ProductAgentManage)) return true;
            var parts = s.ProductKnowledgeRef.Split(':', 2);
            string? productId = parts.Length != 2 ? null : parts[0] switch
            {
                "product" => parts[1],
                "version" => (await db.ProductVersions.Find(x => x.Id == parts[1] && !x.IsDeleted).FirstOrDefaultAsync())?.ProductId,
                _ => null,
            };
            if (productId != null)
            {
                var p = await db.Products.Find(x => x.Id == productId && !x.IsDeleted).FirstOrDefaultAsync();
                if (p != null && (p.OwnerId == userId || p.MemberIds.Contains(userId))) return true;
            }
        }
        if (!string.IsNullOrEmpty(s.PmProjectId))
        {
            var p = await db.PmProjects.Find(x => x.Id == s.PmProjectId && !x.IsDeleted).FirstOrDefaultAsync();
            if (p != null && (p.OwnerId == userId || p.LeaderId == userId || p.MemberIds.Contains(userId)
                || p.ObserverIds.Contains(userId) || (p.Stakeholders?.Any(st => st.UserId == userId) ?? false))) return true;
        }
        return false;
    }
}
