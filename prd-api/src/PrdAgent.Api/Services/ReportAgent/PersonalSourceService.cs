using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 个人数据源管理服务（v2.0）：CRUD + 连接测试 + 同步 + 统计聚合
/// </summary>
public class PersonalSourceService
{
    public const string ErrorDuplicateYuqueSource = "DUPLICATE_YUQUE_SOURCE";
    public const string ErrorInvalidYuqueUrl = "INVALID_YUQUE_URL";
    public const string ErrorYuqueTokenRequired = "YUQUE_TOKEN_REQUIRED";

    private readonly MongoDbContext _db;
    private readonly IConfiguration _configuration;
    private readonly ILogger<PersonalSourceService> _logger;

    public PersonalSourceService(MongoDbContext db, IConfiguration configuration, ILogger<PersonalSourceService> logger)
    {
        _db = db;
        _configuration = configuration;
        _logger = logger;
    }

    private string CryptoKey => _configuration["Security:ApiKeyCryptoSecret"] ?? "default-report-agent-crypto-key-32";

    public async Task<List<PersonalSource>> ListAsync(string userId, CancellationToken ct = default)
    {
        return await _db.PersonalSources
            .Find(s => s.UserId == userId)
            .SortByDescending(s => s.CreatedAt)
            .ToListAsync(ct);
    }

