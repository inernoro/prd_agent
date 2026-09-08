using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// Agent 开放接口 API Key 的 MongoDB 实现。
/// Key 生成：`sk-ak-{32 hex}`（前缀 `sk-ak-` 用于与现有 OpenPlatformApp 的 `sk-{32}` 做区分）。
/// </summary>
public class AgentApiKeyService : IAgentApiKeyService
{
    private const string KeyPrefix = "sk-ak-";
    private const int KeyBodyLength = 32;

    private readonly MongoDbContext _db;
    private readonly ILogger<AgentApiKeyService> _logger;

    public AgentApiKeyService(MongoDbContext db, ILogger<AgentApiKeyService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<(AgentApiKey key, string plaintext)> CreateAsync(
        string ownerUserId,
        string name,
        string? description,
        IEnumerable<string> scopes,
        int ttlDays,
        CancellationToken ct = default,
        AgentApiKeyScopeMode scopeMode = AgentApiKeyScopeMode.Manual)
    {
        var plaintext = GenerateApiKey();
        var hash = ComputeSha256(plaintext);
        var prefix = plaintext.Length > 12 ? plaintext[..12] : plaintext;

        var entity = new AgentApiKey
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = string.IsNullOrWhiteSpace(name) ? "未命名 Key" : name.Trim(),
            Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim(),
            OwnerUserId = ownerUserId,
            ApiKeyHash = hash,
            KeyPrefix = prefix,
            // 自动模式故意不存清单：它的清单是「主人此刻有什么」，每次鉴权现算。
            // 存一份快照的话，那份快照第二天就可能与真实权限对不上，而两处都能被读到 ——
            // 判据分裂的老形状，早晚有人照着过期的那份下结论。
            Scopes = scopeMode == AgentApiKeyScopeMode.Auto
                ? new List<string>()
                : scopes?.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).Distinct().ToList() ?? new List<string>(),
            ScopeMode = scopeMode,
            IsActive = true,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = ttlDays > 0 ? DateTime.UtcNow.AddDays(ttlDays) : null
        };

