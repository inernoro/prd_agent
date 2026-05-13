using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using System.Security.Cryptography;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.InfraAgentSessions;

public class InfraAgentRuntimeProfileService : IInfraAgentRuntimeProfileService
{
    private const string ProtectorPurpose = "InfraAgentRuntimeProfile.ApiKey.v1";

    private readonly MongoDbContext _db;
    private readonly IDataProtector _protector;

    public InfraAgentRuntimeProfileService(MongoDbContext db, IDataProtectionProvider protectionProvider)
    {
        _db = db;
        _protector = protectionProvider.CreateProtector(ProtectorPurpose);
    }

    public async Task<List<InfraAgentRuntimeProfileView>> ListAsync(CancellationToken ct)
    {
        var items = await _db.InfraAgentRuntimeProfiles
            .Find(_ => true)
            .SortByDescending(x => x.IsDefault)
            .ThenByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);
        return items.Select(ToView).ToList();
    }

    public async Task<InfraAgentRuntimeProfileView> CreateAsync(
        string userId,
        UpsertInfraAgentRuntimeProfileRequest request,
        CancellationToken ct)
    {
        var name = NormalizeOptional(request.Name);
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.NameRequired,
                "配置名称不能为空");
        }

        var baseUrl = NormalizeBaseUrl(request.BaseUrl);
        var model = NormalizeOptional(request.Model);
        var apiKey = NormalizeOptional(request.ApiKey);
        if (string.IsNullOrWhiteSpace(model))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ModelRequired,
                "模型名称不能为空");
        }
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ApiKeyRequired,
                "API key 不能为空");
        }

        var now = DateTime.UtcNow;
        var item = new InfraAgentRuntimeProfile
        {
            Name = name,
            Runtime = NormalizeRuntime(request.Runtime),
            BaseUrl = baseUrl,
            Model = model,
            ApiKeyEncrypted = _protector.Protect(apiKey),
            IsDefault = request.IsDefault == true,
            CreatedByUserId = userId,
            CreatedAt = now,
            UpdatedAt = now
        };

        if (item.IsDefault)
        {
            await _db.InfraAgentRuntimeProfiles.UpdateManyAsync(
                _ => true,
                Builders<InfraAgentRuntimeProfile>.Update.Set(x => x.IsDefault, false),
                cancellationToken: ct);
        }

        await _db.InfraAgentRuntimeProfiles.InsertOneAsync(item, cancellationToken: ct);
        return ToView(item);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        var result = await _db.InfraAgentRuntimeProfiles.DeleteOneAsync(x => x.Id == id, ct);
        return result.DeletedCount > 0;
    }

    public async Task<InfraAgentRuntimeProfileSecretView?> ResolveAsync(string? id, CancellationToken ct)
    {
        InfraAgentRuntimeProfile? profile = null;
        if (!string.IsNullOrWhiteSpace(id))
        {
            profile = await _db.InfraAgentRuntimeProfiles.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        }
        profile ??= await _db.InfraAgentRuntimeProfiles.Find(x => x.IsDefault).FirstOrDefaultAsync(ct);
        if (profile == null) return null;
        string apiKey;
        try
        {
            apiKey = _protector.Unprotect(profile.ApiKeyEncrypted);
        }
        catch (CryptographicException)
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ApiKeyUnreadable,
                $"模型配置「{profile.Name}」的 API key 无法解密，请在系统配置中重新保存该模型配置。",
                StatusCodes.Status409Conflict);
        }
        return new InfraAgentRuntimeProfileSecretView(
            profile.Id,
            profile.Name,
            profile.Runtime,
            profile.BaseUrl,
            profile.Model,
            apiKey);
    }

    private static InfraAgentRuntimeProfileView ToView(InfraAgentRuntimeProfile item) => new(
        item.Id,
        item.Name,
        item.Runtime,
        item.BaseUrl,
        item.Model,
        !string.IsNullOrWhiteSpace(item.ApiKeyEncrypted),
        item.IsDefault,
        item.CreatedAt,
        item.UpdatedAt);

    private static string NormalizeRuntime(string? runtime)
    {
        var normalized = NormalizeOptional(runtime);
        return normalized is InfraAgentRuntimes.ClaudeSdk or InfraAgentRuntimes.Codex or InfraAgentRuntimes.Custom
            ? normalized
            : InfraAgentRuntimes.ClaudeSdk;
    }

    private static string NormalizeBaseUrl(string? value)
    {
        var normalized = NormalizeOptional(value);
        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || string.IsNullOrWhiteSpace(uri.Host))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.BaseUrlInvalid,
                "BaseUrl 必须是 http 或 https URL",
                StatusCodes.Status400BadRequest);
        }
        return uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
    }

    private static string? NormalizeOptional(string? value)
    {
        var normalized = value?.Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }
}
