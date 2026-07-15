using MongoDB.Driver;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Provisioning;

public static class ProvisioningCompensation
{
    public static async Task RollbackTenantCreationAsync(
        IMongoCollection<LlmGwUser> users,
        IMongoCollection<LlmGwTenant> tenants,
        IMongoCollection<LlmGwTeam> teams,
        IMongoCollection<LlmGwMembership> memberships,
        string userId,
        string tenantId,
        string teamId,
        string membershipId)
    {
        await memberships.DeleteOneAsync(x => x.Id == membershipId && x.TenantId == tenantId);
        await teams.DeleteOneAsync(x => x.Id == teamId && x.TenantId == tenantId);
        await tenants.DeleteOneAsync(x => x.Id == tenantId);
        await users.UpdateOneAsync(
            x => x.Id == userId,
            Builders<LlmGwUser>.Update
                .Pull(x => x.TenantIds, tenantId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
    }

    public static async Task RollbackMemberCreationAsync(
        IMongoCollection<LlmGwUser> users,
        IMongoCollection<LlmGwMembership> memberships,
        string tenantId,
        string userId,
        string? membershipId,
        bool createdUser,
        bool hadTenantDirectoryEntry)
    {
        if (!string.IsNullOrWhiteSpace(membershipId))
            await memberships.DeleteOneAsync(x => x.Id == membershipId && x.TenantId == tenantId);
        if (createdUser)
        {
            await users.DeleteOneAsync(x => x.Id == userId);
            return;
        }
        if (!hadTenantDirectoryEntry
            && await memberships.CountDocumentsAsync(x => x.TenantId == tenantId && x.UserId == userId) == 0)
        {
            await users.UpdateOneAsync(
                x => x.Id == userId,
                Builders<LlmGwUser>.Update
                    .Pull(x => x.TenantIds, tenantId)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));
        }
    }
}