        await _db.AgentApiKeys.InsertOneAsync(entity, cancellationToken: ct);
        return (entity, plaintext);
    }

    public async Task<AgentApiKeyLookupResult?> LookupByPlaintextAsync(string plaintext, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(plaintext) || !plaintext.StartsWith(KeyPrefix, StringComparison.Ordinal))
            return null;

        var hash = ComputeSha256(plaintext);
        var key = await _db.AgentApiKeys.Find(k => k.ApiKeyHash == hash).FirstOrDefaultAsync(ct);
        if (key == null) return null;

        // 停用 / 撤销 / 过了宽限期 —— 判据在 AgentApiKey.IsUsableAt 一处，
        // 接入台面板读的也是它，免得面板说「已连接」而这里在拒。
        if (!AgentApiKey.IsUsableAt(key, DateTime.UtcNow, out var inGrace)) return null;

        return new AgentApiKeyLookupResult(key, inGrace);
    }

    public Task<List<AgentApiKey>> ListByOwnerAsync(string ownerUserId, CancellationToken ct = default)
    {
        return _db.AgentApiKeys
            .Find(k => k.OwnerUserId == ownerUserId)
            .SortByDescending(k => k.CreatedAt)
            .ToListAsync(ct);
    }

    public async Task<AgentApiKey?> GetByIdAsync(string id, CancellationToken ct = default)
    {
        return await _db.AgentApiKeys.Find(k => k.Id == id).FirstOrDefaultAsync(ct);
    }

    public async Task<bool> RenewAsync(string id, int ttlDays, CancellationToken ct = default)
    {
        if (ttlDays <= 0) return false;
        var key = await GetByIdAsync(id, ct);
        if (key == null) return false;

        // 基准时间：取 max(now, 原 ExpiresAt)，避免把已过期 Key 续一点点后还是过期
        var baseTime = key.ExpiresAt.HasValue && key.ExpiresAt.Value > DateTime.UtcNow
            ? key.ExpiresAt.Value
            : DateTime.UtcNow;
        var newExpiry = baseTime.AddDays(ttlDays);

        var update = Builders<AgentApiKey>.Update
            .Set(k => k.ExpiresAt, newExpiry)
            .Set(k => k.LastRenewedAt, DateTime.UtcNow);
        var result = await _db.AgentApiKeys.UpdateOneAsync(k => k.Id == id, update, cancellationToken: ct);
        return result.MatchedCount > 0;
    }

    public async Task<bool> RevokeAsync(string id, CancellationToken ct = default)
    {
        var update = Builders<AgentApiKey>.Update
            .Set(k => k.IsActive, false)
            .Set(k => k.RevokedAt, DateTime.UtcNow);
        var result = await _db.AgentApiKeys.UpdateOneAsync(k => k.Id == id, update, cancellationToken: ct);
        return result.MatchedCount > 0;
    }

    public async Task<bool> UpdateMetadataAsync(
        string id,
        string? name,
        string? description,
        IEnumerable<string>? scopes,
        bool? isActive,
        CancellationToken ct = default,
        AgentApiKeyQuotaPatch? quota = null,
        AgentApiKeyScopeMode? scopeMode = null)
    {
        var updates = new List<UpdateDefinition<AgentApiKey>>();
        if (name != null) updates.Add(Builders<AgentApiKey>.Update.Set(k => k.Name, name.Trim()));
        if (description != null)
            updates.Add(Builders<AgentApiKey>.Update.Set(k => k.Description, string.IsNullOrWhiteSpace(description) ? null : description.Trim()));

        // 切回自动 = 清单作废。留着旧清单的话，库里会同时存在两份「它能做什么」的说法，
        // 而只有现算的那份是真的 —— 判据分裂的老形状，早晚有人照着死的那份下结论。
        var switchingToAuto = scopeMode == AgentApiKeyScopeMode.Auto;
        if (switchingToAuto)
            updates.Add(Builders<AgentApiKey>.Update.Set(k => k.Scopes, new List<string>()));
        else if (scopes != null)
            updates.Add(Builders<AgentApiKey>.Update.Set(
                k => k.Scopes,
                scopes.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).Distinct().ToList()));

        // 存下一份清单 = 从此钉死。没有这一条，一把自动模式的钥匙被改过 scope 之后
        // 仍然是自动的：用户改的那份清单下一次鉴权就被现算的结果盖掉，改了等于没改。
        var resolvedMode = scopeMode ?? (scopes != null ? AgentApiKeyScopeMode.Manual : (AgentApiKeyScopeMode?)null);
        if (resolvedMode is { } mode)
            updates.Add(Builders<AgentApiKey>.Update.Set(k => k.ScopeMode, mode));
        if (isActive.HasValue)
            updates.Add(Builders<AgentApiKey>.Update.Set(k => k.IsActive, isActive.Value));

        // 配额与元数据必须落在同一次写里：分两次写时第二次失败，调用方收到的是「更新失败」，
        // 而名字/scope 已经改了 —— 用户照报错重试，状态和提示对不上。
        if (quota is { IsEmpty: false })
        {
            if (quota.DailyImageQuota is { } img)
                updates.Add(Builders<AgentApiKey>.Update.Set(k => k.McpDailyImageQuota, img));
            if (quota.DailyWriteQuota is { } wr)
                updates.Add(Builders<AgentApiKey>.Update.Set(k => k.McpDailyWriteQuota, wr));
            if (quota.RateLimitPerMin is { } rate)
                updates.Add(Builders<AgentApiKey>.Update.Set(k => k.McpRateLimitPerMin, rate));
        }

        if (updates.Count == 0) return true;

        var combined = Builders<AgentApiKey>.Update.Combine(updates);
        var result = await _db.AgentApiKeys.UpdateOneAsync(k => k.Id == id, combined, cancellationToken: ct);
        return result.MatchedCount > 0;
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        var result = await _db.AgentApiKeys.DeleteOneAsync(k => k.Id == id, ct);
        return result.DeletedCount > 0;
    }

    public async Task TouchUsageAsync(string id, CancellationToken ct = default)
    {
        try
        {
            var update = Builders<AgentApiKey>.Update
                .Set(k => k.LastUsedAt, DateTime.UtcNow)
                .Inc(k => k.TotalRequests, 1);
            await _db.AgentApiKeys.UpdateOneAsync(k => k.Id == id, update, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            // 记录失败不应阻塞正常请求
            _logger.LogWarning(ex, "AgentApiKey TouchUsage failed id={Id}", id);
        }
    }

    private static string GenerateApiKey()
    {
        // sk-ak-{32 hex} — 38 字符
        // 用 RandomNumberGenerator (CSPRNG)，不要用 Guid.NewGuid()
        // —— 后者是 UUIDv4，规范上不保证密码学随机性。
        // 32 hex char = 16 bytes = 128 bit 熵，足以抗暴力枚举。
        var randomBytes = RandomNumberGenerator.GetBytes(KeyBodyLength / 2);
        var body = Convert.ToHexString(randomBytes).ToLowerInvariant();
        return $"{KeyPrefix}{body}";
    }

    private static string ComputeSha256(string input)
    {
        using var sha256 = SHA256.Create();
        var bytes = Encoding.UTF8.GetBytes(input);
        var hash = sha256.ComputeHash(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
