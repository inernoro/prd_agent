using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// MongoDB 持久化会话服务（IM 形态：会话元数据长期存在；可归档/软删除）。
/// 注意：cache 仅用于兼容迁移（读取到旧 session 时写回 Mongo），不再作为会话存在性的来源。
/// </summary>
public class MongoSessionService : ISessionService
{
    private readonly MongoDbContext _db;
    private readonly IIdGenerator _idGenerator;
    private readonly ICacheManager? _cache;

    public MongoSessionService(MongoDbContext db, IIdGenerator idGenerator, ICacheManager? cache = null)
    {
        _db = db;
        _idGenerator = idGenerator;
        _cache = cache;
    }

    public async Task<Session> CreateAsync(string documentId, string? groupId = null)
    {
        var gid = (groupId ?? string.Empty).Trim();
        var did = (documentId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(did)) throw new ArgumentException("documentId 不能为空", nameof(documentId));

        // 单群单会话：groupId 不为空则复用同一条会话线程，必要时更新 documentId
        if (!string.IsNullOrWhiteSpace(gid))
        {
            var existing = await _db.Sessions
                .Find(s => s.GroupId == gid && s.DeletedAtUtc == null)
                .FirstOrDefaultAsync();

            if (existing != null)
            {
                if (!string.Equals(existing.DocumentId, did, StringComparison.Ordinal))
                {
                    // 主 PRD 被替换：更新 DocumentId，并同步 DocumentIds（替换旧主文档，保留补充资料）
                    var oldPrimary = existing.DocumentId;
                    existing.DocumentId = did;

                    if (existing.DocumentIds.Count > 0)
                    {
                        // 移除旧主文档，插入新主文档到首位
                        existing.DocumentIds.Remove(oldPrimary);
                        existing.DocumentIds.Insert(0, did);
                    }
                    else
                    {
                        // 旧数据无 DocumentIds，直接初始化
                        existing.DocumentIds = new List<string> { did };
                    }
                }

                existing.LastActiveAt = DateTime.UtcNow;
                await UpsertAsync(existing);
                return existing;
            }
        }

        var session = new Session
        {
            SessionId = await _idGenerator.GenerateIdAsync("session"),
            DocumentId = did,
            DocumentIds = new List<string> { did },
            GroupId = string.IsNullOrWhiteSpace(gid) ? null : gid,
            CurrentRole = UserRole.PM,
            Mode = InteractionMode.QA,
            CreatedAt = DateTime.UtcNow,
            LastActiveAt = DateTime.UtcNow
        };

        try
        {
            await _db.Sessions.InsertOneAsync(session);
            return session;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey && !string.IsNullOrWhiteSpace(gid))
        {
            // 并发创建：按唯一索引回读
            var existing = await _db.Sessions
                .Find(s => s.GroupId == gid && s.DeletedAtUtc == null)
                .FirstOrDefaultAsync();
            if (existing != null) return existing;
            throw;
        }
    }

    public async Task<Session?> GetByIdAsync(string sessionId)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return null;

        var s = await _db.Sessions.Find(x => x.SessionId == sid && x.DeletedAtUtc == null).FirstOrDefaultAsync();
        if (s != null) return s;

        // 兼容迁移：旧版本 session 可能还在 cache（30min TTL），这里尽量救回来
        if (_cache != null)
        {
            var legacy = await _cache.GetAsync<Session>(CacheKeys.ForSession(sid));
            if (legacy != null)
            {
                legacy.LastActiveAt = DateTime.UtcNow;
                await UpsertAsync(legacy);
                return legacy;
            }
        }

