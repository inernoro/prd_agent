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

    public async Task<List<InfraAgentRuntimeProfileView>> ListAsync(string userId, CancellationToken ct)
    {
        var teamIds = await GetVisibleTeamIdsAsync(userId, ct);
        var items = await _db.InfraAgentRuntimeProfiles
            .Find(ProfileAccessibleFilter(userId, teamIds))
            .SortByDescending(x => x.IsDefault)
            .ThenByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);
        return items.Select(x => ToView(x, userId)).ToList();
    }

    public Task<List<InfraAgentRuntimeProfileTemplateView>> ListTemplatesAsync(CancellationToken ct)
    {
        return Task.FromResult(InfraAgentRuntimeProfileTemplates.All.ToList());
    }

    public Task<List<InfraAgentRuntimeAdapterCompatibilityView>> ListAdapterCompatibilityAsync(CancellationToken ct)
    {
        return Task.FromResult(InfraAgentRuntimeAdapterCompatibility.All.ToList());
    }

    public async Task<InfraAgentRuntimeAdapterMatrixView> GetAdapterMatrixAsync(string userId, CancellationToken ct)
    {
        var profiles = await ListAsync(userId, ct);
        var templates = InfraAgentRuntimeProfileTemplates.All;
        return InfraAgentRuntimeAdapterCompatibility.BuildMatrix(
            InfraAgentRuntimeAdapterDefaults.ResolveSidecarRuntimeAdapter(),
            profiles,
            templates);
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
        var resolvedApiKey = apiKey ?? string.Empty;
        var protocol = NormalizeProtocol(request.Protocol);
        InfraAgentRuntimeProfileTemplates.ValidateApiKeyForProfile(protocol, baseUrl, resolvedApiKey);

        var now = DateTime.UtcNow;
        var sharedTeamIds = await NormalizeSharedTeamIdsAsync(userId, request.SharedTeamIds, ct);
        var item = new InfraAgentRuntimeProfile
        {
            Name = name,
            Runtime = NormalizeRuntime(request.Runtime),
            Protocol = protocol,
            BaseUrl = baseUrl,
            Model = model,
            ApiKeyEncrypted = _protector.Protect(resolvedApiKey),
            ResourceCpuCores = NormalizeCpuCores(request.ResourceCpuCores),
            ResourceMemoryMb = NormalizeMemoryMb(request.ResourceMemoryMb),
            TimeoutSeconds = NormalizeTimeoutSeconds(request.TimeoutSeconds),
            NetworkPolicy = NormalizeNetworkPolicy(request.NetworkPolicy),
            AutoCleanupMinutes = NormalizeAutoCleanupMinutes(request.AutoCleanupMinutes),
            IsDefault = request.IsDefault == true,
            CreatedByUserId = userId,
            SharedTeamIds = sharedTeamIds,
            CreatedAt = now,
            UpdatedAt = now
        };

        if (item.IsDefault)
        {
            await _db.InfraAgentRuntimeProfiles.UpdateManyAsync(
                ProfileOwnerFilter(userId),
                Builders<InfraAgentRuntimeProfile>.Update.Set(x => x.IsDefault, false),
                cancellationToken: ct);
        }

        await _db.InfraAgentRuntimeProfiles.InsertOneAsync(item, cancellationToken: ct);
        return ToView(item, userId);
    }

    public Task<InfraAgentRuntimeProfileView> CreateFromTemplateAsync(
        string templateId,
        string userId,
        CreateInfraAgentRuntimeProfileFromTemplateRequest request,
        CancellationToken ct)
    {
        var template = InfraAgentRuntimeProfileTemplates.All
            .FirstOrDefault(x => string.Equals(x.Id, templateId, StringComparison.OrdinalIgnoreCase));
        if (template == null)
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.TemplateNotFound,
                "运行配置模板不存在",
                StatusCodes.Status404NotFound);
        }
        InfraAgentRuntimeProfileTemplates.ValidateApiKeyForTemplate(template, request.ApiKey);

        var upsert = new UpsertInfraAgentRuntimeProfileRequest(
            NormalizeOptional(request.Name) ?? template.Name,
            template.Runtime,
            template.Protocol,
            template.BaseUrl,
            template.Model,
            request.ApiKey,
            template.ResourceCpuCores,
            template.ResourceMemoryMb,
            template.TimeoutSeconds,
            template.NetworkPolicy,
            template.AutoCleanupMinutes,
            request.IsDefault ?? template.IsDefaultRecommended,
            request.SharedTeamIds);
        return CreateAsync(userId, upsert, ct);
    }

    public async Task<InfraAgentRuntimeProfilePromotionResult> CreateDefaultFromTemplateAfterTestAsync(
        string templateId,
        string userId,
        CreateInfraAgentRuntimeProfileFromTemplateRequest request,
        CancellationToken ct)
    {
        var candidate = await CreateFromTemplateAsync(
            templateId,
            userId,
            request with { IsDefault = false },
            ct);

        var promoted = false;
        try
        {
            var test = await TestAsync(candidate.Id, userId, ct);
            if (!test.Success)
            {
                throw new InfraAgentRuntimeProfileException(
                    InfraAgentRuntimeProfileErrorCodes.ProfileTestFailed,
                    $"候选模型配置测试失败：{test.Message}",
                    StatusCodes.Status422UnprocessableEntity);
            }

            var promotedItem = await UpdateAsync(
                candidate.Id,
                userId,
                new UpsertInfraAgentRuntimeProfileRequest(
                    candidate.Name,
                    candidate.Runtime,
                    candidate.Protocol,
                    candidate.BaseUrl,
                    candidate.Model,
                    request.ApiKey,
                    candidate.ResourceCpuCores,
                    candidate.ResourceMemoryMb,
                    candidate.TimeoutSeconds,
                    candidate.NetworkPolicy,
                    candidate.AutoCleanupMinutes,
                    true,
                    candidate.SharedTeamIds),
                ct);
            promoted = true;
            return new InfraAgentRuntimeProfilePromotionResult(promotedItem, test);
        }
        finally
        {
            if (!promoted)
            {
                await DeleteAsync(candidate.Id, userId, ct);
            }
        }
    }

    public async Task<InfraAgentRuntimeProfileView> UpdateAsync(
        string id,
        string userId,
        UpsertInfraAgentRuntimeProfileRequest request,
        CancellationToken ct)
    {
        var item = await _db.InfraAgentRuntimeProfiles.Find(ProfileIdOwnerFilter(id, userId)).FirstOrDefaultAsync(ct);
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
        var retainsExistingApiKey = string.IsNullOrWhiteSpace(apiKey);
        if (retainsExistingApiKey)
        {
            if (string.IsNullOrWhiteSpace(item.ApiKeyEncrypted))
            {
                throw new InfraAgentRuntimeProfileException(
                    InfraAgentRuntimeProfileErrorCodes.ApiKeyRequired,
                    "当前配置没有可复用的 provider secret，请输入后再保存");
            }
            try
            {
                apiKey = _protector.Unprotect(item.ApiKeyEncrypted);
            }
            catch (CryptographicException)
            {
                throw new InfraAgentRuntimeProfileException(
                    InfraAgentRuntimeProfileErrorCodes.ApiKeyUnreadable,
                    $"模型配置「{item.Name}」的 provider secret 无法解密，请重新输入后再保存。",
                    StatusCodes.Status409Conflict);
            }
        }
        var resolvedApiKey = apiKey ?? string.Empty;
        var protocol = NormalizeProtocol(request.Protocol);
        InfraAgentRuntimeProfileTemplates.ValidateApiKeyForProfile(protocol, baseUrl, resolvedApiKey);
        var sharedTeamIds = request.SharedTeamIds == null
            ? item.SharedTeamIds ?? new List<string>()
            : await NormalizeSharedTeamIdsAsync(userId, request.SharedTeamIds, ct);

        item.Name = name;
        item.Runtime = NormalizeRuntime(request.Runtime);
        item.Protocol = protocol;
        item.BaseUrl = baseUrl;
        item.Model = model;
        if (!retainsExistingApiKey)
        {
            item.ApiKeyEncrypted = _protector.Protect(resolvedApiKey);
        }
        item.ResourceCpuCores = NormalizeCpuCores(request.ResourceCpuCores);
        item.ResourceMemoryMb = NormalizeMemoryMb(request.ResourceMemoryMb);
        item.TimeoutSeconds = NormalizeTimeoutSeconds(request.TimeoutSeconds);
        item.NetworkPolicy = NormalizeNetworkPolicy(request.NetworkPolicy);
        item.AutoCleanupMinutes = NormalizeAutoCleanupMinutes(request.AutoCleanupMinutes);
        item.IsDefault = request.IsDefault ?? item.IsDefault;
        item.CreatedByUserId = string.IsNullOrWhiteSpace(item.CreatedByUserId) ? userId : item.CreatedByUserId;
        item.SharedTeamIds = sharedTeamIds;
        item.UpdatedAt = DateTime.UtcNow;

        if (item.IsDefault)
        {
            await _db.InfraAgentRuntimeProfiles.UpdateManyAsync(
                ProfileOwnerFilter(userId) & Builders<InfraAgentRuntimeProfile>.Filter.Ne(x => x.Id, item.Id),
                Builders<InfraAgentRuntimeProfile>.Update.Set(x => x.IsDefault, false),
                cancellationToken: ct);
        }

        await _db.InfraAgentRuntimeProfiles.ReplaceOneAsync(ProfileIdOwnerFilter(item.Id, userId), item, cancellationToken: ct);
        return ToView(item, userId);
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
        var protocol = InferProtocol(resolved.PlatformType, resolved.ApiUrl);
        var baseUrl = NormalizeModelBaseUrl(resolved.ApiUrl);
        var runtime = InferRuntime(protocol, model.ModelName);
        InfraAgentRuntimeProfileTemplates.ValidateApiKeyForProfile(protocol, baseUrl, resolved.ApiKey);

        var profile = new InfraAgentRuntimeProfile
        {
            Name = $"系统主模型 · {model.Name}",
            Runtime = runtime,
            Protocol = protocol,
            BaseUrl = baseUrl,
            Model = model.ModelName.Trim(),
            ApiKeyEncrypted = _protector.Protect(resolved.ApiKey),
            ResourceCpuCores = 2,
            ResourceMemoryMb = 4096,
            TimeoutSeconds = 900,
            NetworkPolicy = InfraAgentRuntimeNetworkPolicies.Restricted,
            AutoCleanupMinutes = 30,
            IsDefault = true,
            CreatedByUserId = userId,
            SharedTeamIds = new List<string>(),
            CreatedAt = now,
            UpdatedAt = now
        };

        await _db.InfraAgentRuntimeProfiles.UpdateManyAsync(
            ProfileOwnerFilter(userId),
            Builders<InfraAgentRuntimeProfile>.Update.Set(x => x.IsDefault, false),
            cancellationToken: ct);

        var existing = await _db.InfraAgentRuntimeProfiles
            .Find(x => x.Name == profile.Name
                && x.CreatedByUserId == userId
                && x.Model == profile.Model
                && x.BaseUrl == profile.BaseUrl)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            existing.Runtime = profile.Runtime;
            existing.Protocol = profile.Protocol;
            existing.ApiKeyEncrypted = profile.ApiKeyEncrypted;
            existing.ResourceCpuCores = profile.ResourceCpuCores;
            existing.ResourceMemoryMb = profile.ResourceMemoryMb;
            existing.TimeoutSeconds = profile.TimeoutSeconds;
            existing.NetworkPolicy = profile.NetworkPolicy;
            existing.AutoCleanupMinutes = profile.AutoCleanupMinutes;
            existing.IsDefault = true;
            existing.SharedTeamIds = profile.SharedTeamIds;
            existing.UpdatedAt = now;
            await _db.InfraAgentRuntimeProfiles.ReplaceOneAsync(ProfileIdOwnerFilter(existing.Id, userId), existing, cancellationToken: ct);
            return ToView(existing, userId);
        }

        await _db.InfraAgentRuntimeProfiles.InsertOneAsync(profile, cancellationToken: ct);
        return ToView(profile, userId);
    }

    /// <summary>
    /// 从系统模型池任选一个模型物化为运行配置（2026-06-11 用户提案：模型池配过的
    /// baseUrl/key 不应再让人手抄一遍）。幂等：同 用户+model+baseUrl 已存在则刷新复用。
    /// 不抢默认位（IsDefault=false），由调用方在弹层里即选即用。
    /// </summary>
    public async Task<InfraAgentRuntimeProfileView> ImportFromPoolAsync(string userId, string modelId, CancellationToken ct)
    {
        var model = await _db.LLMModels
            .Find(x => x.Id == modelId && x.Enabled)
            .FirstOrDefaultAsync(ct);
        if (model == null)
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ModelNotConfigured,
                "模型池中没有该模型或已停用",
                StatusCodes.Status404NotFound);
        }

        var resolved = await ResolveModelApiConfigAsync(model, ct);
        if (string.IsNullOrWhiteSpace(resolved.ApiUrl)
            || string.IsNullOrWhiteSpace(resolved.ApiKey)
            || string.IsNullOrWhiteSpace(model.ModelName))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ModelConfigIncomplete,
                $"模型「{model.Name}」缺少 baseUrl、model 或 API key，无法同步到 CDS Agent",
                StatusCodes.Status409Conflict);
        }

        var now = DateTime.UtcNow;
        var protocol = InferProtocol(resolved.PlatformType, resolved.ApiUrl);
        var baseUrl = NormalizeModelBaseUrl(resolved.ApiUrl);
        var runtime = InferRuntime(protocol, model.ModelName);
        InfraAgentRuntimeProfileTemplates.ValidateApiKeyForProfile(protocol, baseUrl, resolved.ApiKey);

        var trimmedModel = model.ModelName.Trim();
        var existing = await _db.InfraAgentRuntimeProfiles
            .Find(x => x.CreatedByUserId == userId && x.Model == trimmedModel && x.BaseUrl == baseUrl)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            existing.Runtime = runtime;
            existing.Protocol = protocol;
            existing.ApiKeyEncrypted = _protector.Protect(resolved.ApiKey);
            existing.UpdatedAt = now;
            await _db.InfraAgentRuntimeProfiles.ReplaceOneAsync(ProfileIdOwnerFilter(existing.Id, userId), existing, cancellationToken: ct);
            return ToView(existing, userId);
        }

        var profile = new InfraAgentRuntimeProfile
        {
            Name = $"池 · {model.Name}",
            Runtime = runtime,
            Protocol = protocol,
            BaseUrl = baseUrl,
            Model = trimmedModel,
            ApiKeyEncrypted = _protector.Protect(resolved.ApiKey),
            ResourceCpuCores = 2,
            ResourceMemoryMb = 4096,
            TimeoutSeconds = 900,
            NetworkPolicy = InfraAgentRuntimeNetworkPolicies.Restricted,
            AutoCleanupMinutes = 30,
            IsDefault = false,
            CreatedByUserId = userId,
            SharedTeamIds = new List<string>(),
            CreatedAt = now,
            UpdatedAt = now
        };
        await _db.InfraAgentRuntimeProfiles.InsertOneAsync(profile, cancellationToken: ct);
        return ToView(profile, userId);
    }

    public async Task<bool> DeleteAsync(string id, string userId, CancellationToken ct)
    {
        var result = await _db.InfraAgentRuntimeProfiles.DeleteOneAsync(ProfileIdOwnerFilter(id, userId), ct);
        return result.DeletedCount > 0;
    }

    public async Task<InfraAgentRuntimeProfileSecretView?> ResolveAsync(string? id, string userId, CancellationToken ct)
    {
        var teamIds = await GetVisibleTeamIdsAsync(userId, ct);
        InfraAgentRuntimeProfile? profile = null;
        if (!string.IsNullOrWhiteSpace(id))
        {
            profile = await _db.InfraAgentRuntimeProfiles
                .Find(ProfileIdAccessibleFilter(id, userId, teamIds))
                .FirstOrDefaultAsync(ct);
        }
        profile ??= await _db.InfraAgentRuntimeProfiles
            .Find(ProfileOwnerFilter(userId) & Builders<InfraAgentRuntimeProfile>.Filter.Eq(x => x.IsDefault, true))
            .FirstOrDefaultAsync(ct);
        if (profile == null && teamIds.Count > 0)
        {
            profile = await _db.InfraAgentRuntimeProfiles
                .Find(ProfileSharedWithTeamsFilter(teamIds) & Builders<InfraAgentRuntimeProfile>.Filter.Eq(x => x.IsDefault, true))
                .SortByDescending(x => x.UpdatedAt)
                .FirstOrDefaultAsync(ct);
        }
        profile ??= await _db.InfraAgentRuntimeProfiles
            .Find(ProfileOwnerFilter(userId))
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        if (profile == null && teamIds.Count > 0)
        {
            profile = await _db.InfraAgentRuntimeProfiles
                .Find(ProfileSharedWithTeamsFilter(teamIds))
                .SortByDescending(x => x.UpdatedAt)
                .FirstOrDefaultAsync(ct);
        }
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
            NormalizeCpuCores(profile.ResourceCpuCores),
            NormalizeMemoryMb(profile.ResourceMemoryMb),
            NormalizeTimeoutSeconds(profile.TimeoutSeconds),
            NormalizeNetworkPolicy(profile.NetworkPolicy),
            NormalizeAutoCleanupMinutes(profile.AutoCleanupMinutes),
            apiKey);
    }

    public async Task<InfraAgentRuntimeProfileTestResult> TestAsync(string id, string userId, CancellationToken ct)
    {
        var secret = await ResolveAsync(id, userId, ct);
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

    private InfraAgentRuntimeProfileView ToView(InfraAgentRuntimeProfile item, string? userId = null) => new(
        item.Id,
        item.Name,
        item.Runtime,
        NormalizeProtocol(item.Protocol),
        item.BaseUrl,
        item.Model,
        NormalizeCpuCores(item.ResourceCpuCores),
        NormalizeMemoryMb(item.ResourceMemoryMb),
        NormalizeTimeoutSeconds(item.TimeoutSeconds),
        NormalizeNetworkPolicy(item.NetworkPolicy),
        NormalizeAutoCleanupMinutes(item.AutoCleanupMinutes),
        HasReadableApiKey(item),
        item.IsDefault,
        item.CreatedAt,
        item.UpdatedAt,
        item.SharedTeamIds ?? new List<string>(),
        string.Equals(item.CreatedByUserId, userId, StringComparison.Ordinal) ? "user-owned" : "team-shared",
        item.CreatedByUserId);

    private static FilterDefinition<InfraAgentRuntimeProfile> ProfileOwnerFilter(string userId) =>
        Builders<InfraAgentRuntimeProfile>.Filter.Eq(x => x.CreatedByUserId, userId);

    private static FilterDefinition<InfraAgentRuntimeProfile> ProfileIdOwnerFilter(string id, string userId) =>
        Builders<InfraAgentRuntimeProfile>.Filter.Eq(x => x.Id, id) & ProfileOwnerFilter(userId);

    private static FilterDefinition<InfraAgentRuntimeProfile> ProfileSharedWithTeamsFilter(IReadOnlyList<string> teamIds) =>
        teamIds.Count == 0
            ? Builders<InfraAgentRuntimeProfile>.Filter.Where(_ => false)
            : Builders<InfraAgentRuntimeProfile>.Filter.AnyIn(x => x.SharedTeamIds, teamIds);

    private static FilterDefinition<InfraAgentRuntimeProfile> ProfileAccessibleFilter(string userId, IReadOnlyList<string> teamIds) =>
        ProfileOwnerFilter(userId) | ProfileSharedWithTeamsFilter(teamIds);

    private static FilterDefinition<InfraAgentRuntimeProfile> ProfileIdAccessibleFilter(string id, string userId, IReadOnlyList<string> teamIds) =>
        Builders<InfraAgentRuntimeProfile>.Filter.Eq(x => x.Id, id) & ProfileAccessibleFilter(userId, teamIds);

    private async Task<List<string>> GetVisibleTeamIdsAsync(string userId, CancellationToken ct)
    {
        var memberships = await _db.ReportTeamMembers
            .Find(x => x.UserId == userId)
            .Limit(500)
            .ToListAsync(ct);
        var memberTeamIds = memberships
            .Select(x => x.TeamId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToList();

        var leaderTeams = await _db.ReportTeams
            .Find(x => x.LeaderUserId == userId)
            .Limit(500)
            .ToListAsync(ct);

        return memberTeamIds
            .Concat(leaderTeams.Select(x => x.Id))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
    }

    private async Task<List<string>> NormalizeSharedTeamIdsAsync(
        string userId,
        IReadOnlyList<string>? requestedTeamIds,
        CancellationToken ct)
    {
        var requested = (requestedTeamIds ?? Array.Empty<string>())
            .Select(x => NormalizeOptional(x))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Cast<string>()
            .Distinct(StringComparer.Ordinal)
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        if (requested.Count == 0) return new List<string>();

        var visibleTeams = await GetVisibleTeamIdsAsync(userId, ct);
        var visibleSet = visibleTeams.ToHashSet(StringComparer.Ordinal);
        var invalid = requested.Where(x => !visibleSet.Contains(x)).ToList();
        if (invalid.Count > 0)
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.SharedTeamNotAccessible,
                $"无权将运行配置共享给团队：{string.Join(", ", invalid)}",
                StatusCodes.Status403Forbidden);
        }
        return requested;
    }

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
        return normalized is InfraAgentRuntimes.ClaudeSdk
            or InfraAgentRuntimes.OpenAiCompatible
            or InfraAgentRuntimes.Codex
            or InfraAgentRuntimes.Custom
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

    private static double NormalizeCpuCores(double? value)
    {
        var normalized = value.GetValueOrDefault(2);
        if (double.IsNaN(normalized) || double.IsInfinity(normalized)) normalized = 2;
        return Math.Round(Math.Clamp(normalized, 0.25, 8), 2);
    }

    private static double NormalizeCpuCores(double value) => NormalizeCpuCores((double?)value);

    private static int NormalizeMemoryMb(int? value) => Math.Clamp(value.GetValueOrDefault(4096), 512, 32768);

    private static int NormalizeMemoryMb(int value) => NormalizeMemoryMb((int?)value);

    private static int NormalizeTimeoutSeconds(int? value) => Math.Clamp(value.GetValueOrDefault(900), 30, 7200);

    private static int NormalizeTimeoutSeconds(int value) => NormalizeTimeoutSeconds((int?)value);

    private static int NormalizeAutoCleanupMinutes(int? value) => Math.Clamp(value.GetValueOrDefault(30), 5, 1440);

    private static int NormalizeAutoCleanupMinutes(int value) => NormalizeAutoCleanupMinutes((int?)value);

    private static string NormalizeNetworkPolicy(string? policy)
    {
        var normalized = NormalizeOptional(policy);
        return normalized is InfraAgentRuntimeNetworkPolicies.Restricted
            or InfraAgentRuntimeNetworkPolicies.EgressOnly
            or InfraAgentRuntimeNetworkPolicies.Open
            ? normalized
            : InfraAgentRuntimeNetworkPolicies.Restricted;
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

    private static string InferRuntime(string protocol, string? modelName)
    {
        var normalizedModel = modelName?.Trim() ?? string.Empty;
        if (string.Equals(protocol, InfraAgentRuntimeProtocols.Anthropic, StringComparison.OrdinalIgnoreCase)
            || normalizedModel.Contains("claude", StringComparison.OrdinalIgnoreCase)
            || normalizedModel.StartsWith("anthropic/", StringComparison.OrdinalIgnoreCase))
        {
            return InfraAgentRuntimes.ClaudeSdk;
        }

        return InfraAgentRuntimes.OpenAiCompatible;
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
