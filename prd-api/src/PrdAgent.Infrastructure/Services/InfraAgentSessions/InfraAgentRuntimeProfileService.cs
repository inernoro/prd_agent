using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.InfraAgentSessions;

public class InfraAgentRuntimeProfileService : IInfraAgentRuntimeProfileService
{
    private const string ProtectorPurpose = "InfraAgentRuntimeProfile.ApiKey.v1";

    private readonly MongoDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _configuration;

    public InfraAgentRuntimeProfileService(
        MongoDbContext db,
        IDataProtectionProvider protectionProvider,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration)
    {
        _db = db;
        _protector = protectionProvider.CreateProtector(ProtectorPurpose);
        _httpClientFactory = httpClientFactory;
        _configuration = configuration;
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
            Protocol = NormalizeProtocol(request.Protocol),
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

    public async Task<InfraAgentRuntimeProfileView> UpdateAsync(
        string id,
        string userId,
        UpsertInfraAgentRuntimeProfileRequest request,
        CancellationToken ct)
    {
        var item = await _db.InfraAgentRuntimeProfiles.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ProfileNotFound,
                "运行配置不存在",
                StatusCodes.Status404NotFound);
        }

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
                "更新配置时必须重新输入 API key");
        }

        item.Name = name;
        item.Runtime = NormalizeRuntime(request.Runtime);
        item.Protocol = NormalizeProtocol(request.Protocol);
        item.BaseUrl = baseUrl;
        item.Model = model;
        item.ApiKeyEncrypted = _protector.Protect(apiKey);
        item.IsDefault = request.IsDefault ?? item.IsDefault;
        item.CreatedByUserId = string.IsNullOrWhiteSpace(item.CreatedByUserId) ? userId : item.CreatedByUserId;
        item.UpdatedAt = DateTime.UtcNow;

        if (item.IsDefault)
        {
            await _db.InfraAgentRuntimeProfiles.UpdateManyAsync(
                x => x.Id != item.Id,
                Builders<InfraAgentRuntimeProfile>.Update.Set(x => x.IsDefault, false),
                cancellationToken: ct);
        }

        await _db.InfraAgentRuntimeProfiles.ReplaceOneAsync(x => x.Id == item.Id, item, cancellationToken: ct);
        return ToView(item);
    }

    public async Task<InfraAgentRuntimeProfileView> ImportDefaultModelAsync(string userId, CancellationToken ct)
    {
        var model = await _db.LLMModels
            .Find(x => x.Enabled && x.IsMain)
            .FirstOrDefaultAsync(ct)
            ?? await _db.LLMModels
                .Find(x => x.Enabled)
                .SortBy(x => x.Priority)
                .ThenByDescending(x => x.UpdatedAt)
                .FirstOrDefaultAsync(ct);

        if (model == null)
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ModelNotConfigured,
                "系统模型池没有可用模型，请先在模型设置中配置一个启用模型",
                StatusCodes.Status409Conflict);
        }

        var resolved = await ResolveModelApiConfigAsync(model, ct);
        if (string.IsNullOrWhiteSpace(resolved.ApiUrl)
            || string.IsNullOrWhiteSpace(resolved.ApiKey)
            || string.IsNullOrWhiteSpace(model.ModelName))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ModelConfigIncomplete,
                $"系统模型「{model.Name}」缺少 baseUrl、model 或 API key，无法同步到 CDS Agent",
                StatusCodes.Status409Conflict);
        }

        var now = DateTime.UtcNow;
        var profile = new InfraAgentRuntimeProfile
        {
            Name = $"系统主模型 · {model.Name}",
            Runtime = InfraAgentRuntimes.ClaudeSdk,
            Protocol = InferProtocol(resolved.PlatformType, resolved.ApiUrl),
            BaseUrl = NormalizeModelBaseUrl(resolved.ApiUrl),
            Model = model.ModelName.Trim(),
            ApiKeyEncrypted = _protector.Protect(resolved.ApiKey),
            IsDefault = true,
            CreatedByUserId = userId,
            CreatedAt = now,
            UpdatedAt = now
        };

        await _db.InfraAgentRuntimeProfiles.UpdateManyAsync(
            _ => true,
            Builders<InfraAgentRuntimeProfile>.Update.Set(x => x.IsDefault, false),
            cancellationToken: ct);

        var existing = await _db.InfraAgentRuntimeProfiles
            .Find(x => x.Name == profile.Name
                && x.Model == profile.Model
                && x.BaseUrl == profile.BaseUrl)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            existing.Runtime = profile.Runtime;
            existing.Protocol = profile.Protocol;
            existing.ApiKeyEncrypted = profile.ApiKeyEncrypted;
            existing.IsDefault = true;
            existing.UpdatedAt = now;
            await _db.InfraAgentRuntimeProfiles.ReplaceOneAsync(x => x.Id == existing.Id, existing, cancellationToken: ct);
            return ToView(existing);
        }

        await _db.InfraAgentRuntimeProfiles.InsertOneAsync(profile, cancellationToken: ct);
        return ToView(profile);
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
            NormalizeProtocol(profile.Protocol),
            profile.BaseUrl,
            profile.Model,
            apiKey);
    }

    public async Task<InfraAgentRuntimeProfileTestResult> TestAsync(string id, CancellationToken ct)
    {
        var secret = await ResolveAsync(id, ct);
        if (secret == null)
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ProfileNotFound,
                "运行配置不存在",
                StatusCodes.Status404NotFound);
        }

        var sw = Stopwatch.StartNew();
        try
        {
            var http = _httpClientFactory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(30);
            var url = BuildTestUrl(secret.BaseUrl, secret.Protocol);
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            ApplyAuthHeaders(req, secret.Protocol, secret.ApiKey);
            req.Headers.UserAgent.Add(new ProductInfoHeaderValue("prd-agent-runtime-profile-test", "1.0"));
            req.Content = new StringContent(BuildTestBody(secret.Protocol, secret.Model), Encoding.UTF8, "application/json");

            using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            sw.Stop();
            var text = await resp.Content.ReadAsStringAsync(ct);
            if (resp.IsSuccessStatusCode)
            {
                return new InfraAgentRuntimeProfileTestResult(
                    secret.Id,
                    true,
                    "ok",
                    "模型配置可用，已收到上游响应。",
                    secret.Protocol,
                    secret.BaseUrl,
                    secret.Model,
                    (int)resp.StatusCode,
                    sw.ElapsedMilliseconds);
            }

            return new InfraAgentRuntimeProfileTestResult(
                secret.Id,
                false,
                "failed",
                BuildUpstreamError((int)resp.StatusCode, text),
                secret.Protocol,
                secret.BaseUrl,
                secret.Model,
                (int)resp.StatusCode,
                sw.ElapsedMilliseconds);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            sw.Stop();
            return new InfraAgentRuntimeProfileTestResult(
                secret.Id,
                false,
                "failed",
                $"模型上游不可达：{ex.Message}",
                secret.Protocol,
                secret.BaseUrl,
                secret.Model,
                null,
                sw.ElapsedMilliseconds);
        }
    }

    private InfraAgentRuntimeProfileView ToView(InfraAgentRuntimeProfile item) => new(
        item.Id,
        item.Name,
        item.Runtime,
        NormalizeProtocol(item.Protocol),
        item.BaseUrl,
        item.Model,
        HasReadableApiKey(item),
        item.IsDefault,
        item.CreatedAt,
        item.UpdatedAt);

    private bool HasReadableApiKey(InfraAgentRuntimeProfile item)
    {
        if (string.IsNullOrWhiteSpace(item.ApiKeyEncrypted)) return false;
        try
        {
            _protector.Unprotect(item.ApiKeyEncrypted);
            return true;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    private static string NormalizeRuntime(string? runtime)
    {
        var normalized = NormalizeOptional(runtime);
        return normalized is InfraAgentRuntimes.ClaudeSdk or InfraAgentRuntimes.Codex or InfraAgentRuntimes.Custom
            ? normalized
            : InfraAgentRuntimes.ClaudeSdk;
    }

    private static string NormalizeProtocol(string? protocol)
    {
        var normalized = NormalizeOptional(protocol);
        return normalized is InfraAgentRuntimeProtocols.Anthropic or InfraAgentRuntimeProtocols.OpenAiCompatible
            ? normalized
            : InfraAgentRuntimeProtocols.Anthropic;
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
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    private static string BuildTestUrl(string baseUrl, string protocol)
    {
        return NormalizeProtocol(protocol) == InfraAgentRuntimeProtocols.OpenAiCompatible
            ? CombineEndpoint(baseUrl, "/v1/chat/completions")
            : CombineEndpoint(baseUrl, "/v1/messages");
    }

    private static string CombineEndpoint(string baseUrl, string endpoint)
    {
        var root = baseUrl.TrimEnd('/');
        var cleanEndpoint = endpoint.StartsWith("/v1/", StringComparison.Ordinal) && root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)
            ? endpoint[3..]
            : endpoint;
        return $"{root}{cleanEndpoint}";
    }

    private static void ApplyAuthHeaders(HttpRequestMessage req, string protocol, string apiKey)
    {
        if (NormalizeProtocol(protocol) == InfraAgentRuntimeProtocols.OpenAiCompatible)
        {
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            return;
        }

        req.Headers.Add("x-api-key", apiKey);
        req.Headers.Add("anthropic-version", "2023-06-01");
    }

    private static string BuildTestBody(string protocol, string model)
    {
        if (NormalizeProtocol(protocol) == InfraAgentRuntimeProtocols.OpenAiCompatible)
        {
            return JsonSerializer.Serialize(new
            {
                model,
                max_tokens = 8,
                messages = new[]
                {
                    new { role = "user", content = "Reply with ok." }
                }
            });
        }

        return JsonSerializer.Serialize(new
        {
            model,
            max_tokens = 8,
            messages = new[]
            {
                new { role = "user", content = "Reply with ok." }
            }
        });
    }

    private static string? NormalizeOptional(string? value)
    {
        var normalized = value?.Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private static string BuildUpstreamError(int statusCode, string body)
    {
        var trimmed = string.IsNullOrWhiteSpace(body) ? "" : body.Trim();
        if (trimmed.Length > 500) trimmed = trimmed[..500];
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return $"模型上游返回 HTTP {statusCode}";
        }
        return $"模型上游返回 HTTP {statusCode}: {trimmed}";
    }

    private async Task<(string? ApiUrl, string? ApiKey, string? PlatformType)> ResolveModelApiConfigAsync(LLMModel model, CancellationToken ct)
    {
        var apiUrl = NormalizeOptional(model.ApiUrl);
        var apiKey = string.IsNullOrWhiteSpace(model.ApiKeyEncrypted)
            ? null
            : ApiKeyCrypto.Decrypt(model.ApiKeyEncrypted, GetJwtSecret());
        string? platformType = null;

        if (!string.IsNullOrWhiteSpace(model.PlatformId))
        {
            var platform = await _db.LLMPlatforms.Find(x => x.Id == model.PlatformId).FirstOrDefaultAsync(ct);
            if (platform != null)
            {
                apiUrl ??= NormalizeOptional(platform.ApiUrl);
                apiKey ??= ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, GetJwtSecret());
                platformType = NormalizeOptional(platform.PlatformType);
            }
        }

        return (apiUrl, apiKey, platformType);
    }

    private static string InferProtocol(string? platformType, string apiUrl)
    {
        return string.Equals(platformType, "anthropic", StringComparison.OrdinalIgnoreCase)
            || apiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase)
            || apiUrl.Contains("/anthropic", StringComparison.OrdinalIgnoreCase)
            ? InfraAgentRuntimeProtocols.Anthropic
            : InfraAgentRuntimeProtocols.OpenAiCompatible;
    }

    private static string NormalizeModelBaseUrl(string apiUrl)
    {
        var value = apiUrl.Trim().TrimEnd('/');
        foreach (var suffix in new[]
        {
            "/v1/chat/completions",
            "/chat/completions",
            "/v1/messages",
            "/messages",
            "/v1/models",
            "/models"
        })
        {
            if (value.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                value = value[..^suffix.Length].TrimEnd('/');
                break;
            }
        }
        return NormalizeBaseUrl(value);
    }

    private string GetJwtSecret() => _configuration["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
}
