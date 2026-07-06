using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 「最近打开」打点：用户打开工作区/工作流详情时记一笔每用户台账。
/// best-effort——打点失败绝不影响业务端点本身。
/// </summary>
public static class RecentOpenTracker
{
    public static async Task TouchAsync(MongoDbContext db, string userId, string agentKey, string entityId)
    {
        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(entityId)) return;
        try
        {
            var filter = Builders<UserRecentOpen>.Filter.Where(
                x => x.UserId == userId && x.AgentKey == agentKey && x.EntityId == entityId);
            var update = Builders<UserRecentOpen>.Update
                .Set(x => x.LastOpenedAt, DateTime.UtcNow)
                .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"));
            // CancellationToken.None：打点不随请求中断（server-authority）
            await db.UserRecentOpens.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = true }, CancellationToken.None);
        }
        catch
        {
            // 打点失败静默：台账缺一条只影响「继续上次」排序，不值得影响业务
        }
    }
}
