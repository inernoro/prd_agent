using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Text.Json;

namespace PrdAgent.Infrastructure.Services.Authorization;

public class ExternalAuthorizationService : IExternalAuthorizationService
{
    // Purpose 字符串：与 Jwt:Secret 完全隔离，即使 JWT 签名密钥泄露也不会影响凭证解密
    private const string ProtectorPurpose = "PrdAgent.ExternalAuthorization.Credentials.v1";

    private readonly MongoDbContext _db;
    private readonly IEnumerable<IAuthTypeHandler> _handlers;
    private readonly IDataProtector _protector;
    private readonly ILogger<ExternalAuthorizationService> _logger;

    public ExternalAuthorizationService(
        MongoDbContext db,
        IEnumerable<IAuthTypeHandler> handlers,
        IDataProtectionProvider dataProtectionProvider,
        ILogger<ExternalAuthorizationService> logger)
    {
        _db = db;
        _handlers = handlers;
        _protector = dataProtectionProvider.CreateProtector(ProtectorPurpose);
        _logger = logger;
    }

    private IAuthTypeHandler GetHandler(string type)
    {
        var handler = _handlers.FirstOrDefault(h => h.TypeKey == type);
        if (handler == null)
            throw new ArgumentException($"未知授权类型: {type}");
        return handler;
    }

    public async Task<List<ExternalAuthorization>> ListByUserAsync(string userId, CancellationToken ct)
    {
        return await _db.ExternalAuthorizations
            .Find(a => a.UserId == userId && a.RevokedAt == null)
            .SortByDescending(a => a.UpdatedAt)
            .ToListAsync(ct);
    }