        return null;
    }

    public async Task<Session> UpdateAsync(Session session)
    {
        session.LastActiveAt = DateTime.UtcNow;
        await UpsertAsync(session);
        return session;
    }

    public async Task<Session> SwitchRoleAsync(string sessionId, UserRole role)
    {
        var session = await GetByIdAsync(sessionId) ?? throw new KeyNotFoundException("会话不存在");
        session.CurrentRole = role;
        session.LastActiveAt = DateTime.UtcNow;
        await UpsertAsync(session);
        return session;
    }

    public async Task<Session> SwitchModeAsync(string sessionId, InteractionMode mode)
    {
        var session = await GetByIdAsync(sessionId) ?? throw new KeyNotFoundException("会话不存在");
        session.Mode = mode;
        session.LastActiveAt = DateTime.UtcNow;
        session.GuideStep = null;
        await UpsertAsync(session);
        return session;
    }

    public async Task RefreshActivityAsync(string sessionId)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return;
        await _db.Sessions.UpdateOneAsync(
            x => x.SessionId == sid && x.DeletedAtUtc == null,
            Builders<Session>.Update.Set(x => x.LastActiveAt, DateTime.UtcNow));
    }

    public async Task<Session> AddDocumentAsync(string sessionId, string documentId, string documentType = "reference")
    {
        var session = await GetByIdAsync(sessionId) ?? throw new KeyNotFoundException("会话不存在");
        var did = (documentId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(did)) throw new ArgumentException("documentId 不能为空", nameof(documentId));

        // 兼容旧数据：如果 DocumentIds 为空但 DocumentId 有值，先迁移
        if (session.DocumentIds.Count == 0 && !string.IsNullOrEmpty(session.DocumentId))
        {
            session.DocumentIds.Add(session.DocumentId);
            if (!session.DocumentMetas.Any(m => m.DocumentId == session.DocumentId))
                session.DocumentMetas.Add(new SessionDocumentMeta { DocumentId = session.DocumentId, DocumentType = "product" });
        }

        if (!session.DocumentIds.Contains(did))
        {
            session.DocumentIds.Add(did);
            session.DocumentMetas.Add(new SessionDocumentMeta { DocumentId = did, DocumentType = documentType });
        }

        session.LastActiveAt = DateTime.UtcNow;
        await UpsertAsync(session);
        return session;
    }

    public async Task<Session> RemoveDocumentAsync(string sessionId, string documentId)
    {
        var session = await GetByIdAsync(sessionId) ?? throw new KeyNotFoundException("会话不存在");
        var did = (documentId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(did)) throw new ArgumentException("documentId 不能为空", nameof(documentId));

        // 不允许移除最后一个文档
        if (session.GetAllDocumentIds().Count <= 1)
            throw new InvalidOperationException("至少保留一个文档");

        session.DocumentIds.Remove(did);
        session.DocumentMetas.RemoveAll(m => m.DocumentId == did);

        // 如果移除的是主文档，更新 DocumentId 指向新的首项
        if (string.Equals(session.DocumentId, did, StringComparison.Ordinal) && session.DocumentIds.Count > 0)
        {
            session.DocumentId = session.DocumentIds[0];
        }

        session.LastActiveAt = DateTime.UtcNow;
        await UpsertAsync(session);
        return session;
    }

    public async Task<Session> UpdateDocumentTypeAsync(string sessionId, string documentId, string documentType)
    {
        var session = await GetByIdAsync(sessionId) ?? throw new KeyNotFoundException("会话不存在");

        var meta = session.DocumentMetas.FirstOrDefault(m => m.DocumentId == documentId);
        if (meta != null)
        {
            meta.DocumentType = documentType;
        }
        else
        {
            session.DocumentMetas.Add(new SessionDocumentMeta { DocumentId = documentId, DocumentType = documentType });
        }

        session.LastActiveAt = DateTime.UtcNow;
        await UpsertAsync(session);
        return session;
    }

    public async Task DeleteAsync(string sessionId)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return;
        await _db.Sessions.UpdateOneAsync(
            x => x.SessionId == sid && x.DeletedAtUtc == null,
            Builders<Session>.Update.Set(x => x.DeletedAtUtc, DateTime.UtcNow));
    }

    public Task CleanupExpiredSessionsAsync()
    {
        // IM 形态：不再按 30min TTL 清理会话；归档/软删除由业务接口驱动。
        return Task.CompletedTask;
    }

    private async Task UpsertAsync(Session session)
    {
        if (session == null) return;
        var sid = (session.SessionId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid)) return;

        await _db.Sessions.ReplaceOneAsync(
            x => x.SessionId == sid,
            session,
            new ReplaceOptions { IsUpsert = true });
    }
}

