using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Text.Json;

namespace PrdAgent.Infrastructure.Services.Authorization;

public class ExternalAuthorizationService : IExternalAuthorizationService
{
    private readonly MongoDbContext _db;
    private readonly IEnumerable<IAuthTypeHandler> _handlers;
    private readonly IConfiguration _configuration;
    private readonly ILogger<ExternalAuthorizationService> _logger;

    public ExternalAuthorizationService(
        MongoDbContext db,
        IEnumerable<IAuthTypeHandler> handlers,
        IConfiguration configuration,
        ILogger<ExternalAuthorizationService> logger)
    {
        _db = db;
        _handlers = handlers;
        _configuration = configuration;
        _logger = logger;
    }

    private string EncryptionKey =>
        _configuration["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret 未配置，无法加密凭证");

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
            var validation = await handler.ValidateAsync(credentials, ct);

            updates.Add(Builders<ExternalAuthorization>.Update.Set(a => a.CredentialsEncrypted, EncryptCredentials(credentials)));
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
        return ApiKeyCrypto.Encrypt(json, EncryptionKey);
    }

    private Dictionary<string, string> DecryptCredentials(string encrypted)
    {
        if (string.IsNullOrEmpty(encrypted)) return new();
        var json = ApiKeyCrypto.Decrypt(encrypted, EncryptionKey);
        return JsonSerializer.Deserialize<Dictionary<string, string>>(json) ?? new();
    }
}