    public async Task<ExternalAuthorization?> GetAsync(string userId, string id, CancellationToken ct)
    {
        return await _db.ExternalAuthorizations
            .Find(a => a.Id == id && a.UserId == userId && a.RevokedAt == null)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<ExternalAuthorization> CreateAsync(
        string userId,
        string type,
        string name,
        Dictionary<string, string> credentials,
        CancellationToken ct)
    {
        var handler = GetHandler(type);

        // 先验证凭证有效性
        var validation = await handler.ValidateAsync(credentials, ct);

        // 验证失败也允许保存（用户可能想先存着后面改），但状态记为 expired
        var entity = new ExternalAuthorization
        {
            UserId = userId,
            Type = type,
            Name = name,
            CredentialsEncrypted = EncryptCredentials(credentials),
            Metadata = validation.Metadata ?? new Dictionary<string, object>(),
            Status = validation.Ok ? "active" : "expired",
            LastValidatedAt = DateTime.UtcNow,
            ExpiresAt = validation.ExpiresAt,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.ExternalAuthorizations.InsertOneAsync(entity, cancellationToken: ct);
        _logger.LogInformation("Created external authorization {Id} type={Type} user={UserId} validated={Ok}",
            entity.Id, type, userId, validation.Ok);

        return entity;
    }

    public async Task<ExternalAuthorization> UpdateAsync(
        string userId,
        string id,
        string? name,
        Dictionary<string, string>? credentials,
        CancellationToken ct)
    {
        var entity = await GetAsync(userId, id, ct)
            ?? throw new KeyNotFoundException($"授权不存在: {id}");

        var updates = new List<UpdateDefinition<ExternalAuthorization>>
        {
            Builders<ExternalAuthorization>.Update.Set(a => a.UpdatedAt, DateTime.UtcNow)
        };

        if (!string.IsNullOrWhiteSpace(name))
            updates.Add(Builders<ExternalAuthorization>.Update.Set(a => a.Name, name));

        if (credentials != null && credentials.Count > 0)
        {
            var handler = GetHandler(entity.Type);

            // ⚠ 合并：前端编辑对话框允许用户只填要改的字段（其他留空保持原值）。
            // 必须把客户端发来的 partial patch 与已存储的凭证合并，
            // 否则部分更新会把未填写的字段（如 cookie）清空，授权直接失效。
            var existing = DecryptCredentials(entity.CredentialsEncrypted);
            var merged = new Dictionary<string, string>(existing);
            foreach (var kv in credentials)
            {
                // 空值视为"保持原值"，不覆盖；非空值替换
                if (!string.IsNullOrWhiteSpace(kv.Value)) merged[kv.Key] = kv.Value;
            }

            var validation = await handler.ValidateAsync(merged, ct);

            updates.Add(Builders<ExternalAuthorization>.Update.Set(a => a.CredentialsEncrypted, EncryptCredentials(merged)));
            updates.Add(Builders<ExternalAuthorization>.Update.Set(a => a.Metadata, validation.Metadata ?? new Dictionary<string, object>()));
            updates.Add(Builders<ExternalAuthorization>.Update.Set(a => a.Status, validation.Ok ? "active" : "expired"));
            updates.Add(Builders<ExternalAuthorization>.Update.Set(a => a.LastValidatedAt, DateTime.UtcNow));
            updates.Add(Builders<ExternalAuthorization>.Update.Set(a => a.ExpiresAt, validation.ExpiresAt));
        }

        await _db.ExternalAuthorizations.UpdateOneAsync(
            a => a.Id == id && a.UserId == userId,
            Builders<ExternalAuthorization>.Update.Combine(updates),
            cancellationToken: ct);

        return (await GetAsync(userId, id, ct))!;
    }

    public async Task RevokeAsync(string userId, string id, CancellationToken ct)
    {
        await _db.ExternalAuthorizations.UpdateOneAsync(
            a => a.Id == id && a.UserId == userId,
            Builders<ExternalAuthorization>.Update
                .Set(a => a.RevokedAt, DateTime.UtcNow)
                .Set(a => a.Status, "revoked")
                .Set(a => a.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation("Revoked external authorization {Id} user={UserId}", id, userId);
    }

    public async Task<AuthValidationResult> ValidateAsync(string userId, string id, CancellationToken ct)
    {
        var entity = await GetAsync(userId, id, ct);
        if (entity == null) return AuthValidationResult.Fail("授权不存在");

        var handler = GetHandler(entity.Type);
        var credentials = DecryptCredentials(entity.CredentialsEncrypted);
        var result = await handler.ValidateAsync(credentials, ct);

        await _db.ExternalAuthorizations.UpdateOneAsync(
            a => a.Id == id,
            Builders<ExternalAuthorization>.Update
                .Set(a => a.LastValidatedAt, DateTime.UtcNow)
                .Set(a => a.Status, result.Ok ? "active" : "expired")
                .Set(a => a.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return result;
    }

    public async Task<Dictionary<string, string>?> ResolveCredentialsAsync(
        string userId,
        string id,
        string consumer,
        CancellationToken ct)
    {
        var entity = await GetAsync(userId, id, ct);
        if (entity == null || entity.Status == "revoked")
        {
            _logger.LogWarning("ResolveCredentials failed: authorization {Id} not found or revoked (consumer={Consumer})", id, consumer);
            return null;
        }

        await _db.ExternalAuthorizations.UpdateOneAsync(
            a => a.Id == id,
            Builders<ExternalAuthorization>.Update.Set(a => a.LastUsedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation("Resolved credentials {Id} type={Type} consumer={Consumer}", id, entity.Type, consumer);
        return DecryptCredentials(entity.CredentialsEncrypted);
    }

    public async Task<Dictionary<string, string>?> GetMaskedCredentialsAsync(
        string userId,
        string id,
        CancellationToken ct)
    {
        var entity = await GetAsync(userId, id, ct);
        if (entity == null) return null;

        var handler = GetHandler(entity.Type);
        var credentials = DecryptCredentials(entity.CredentialsEncrypted);
        return handler.MaskCredentials(credentials);
    }

    private string EncryptCredentials(Dictionary<string, string> credentials)
    {
        var json = JsonSerializer.Serialize(credentials);
        return _protector.Protect(json);
    }

    private Dictionary<string, string> DecryptCredentials(string encrypted)
    {
        if (string.IsNullOrEmpty(encrypted)) return new();
        var json = _protector.Unprotect(encrypted);
        return JsonSerializer.Deserialize<Dictionary<string, string>>(json) ?? new();
    }
}
