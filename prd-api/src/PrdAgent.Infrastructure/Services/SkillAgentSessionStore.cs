using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// SkillAgentSession MongoDB 持久化仓储实现。
/// - upsert 语义：ReplaceOneAsync + IsUpsert
/// - 用户隔离：所有操作均以 (Id, UserId) 双键过滤
/// - 失败安全：SaveAsync 内部吞下异常（转日志），不让 DB 写失败打断 SSE 流
/// </summary>
public class SkillAgentSessionStore : ISkillAgentSessionStore
{
    private readonly MongoDbContext _db;
    private readonly ILogger<SkillAgentSessionStore> _logger;

    public SkillAgentSessionStore(MongoDbContext db, ILogger<SkillAgentSessionStore> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<SkillAgentSession?> LoadAsync(string sessionId, string userId, CancellationToken ct = default)
    {
        try
        {
            var filter = Builders<SkillAgentSession>.Filter.And(
                Builders<SkillAgentSession>.Filter.Eq(x => x.Id, sessionId),
                Builders<SkillAgentSession>.Filter.Eq(x => x.UserId, userId)
            );
            return await _db.SkillAgentSessions.Find(filter).FirstOrDefaultAsync(ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[skill-agent-session-store] Load failed: {SessionId} by {UserId}", sessionId, userId);
            return null;
        }
    }

    public async Task SaveAsync(SkillAgentSession session, CancellationToken ct = default)
    {
        try
        {
            var filter = Builders<SkillAgentSession>.Filter.And(
                Builders<SkillAgentSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<SkillAgentSession>.Filter.Eq(x => x.UserId, session.UserId)
            );
            await _db.SkillAgentSessions.ReplaceOneAsync(
                filter, session,
                new ReplaceOptions { IsUpsert = true },
                ct);
        }
        catch (Exception ex)
        {
            // 持久化失败不抛：SSE 流 + 内存缓存仍可继续服务，下次写入会重试
            _logger.LogError(ex, "[skill-agent-session-store] Save failed: {SessionId} by {UserId}", session.Id, session.UserId);
        }
    }

    public async Task DeleteAsync(string sessionId, string userId, CancellationToken ct = default)
    {
        try
        {
            var filter = Builders<SkillAgentSession>.Filter.And(
                Builders<SkillAgentSession>.Filter.Eq(x => x.Id, sessionId),
                Builders<SkillAgentSession>.Filter.Eq(x => x.UserId, userId)
            );
            await _db.SkillAgentSessions.DeleteOneAsync(filter, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[skill-agent-session-store] Delete failed: {SessionId} by {UserId}", sessionId, userId);
        }
    }

    public async Task<IReadOnlyList<SkillAgentSession>> ListDraftsAsync(
        string userId,
        int limit = 20,
        CancellationToken ct = default)
    {
        try
        {
            // "草稿" = 未保存过的会话：SavedSkillKey 为 null 或空字符串
            // 靠 `UserId + LastActiveAt` 复合索引支撑（见 doc/guide.mongodb-indexes.md）
            var filter = Builders<SkillAgentSession>.Filter.And(
                Builders<SkillAgentSession>.Filter.Eq(x => x.UserId, userId),
                Builders<SkillAgentSession>.Filter.Or(
                    Builders<SkillAgentSession>.Filter.Eq(x => x.SavedSkillKey, null),
                    Builders<SkillAgentSession>.Filter.Eq(x => x.SavedSkillKey, string.Empty)
                )
            );
            return await _db.SkillAgentSessions
                .Find(filter)
                .SortByDescending(x => x.LastActiveAt)
                .Limit(Math.Clamp(limit, 1, 100))
                .ToListAsync(ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[skill-agent-session-store] ListDrafts failed: {UserId}", userId);
            return Array.Empty<SkillAgentSession>();
        }
    }
}