    public async Task<PersonalSource?> GetAsync(string id, string userId, CancellationToken ct = default)
    {
        return await _db.PersonalSources
            .Find(s => s.Id == id && s.UserId == userId)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<PersonalSource> CreateAsync(
        string userId, string sourceType, string displayName,
        PersonalSourceConfig config, string? token, CancellationToken ct = default)
    {
        var normalizedType = sourceType.Trim().ToLowerInvariant();
        var normalizedConfig = await NormalizeConfigAsync(normalizedType, config, token, ct);
        if (normalizedType == PersonalSourceType.Yuque)
            await EnsureNoDuplicateYuqueSourceAsync(userId, normalizedConfig, null, ct);

        var source = new PersonalSource
        {
            UserId = userId,
            SourceType = normalizedType,
            DisplayName = displayName,
            Config = normalizedConfig,
            EncryptedToken = string.IsNullOrEmpty(token) ? null : ApiKeyCrypto.Encrypt(token, CryptoKey),
        };

        await _db.PersonalSources.InsertOneAsync(source, cancellationToken: ct);
        _logger.LogInformation("[PersonalSource] Created {SourceType} for user {UserId}: {Id}", normalizedType, userId, source.Id);
        return source;
    }

    public async Task<bool> UpdateAsync(
        string id, string userId, string? displayName,
        PersonalSourceConfig? config, string? token, bool? enabled, CancellationToken ct = default)
    {
        var source = await GetAsync(id, userId, ct);
        if (source == null) return false;
        var sourceType = (source.SourceType ?? string.Empty).Trim().ToLowerInvariant();

        var updates = new List<UpdateDefinition<PersonalSource>>();

        if (displayName != null)
            updates.Add(Builders<PersonalSource>.Update.Set(s => s.DisplayName, displayName));
        if (token != null)
            updates.Add(Builders<PersonalSource>.Update.Set(s => s.EncryptedToken, ApiKeyCrypto.Encrypt(token, CryptoKey)));
        if (enabled.HasValue)
            updates.Add(Builders<PersonalSource>.Update.Set(s => s.Enabled, enabled.Value));

        if (config != null)
        {
            var mergedConfig = MergeConfig(source.Config, config);
            var effectiveToken = token ?? (string.IsNullOrEmpty(source.EncryptedToken)
                ? null
                : ApiKeyCrypto.Decrypt(source.EncryptedToken, CryptoKey));
            var normalizedConfig = await NormalizeConfigAsync(sourceType, mergedConfig, effectiveToken, ct);
            if (sourceType == PersonalSourceType.Yuque)
                await EnsureNoDuplicateYuqueSourceAsync(userId, normalizedConfig, id, ct);
            updates.Add(Builders<PersonalSource>.Update.Set(s => s.Config, normalizedConfig));
        }

        updates.Add(Builders<PersonalSource>.Update.Set(s => s.UpdatedAt, DateTime.UtcNow));

        if (updates.Count <= 1) return true; // 只有 UpdatedAt

        var result = await _db.PersonalSources.UpdateOneAsync(
            s => s.Id == id && s.UserId == userId,
            Builders<PersonalSource>.Update.Combine(updates),
            cancellationToken: ct);

        return result.MatchedCount > 0;
    }

    public async Task<bool> DeleteAsync(string id, string userId, CancellationToken ct = default)
    {
        var result = await _db.PersonalSources.DeleteOneAsync(
            s => s.Id == id && s.UserId == userId, ct);
        return result.DeletedCount > 0;
    }

    public async Task<bool> TestConnectionAsync(string id, string userId, CancellationToken ct = default)
    {
        var source = await GetAsync(id, userId, ct);
        if (source == null) return false;

        var connector = CreateConnector(source);
        if (connector == null) return false;

        return await connector.TestConnectionAsync(ct);
    }

    public async Task<SourceStats?> SyncAsync(string id, string userId, DateTime from, DateTime to, CancellationToken ct = default)
    {
        var source = await GetAsync(id, userId, ct);
        if (source == null) return null;

        var connector = CreateConnector(source);
        if (connector == null) return null;

        try
        {
            var stats = await connector.CollectStatsAsync(from, to, ct);

            await _db.PersonalSources.UpdateOneAsync(
                s => s.Id == id,
                Builders<PersonalSource>.Update
                    .Set(s => s.LastSyncAt, DateTime.UtcNow)
                    .Set(s => s.LastSyncStatus, PersonalSourceSyncStatus.Success)
                    .Set(s => s.LastSyncError, (string?)null),
                cancellationToken: CancellationToken.None);

            return stats;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[PersonalSource] Sync failed for {Id}", id);

            await _db.PersonalSources.UpdateOneAsync(
                s => s.Id == id,
                Builders<PersonalSource>.Update
                    .Set(s => s.LastSyncAt, DateTime.UtcNow)
                    .Set(s => s.LastSyncStatus, PersonalSourceSyncStatus.Failed)
                    .Set(s => s.LastSyncError, ex.Message),
                cancellationToken: CancellationToken.None);

            return null;
        }
    }

    /// <summary>
    /// 采集指定用户所有启用数据源的统计（汇总）
    /// </summary>
    public async Task<List<SourceStats>> CollectAllAsync(string userId, DateTime from, DateTime to, CancellationToken ct = default)
    {
        var sources = await _db.PersonalSources
            .Find(s => s.UserId == userId && s.Enabled)
            .ToListAsync(ct);

        var results = new List<SourceStats>();
        foreach (var source in sources)
        {
            var connector = CreateConnector(source);
            if (connector == null) continue;

            try
            {
                var stats = await connector.CollectStatsAsync(from, to, ct);
                results.Add(stats);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[PersonalSource] Collect failed for {SourceType}/{Id}", source.SourceType, source.Id);
            }
        }

        return results;
    }

    private IPersonalSourceConnector? CreateConnector(PersonalSource source)
    {
        var token = string.IsNullOrEmpty(source.EncryptedToken)
            ? null
            : ApiKeyCrypto.Decrypt(source.EncryptedToken, CryptoKey);

        if (string.IsNullOrEmpty(token)) return null;
        var sourceType = (source.SourceType ?? string.Empty).Trim().ToLowerInvariant();

        return sourceType switch
        {
            PersonalSourceType.GitHub => new PersonalGitHubConnector(token, source.Config.Username ?? "", source.Config.RepoUrl),
            PersonalSourceType.Yuque => new PersonalYuqueConnector(
                token,
                source.Config.SpaceId,
                source.Config.YuqueRepoId,
                source.Config.YuqueUrl),
            _ => null
        };
    }

    private static PersonalSourceConfig MergeConfig(PersonalSourceConfig current, PersonalSourceConfig incoming)
    {
        return new PersonalSourceConfig
        {
            RepoUrl = incoming.RepoUrl ?? current.RepoUrl,
            Username = incoming.Username ?? current.Username,
            SpaceId = incoming.SpaceId ?? current.SpaceId,
            YuqueUrl = incoming.YuqueUrl ?? current.YuqueUrl,
            YuqueUrlNormalized = incoming.YuqueUrlNormalized ?? current.YuqueUrlNormalized,
            YuqueRepoId = incoming.YuqueRepoId ?? current.YuqueRepoId,
            YuqueNamespace = incoming.YuqueNamespace ?? current.YuqueNamespace,
            YuqueRepoName = incoming.YuqueRepoName ?? current.YuqueRepoName,
            ApiEndpoint = incoming.ApiEndpoint ?? current.ApiEndpoint
        };
    }

    private async Task<PersonalSourceConfig> NormalizeConfigAsync(
        string sourceType,
        PersonalSourceConfig config,
        string? token,
        CancellationToken ct)
    {
        if (sourceType != PersonalSourceType.Yuque)
            return config;

        var normalized = new PersonalSourceConfig
        {
            RepoUrl = config.RepoUrl,
            Username = config.Username,
            SpaceId = config.SpaceId,
            YuqueUrl = config.YuqueUrl,
            YuqueUrlNormalized = YuqueUrlHelper.NormalizeRepoUrl(config.YuqueUrl),
            YuqueRepoId = config.YuqueRepoId,
            YuqueNamespace = config.YuqueNamespace,
            YuqueRepoName = config.YuqueRepoName,
            ApiEndpoint = config.ApiEndpoint
        };

        if (string.IsNullOrWhiteSpace(normalized.YuqueUrl))
            return normalized;

        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException(ErrorYuqueTokenRequired);

        var resolved = await PersonalYuqueConnector.ResolveRepoByUrlAsync(token, normalized.YuqueUrl, ct);
        if (resolved == null)
            throw new InvalidOperationException(ErrorInvalidYuqueUrl);

        normalized.YuqueRepoId = resolved.RepoId;
        normalized.SpaceId = resolved.RepoId;
        normalized.YuqueNamespace = resolved.Namespace;
        normalized.YuqueRepoName = resolved.RepoName;

        return normalized;
    }

    private async Task EnsureNoDuplicateYuqueSourceAsync(
        string userId,
        PersonalSourceConfig config,
        string? excludingId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(config.YuqueRepoId) && string.IsNullOrWhiteSpace(config.YuqueUrlNormalized))
            return;

        var filter = Builders<PersonalSource>.Filter.Eq(s => s.UserId, userId) &
                     Builders<PersonalSource>.Filter.Eq(s => s.SourceType, PersonalSourceType.Yuque);

        if (!string.IsNullOrWhiteSpace(config.YuqueRepoId))
            filter &= Builders<PersonalSource>.Filter.Eq(s => s.Config.YuqueRepoId, config.YuqueRepoId);
        else
            filter &= Builders<PersonalSource>.Filter.Eq(s => s.Config.YuqueUrlNormalized, config.YuqueUrlNormalized);

        if (!string.IsNullOrWhiteSpace(excludingId))
            filter &= Builders<PersonalSource>.Filter.Ne(s => s.Id, excludingId);

        var exists = await _db.PersonalSources.Find(filter).AnyAsync(ct);
        if (exists)
            throw new InvalidOperationException(ErrorDuplicateYuqueSource);
    }
}
