using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services.Speech;

public sealed class SpeechGenerationService(
    MongoDbContext db,
    PrdAgent.Core.LlmGateway.ILlmGateway gateway,
    ILLMRequestContextAccessor contextAccessor,
    IDataProtectionProvider protection,
    IAssetStorage storage,
    SpeechQuotaService quota,
    IHostEnvironment host,
    ILogger<SpeechGenerationService> logger)
{
    public const string AppKey = "mcp-speech";
    private static readonly DateTime ProcessStartedAt = DateTime.UtcNow;
    // 能力配置跟随稳定环境；任务认领另按含revision的部署作用域隔离。
    public string EnvironmentId => DeploymentScope.CurrentDurable ?? host.EnvironmentName;
    private string SettingsId => SpeechCapabilityPolicy.Hash($"speech-settings:{EnvironmentId}");

    public async Task<SpeechSettings> GetSettingsAsync()
        => await db.SpeechSettings.Find(x => x.Id == SettingsId).FirstOrDefaultAsync()
            ?? new SpeechSettings { Id = SettingsId, Environment = EnvironmentId };

    public async Task<List<AvailableModelPool>> GetModelPoolsAsync()
        => await gateway.GetAvailablePoolsAsync(AppCallerRegistry.McpSpeech.Synthesize, ModelTypes.Tts, CancellationToken.None);

    public async Task<SpeechSettings> SaveSettingsAsync(long revision, List<SpeechProfile> profiles)
    {
        if (profiles == null || profiles.Any(x => x == null) || profiles.Count > 30 || profiles.Select(x => x.Id).Distinct(StringComparer.Ordinal).Count() != profiles.Count
            || profiles.Count(x => x.Enabled && x.IsDefault) > 1)
            throw new SpeechException("SETTINGS_INVALID", "最多配置30项语音能力，标识不能重复，最多设置一个默认能力。");
        var settings = await GetSettingsAsync();
        if (settings.Revision != revision) throw new SpeechException("SETTINGS_CHANGED", "配置已被更新，请刷新后再保存。", 409);
        var pools = await GetModelPoolsAsync();
        foreach (var p in profiles)
        {
            SpeechCapabilityPolicy.ValidateProfile(p);
            if (p.Enabled && !pools.Any(x => x.Code == p.ModelPoolId))
                throw new SpeechException("MODEL_UNAVAILABLE", $"能力“{p.Name}”绑定的模型不在当前网关可用目录中，请检查网关授权。");
            if (p.Enabled)
            {
                var metadata = await gateway.ResolveModelMetadataAsync(AppCallerRegistry.McpSpeech.Synthesize, ModelTypes.Tts, p.ModelPoolId, ct: CancellationToken.None);
                ValidateResolution(p, metadata, allowRebind: true);
                p.Model = metadata.ActualModel;
                p.OfferingId = metadata.OfferingId;
            }
            var previous = settings.Profiles.FirstOrDefault(x => x.Id == p.Id);
            p.Revision = previous?.Revision ?? 0;
            if (previous == null || JsonSerializer.Serialize(previous) != JsonSerializer.Serialize(p)) p.Revision = settings.Revision + 1;
        }
        var next = new SpeechSettings { Id = SettingsId, Environment = EnvironmentId, Revision = revision + 1, Profiles = profiles, UpdatedAt = DateTime.UtcNow };
        if (revision == 0)
        {
            try { await db.SpeechSettings.InsertOneAsync(next, cancellationToken: CancellationToken.None); }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            { throw new SpeechException("SETTINGS_CHANGED", "配置已被更新，请刷新后再保存。", 409); }
        }
        else
        {
            var result = await db.SpeechSettings.ReplaceOneAsync(x => x.Id == SettingsId && x.Revision == revision, next, cancellationToken: CancellationToken.None);
            if (result.ModifiedCount != 1) throw new SpeechException("SETTINGS_CHANGED", "配置已被更新，请刷新后再保存。", 409);
        }
        return next;
    }

    public async Task<object> GetCapabilitiesAsync()
    {
        var settings = await GetSettingsAsync();
        List<AvailableModelPool> pools;
        try { pools = await GetModelPoolsAsync(); }
        catch (Exception ex) { logger.LogWarning(ex, "Speech capability directory unavailable"); pools = new(); }
        var profiles = new List<object>();
        foreach (var p in settings.Profiles.Where(x => x.Enabled))
        {
            var exists = pools.Any(x => x.Code == p.ModelPoolId);
            var reason = exists ? null : "当前环境的网关模型目录不可用或未开放此模型，请联系管理员检查配置。";
            if (exists)
            {
                try
                {
                    var metadata = await gateway.ResolveModelMetadataAsync(AppCallerRegistry.McpSpeech.Synthesize, ModelTypes.Tts, p.ModelPoolId, ct: CancellationToken.None);
                    ValidateResolution(p, metadata);
                }
                catch (Exception ex) when (ex is SpeechException || ex is HttpRequestException)
                { reason = "网关路由当前无法满足该语音能力，请检查模型和协议配置。"; }
            }
            profiles.Add(new { p.Id, p.Name, p.Protocol, p.Model, p.ModelPoolId, p.Revision, p.IsDefault, available = reason == null,
                unavailableReason = reason, p.MaxTextChars, p.Voices, p.Formats, p.SupportsInstructions, p.SupportsEmotion,
                p.Emotions, p.MinSpeed, p.MaxSpeed, p.DefaultVoiceId, p.DefaultFormat, p.DailyCharacterQuota, p.MaxConcurrentRuns });
        }
        return new { environment = EnvironmentId, revision = settings.Revision, profiles };
    }

    public async Task<List<SpeechPreset>> GetPresetsAsync(string owner)
        => await db.SpeechPresets.Find(x => x.OwnerUserId == owner && x.Environment == EnvironmentId)
            .SortByDescending(x => x.UpdatedAt).Limit(100).ToListAsync();

    public async Task<SpeechPreset> SavePresetAsync(string owner, SpeechPresetRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 100)
            throw new SpeechException("PRESET_INVALID", "声音预设名称不能为空，最长100字。");
        var profile = SelectProfile(await GetSettingsAsync(), request.ProfileId);
        var options = SpeechCapabilityPolicy.ResolveOptions(profile, request);
        var preset = new SpeechPreset { OwnerUserId = owner, Environment = EnvironmentId, Name = request.Name.Trim(),
            ProfileId = profile.Id, ProfileRevision = profile.Revision, VoiceId = options.VoiceId, Format = options.Format,
            Speed = options.Speed, Instructions = options.Instructions, Emotion = options.Emotion };
        if (request.Id == null)
        {
            var count = await db.SpeechPresets.CountDocumentsAsync(x => x.OwnerUserId == owner && x.Environment == EnvironmentId);
            if (count >= 100) throw new SpeechException("PRESET_LIMIT", "最多保存100个声音预设。");
            await db.SpeechPresets.InsertOneAsync(preset, cancellationToken: CancellationToken.None);
        }
        else
        {
            if (request.Revision is not > 0) throw new SpeechException("PRESET_CHANGED", "更新声音预设需携带当前版本。", 409);
            preset.Id = request.Id;
            preset.Revision = request.Revision.Value + 1;
            var result = await db.SpeechPresets.ReplaceOneAsync(x => x.Id == preset.Id && x.OwnerUserId == owner
                && x.Environment == EnvironmentId && x.Revision == request.Revision, preset, cancellationToken: CancellationToken.None);
            if (result.ModifiedCount != 1) throw new SpeechException("PRESET_CHANGED", "预设已更新或不存在，请刷新后再保存。", 409);
        }
        return preset;
    }

    public async Task<(SpeechRun Run, bool Deduplicated)> CreateAsync(string owner, string? keyId, SpeechCreateRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Text) || request.Text.Length > 40000 || request.Title?.Length > 150 || request.ClientRequestId?.Length > 512)
            throw new SpeechException("INPUT_INVALID", "请输入有效文字；标题最长150字，请求标识最长512位。");
        var fingerprint = SpeechCapabilityPolicy.RequestFingerprint(request);
        var normalizedRequestId = PrdAgent.Api.Mcp.McpIdempotency.Normalize(request.ClientRequestId);
        var idem = normalizedRequestId == null ? null
            : SpeechCapabilityPolicy.Hash($"speech-run:{EnvironmentId}:{owner}:{keyId ?? "web"}:{normalizedRequestId}")[..32];
        if (idem != null)
        {
            var prior = await db.SpeechRuns.Find(x => x.Id == idem && x.OwnerUserId == owner && x.Environment == EnvironmentId).FirstOrDefaultAsync();
            if (prior != null) return Replay(prior, fingerprint);
        }
        SpeechPreset? preset = null;
        if (request.PresetId != null)
        {
            preset = await db.SpeechPresets.Find(x => x.Id == request.PresetId && x.OwnerUserId == owner && x.Environment == EnvironmentId).FirstOrDefaultAsync();
            if (preset == null) throw new SpeechException("PRESET_NOT_FOUND", "声音预设不存在，请重新查询。", 404);
            if (request.ProfileId != null && request.ProfileId != preset.ProfileId)
                throw new SpeechException("PRESET_PROFILE_MISMATCH", "声音预设与指定语音能力不一致。");
        }
        var settings = await GetSettingsAsync();
        var profile = SelectProfile(settings, request.ProfileId ?? preset?.ProfileId);
        if (preset != null && preset.ProfileRevision != profile.Revision)
            throw new SpeechException("PRESET_STALE", "声音预设绑定的能力已更新，请检查并重新保存预设。", 409);
        var options = SpeechCapabilityPolicy.ResolveOptions(profile, new SpeechOptions
        {
            ProfileRevision = request.ProfileRevision ?? preset?.ProfileRevision, VoiceId = request.VoiceId ?? preset?.VoiceId,
            Format = request.Format ?? preset?.Format, Speed = request.Speed ?? preset?.Speed,
            Instructions = request.Instructions ?? preset?.Instructions, Emotion = request.Emotion ?? preset?.Emotion,
        });
        var chars = SpeechCapabilityPolicy.CountCharacters(request.Text);
        if (chars > profile.MaxTextChars || chars > profile.DailyCharacterQuota)
            throw new SpeechException("TEXT_TOO_LONG", $"当前能力单次最多{Math.Min(profile.MaxTextChars, profile.DailyCharacterQuota)}个字符，请缩短文字。");
        var pools = await GetModelPoolsAsync();
        if (!pools.Any(x => x.Code == profile.ModelPoolId))
            throw new SpeechException("MODEL_UNAVAILABLE", "当前环境未开放该语音模型，请联系管理员检查网关。", 503);
        var metadata = await gateway.ResolveModelMetadataAsync(AppCallerRegistry.McpSpeech.Synthesize, ModelTypes.Tts, profile.ModelPoolId, ct: CancellationToken.None);
        ValidateResolution(profile, metadata);
        var run = new SpeechRun { Id = idem ?? Guid.NewGuid().ToString("N"), OwnerUserId = owner, AgentApiKeyId = keyId,
            Environment = EnvironmentId, DeploymentSlug = DeploymentScope.Current, RequestFingerprint = fingerprint,
            Title = string.IsNullOrWhiteSpace(request.Title) ? new string(request.Text.Take(40).ToArray()) : request.Title.Trim(), Text = request.Text,
            ProfileId = profile.Id, ProfileName = profile.Name, ProfileRevision = profile.Revision, ProfileSnapshot = profile,
            VoiceId = options.VoiceId!, Format = options.Format!, Speed = options.Speed!.Value,
            Instructions = options.Instructions, Emotion = options.Emotion, CharacterCount = chars,
            OfferingId = metadata.OfferingId, ActualModel = metadata.ActualModel, ActualPlatformName = metadata.ActualPlatformName };
        try { await db.SpeechRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None); }
        catch (MongoWriteException ex) when (idem != null && ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            var prior = await GetRunAsync(owner, idem) ?? throw new SpeechException("REQUEST_CONFLICT", "请求冲突，请重试。", 409);
            return Replay(prior, fingerprint);
        }
        return (run, false);
    }

    private static (SpeechRun, bool) Replay(SpeechRun run, string fingerprint)
    {
        if (run.RequestFingerprint != fingerprint) throw new SpeechException("IDEMPOTENCY_CONFLICT", "同一请求标识已用于不同内容，请为新任务使用新的请求标识。", 409);
        return (run, true);
    }

    private static SpeechProfile SelectProfile(SpeechSettings settings, string? id)
        => (id == null ? settings.Profiles.FirstOrDefault(x => x.Enabled && x.IsDefault) : settings.Profiles.FirstOrDefault(x => x.Id == id))
            ?? throw new SpeechException("PROFILE_NOT_FOUND", "当前环境未配置默认语音能力，或所选能力不存在。请在智能体接入台的语音设置中配置。", 503);

    public Task<SpeechRun?> GetRunAsync(string owner, string id) => db.SpeechRuns
        .Find(x => x.Id == id && x.OwnerUserId == owner && x.Environment == EnvironmentId).FirstOrDefaultAsync()!;

    public Task<List<SpeechRun>> ListRunsAsync(string owner, int limit) => db.SpeechRuns
        .Find(x => x.OwnerUserId == owner && x.Environment == EnvironmentId).SortByDescending(x => x.CreatedAt)
        .Limit(Math.Clamp(limit, 1, 100)).ToListAsync();

    public object ToResult(SpeechRun run, bool openApi = false, bool deduplicated = false) => new
    {
        run.Id, runId = run.Id, run.Title, run.Status, run.Stage, run.Text, run.Environment, run.ProfileId, run.ProfileName,
        run.ProfileRevision, run.VoiceId, run.Format, run.Speed, run.Instructions, run.Emotion, run.CharacterCount,
        run.CreatedAt, run.UpdatedAt, run.CompletedAt, run.ActualModel, run.ActualPlatformName, run.OfferingId,
        run.LogId, run.ProviderUsage, run.ErrorCode, run.ErrorMessage, run.AssetId, run.SizeBytes, run.Mime, deduplicated,
        finished = SpeechRunStatus.IsTerminal(run.Status),
        url = $"/mcp-console?tab=speech&run={Uri.EscapeDataString(run.Id)}",
        audioUrl = run.Status == SpeechRunStatus.Completed ? $"/api/{(openApi ? "open/speech" : "mcp-speech")}/runs/{run.Id}/audio" : null,
    };

    public async Task<(byte[] Bytes, string Mime, string FileName)> ReadAudioAsync(string owner, string id)
    {
        var run = await GetRunAsync(owner, id) ?? throw new SpeechException("RUN_NOT_FOUND", "语音任务不存在。", 404);
        if (run.Status != SpeechRunStatus.Completed || run.AssetKey == null) throw new SpeechException("AUDIO_NOT_READY", "音频尚未生成完成。", 409);
        var bytes = await storage.TryDownloadBytesAsync(run.AssetKey, CancellationToken.None)
            ?? throw new SpeechException("AUDIO_NOT_FOUND", "音频文件暂不可用，请联系管理员检查存储。", 503);
        try { bytes = Protector(run).Unprotect(bytes); }
        catch (CryptographicException) { throw new SpeechException("AUDIO_KEY_UNAVAILABLE", "当前环境无法解密该音频，请联系管理员检查持久化密钥。", 503); }
        return (bytes, run.Mime ?? SpeechCapabilityPolicy.MimeFor(run.Format), $"speech-{run.Id}.{(run.Format == "ogg_opus" ? "ogg" : run.Format)}");
    }

    private IDataProtector Protector(SpeechRun run) => protection.CreateProtector("map.mcp-speech.audio.v1", run.Environment, run.OwnerUserId, run.Id);

    public static void ValidateResolution(SpeechProfile profile, GatewayModelResolution resolution, bool allowRebind = false)
    {
        if (!resolution.Success || !string.Equals(resolution.LogicalModelPublicId, profile.ModelPoolId, StringComparison.Ordinal))
            throw new SpeechException("MODEL_UNAVAILABLE", "当前网关无法解析所选语音模型，系统没有切换到其他模型。", 503);
        var protocol = resolution.IsExchange ? resolution.ExchangeTransformerType : resolution.Protocol ?? resolution.PlatformType;
        if (profile.Protocol == "doubao-tts" ? protocol != "doubao-tts" : resolution.IsExchange || protocol != "openai")
            throw new SpeechException("PROTOCOL_MISMATCH", "当前模型路由的协议与语音能力配置不一致，请检查网关配置。", 409);
        if (string.IsNullOrWhiteSpace(resolution.OfferingId))
            throw new SpeechException("ROUTE_NOT_PINNABLE", "当前路由缺少稳定的上游标识，无法保证声音配置，请检查网关。", 503);
        if (!allowRebind && profile.OfferingId != null && profile.OfferingId != resolution.OfferingId)
            throw new SpeechException("VOICE_RESOURCE_CHANGED", "模型当前路由与音色绑定的账号资源不同，系统没有替换资源。请管理员重新核对能力配置。", 409);
        if (!allowRebind && !string.IsNullOrEmpty(profile.Model) && profile.Model != resolution.ActualModel)
            throw new SpeechException("VOICE_MODEL_CHANGED", "语音资源使用的模型已变化，请管理员核对音色和参数后重新保存能力配置。", 409);
    }

    public async Task<bool> ProcessNextAsync(string workerId)
    {
        await RecoverExpiredAsync();
        // 只接管当前进程启动前已入队、未发送上游的同环境任务。旧进程不能认领新构建之后的任务。
        var claimFilter = Builders<SpeechRun>.Filter.Where(x => x.Environment == EnvironmentId
            && (x.DeploymentSlug == DeploymentScope.Current || x.CreatedAt < ProcessStartedAt)
            && x.Status == SpeechRunStatus.Queued);
        var run = await db.SpeechRuns.FindOneAndUpdateAsync<SpeechRun>(claimFilter,
            Builders<SpeechRun>.Update.Set(x => x.Status, SpeechRunStatus.Preparing).Set(x => x.Stage, "检查声音配置与额度")
                .Set(x => x.WorkerId, workerId).Set(x => x.LeaseUntil, DateTime.UtcNow.AddMinutes(6)).Set(x => x.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<SpeechRun, SpeechRun> { ReturnDocument = ReturnDocument.After, Sort = Builders<SpeechRun>.Sort.Ascending(x => x.CreatedAt) });
        if (run == null) return false;
        try
        {
            var currentProfile = (await GetSettingsAsync()).Profiles.FirstOrDefault(x => x.Id == run.ProfileId && x.Enabled);
            if (currentProfile == null || currentProfile.Revision != run.ProfileRevision)
                throw new SpeechException("PROFILE_CHANGED", "生成前语音能力配置发生变化，任务未调用上游。请检查声音配置后重新生成。", 409);
            run.QuotaLedgerId = SpeechQuotaService.LedgerId(run);
            await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<SpeechRun>.Update.Set(x => x.QuotaLedgerId, run.QuotaLedgerId), cancellationToken: CancellationToken.None);
            if (!await quota.ReserveAsync(run))
                throw new SpeechException("SPEECH_QUOTA_EXCEEDED", "当前能力的每日字符额度或并发上限已达到，请稍后再试。每日额度按 UTC 自然日重置。", 429);
            using var scope = contextAccessor.BeginScope(new LlmRequestContext(run.Id, null, null, run.OwnerUserId, null,
                run.CharacterCount, SpeechCapabilityPolicy.Hash(run.Text), null, RequestType: ModelTypes.Tts,
                AppCallerCode: AppCallerRegistry.McpSpeech.Synthesize, RunId: run.Id));
            var resolution = await gateway.ResolveOfferingAsync(AppCallerRegistry.McpSpeech.Synthesize, ModelTypes.Tts,
                run.OfferingId ?? throw new SpeechException("ROUTE_NOT_PINNABLE", "任务缺少已绑定的语音资源，无法执行。"), CancellationToken.None);
            ValidateResolution(run.ProfileSnapshot, resolution);
            run.ActualModel = resolution.ActualModel;
            run.ActualPlatformName = resolution.ActualPlatformName;
            run.OfferingId = resolution.OfferingId;
            run.UpstreamStartedAt = DateTime.UtcNow;
            await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id && x.WorkerId == workerId,
                Builders<SpeechRun>.Update.Set(x => x.Status, SpeechRunStatus.Generating).Set(x => x.Stage, "正在合成语音")
                    .Set(x => x.ActualModel, run.ActualModel).Set(x => x.ActualPlatformName, run.ActualPlatformName)
                    .Set(x => x.OfferingId, run.OfferingId).Set(x => x.UpstreamStartedAt, run.UpstreamStartedAt).Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            var response = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.McpSpeech.Synthesize, ModelType = ModelTypes.Tts,
                ExpectedModel = run.ProfileSnapshot.ModelPoolId, RequiredLogicalModelPublicId = run.ProfileSnapshot.ModelPoolId,
                RequiredOfferingId = resolution.OfferingId, RequestBody = SpeechCapabilityPolicy.BuildRequestBody(run), TimeoutSeconds = 180,
                Context = new GatewayRequestContext { RequestId = run.Id, RunId = run.Id, UserId = run.OwnerUserId,
                    DocumentChars = run.CharacterCount, DocumentHash = SpeechCapabilityPolicy.Hash(run.Text) },
            }, resolution, CancellationToken.None);
            run.LogId = response.LogId;
            if (!string.IsNullOrEmpty(response.Content))
            {
                try
                {
                    using var body = JsonDocument.Parse(response.Content);
                    if (body.RootElement.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
                        run.ProviderUsage = usage.EnumerateObject().Where(x => x.Value.ValueKind == JsonValueKind.Number
                            && x.Value.TryGetInt64(out var n) && n >= 0).Take(16).ToDictionary(x => x.Name, x => x.Value.GetInt64());
                }
                catch (JsonException) { /* 旧网关未返回结构化用量时保持未知，不推算账单。 */ }
            }
            await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<SpeechRun>.Update.Set(x => x.LogId, response.LogId)
                .Set(x => x.ProviderUsage, run.ProviderUsage), cancellationToken: CancellationToken.None);
            if (!response.Success)
            {
                var uncertain = response.StatusCode is 0 or 408 or 499 or 502 or 503 or 504;
                await FinishAsync(run, uncertain ? SpeechRunStatus.Unknown : SpeechRunStatus.Failed,
                    uncertain ? "UPSTREAM_RESULT_UNKNOWN" : response.ErrorCode ?? "SPEECH_GENERATION_FAILED",
                    uncertain ? "上游结果尚不能确认，系统未自动重复生成。请凭任务标识联系管理员核查。"
                        : "上游未完成语音生成，请联系管理员按任务标识检查网关日志。", refund: false);
                return true;
            }
            var audio = response.BinaryContent;
            if (audio == null || audio.Length is 0 or > SpeechCapabilityPolicy.MaxAudioBytes)
                throw new SpeechException("AUDIO_RESPONSE_INVALID", "上游返回的音频为空、格式不正确或超过32MB，请联系管理员检查网关日志。", 502);
            run.Mime = SpeechCapabilityPolicy.MimeFor(run.Format);
            run.SizeBytes = audio.Length;
            run.Status = SpeechRunStatus.Saving;
            var encrypted = Protector(run).Protect(audio);
            var domain = AppDomainPaths.DomainMcpSpeech;
            run.AssetKey = storage.TryBuildContentAddressedKey(encrypted, "application/octet-stream", domain, AppDomainPaths.TypeBin, extensionHint: ".bin");
            await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id && x.WorkerId == workerId,
                Builders<SpeechRun>.Update.Set(x => x.Status, SpeechRunStatus.Saving).Set(x => x.Stage, "正在保存音频资产")
                    .Set(x => x.AssetKey, run.AssetKey).Set(x => x.Mime, run.Mime).Set(x => x.SizeBytes, run.SizeBytes).Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            StoredAsset? stored = null;
            for (var attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    stored = await storage.SaveAsync(encrypted, "application/octet-stream", CancellationToken.None, domain, AppDomainPaths.TypeBin, extensionHint: ".bin");
                    break;
                }
                catch (Exception ex) when (attempt < 2)
                { logger.LogWarning(ex, "Speech audio save retry {RunId} {Attempt}", run.Id, attempt); await Task.Delay(300 * (attempt + 1)); }
            }
            if (stored?.Key == null) throw new SpeechException("AUDIO_SAVE_FAILED", "语音已生成但资产保存失败，系统没有重新调用上游。请联系管理员核查存储。", 503);
            run.AssetKey = stored.Key;
            run.AssetSha256 = stored.Sha256;
            await CompleteAsync(run);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Speech run failed {RunId}", run.Id);
            var known = ex as SpeechException;
            var unknown = run.UpstreamStartedAt != null && run.Status != SpeechRunStatus.Saving && known == null;
            await FinishAsync(run, unknown ? SpeechRunStatus.Unknown : SpeechRunStatus.Failed,
                known?.Code ?? (unknown ? "UPSTREAM_RESULT_UNKNOWN" : "SPEECH_GENERATION_FAILED"),
                known?.Message ?? (unknown ? "执行中断，上游结果尚不能确认，系统没有重复生成。请联系管理员核查。" : "语音任务未完成，请联系管理员按任务标识检查日志。"),
                refund: run.UpstreamStartedAt == null);
        }
        return true;
    }

    private async Task CompleteAsync(SpeechRun run)
    {
        await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id,
            Builders<SpeechRun>.Update.Set(x => x.Status, SpeechRunStatus.Completed).Set(x => x.Stage, "音频已保存到我的资产")
                .Set(x => x.AssetId, $"speech-{run.Id}").Set(x => x.AssetKey, run.AssetKey).Set(x => x.AssetSha256, run.AssetSha256)
                .Set(x => x.ErrorCode, null).Set(x => x.ErrorMessage, null)
                .Set(x => x.CompletedAt, DateTime.UtcNow).Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
        await TryReleaseQuotaAsync(run, refund: false);
    }

    private async Task FinishAsync(SpeechRun run, string status, string code, string message, bool refund)
    {
        await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id,
            Builders<SpeechRun>.Update.Set(x => x.Status, status).Set(x => x.Stage, status == SpeechRunStatus.Unknown ? "结果待核查" : "生成未完成")
                .Set(x => x.ErrorCode, code).Set(x => x.ErrorMessage, message).Set(x => x.CompletedAt, DateTime.UtcNow)
                .Set(x => x.QuotaRefundRequested, refund)
                .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
        await TryReleaseQuotaAsync(run, refund);
    }

    private async Task TryReleaseQuotaAsync(SpeechRun run, bool refund)
    {
        if (run.QuotaLedgerId == null) return;
        try
        {
            await quota.ReleaseAsync(run, refund);
            await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id,
                Builders<SpeechRun>.Update.Set(x => x.QuotaReleased, true), cancellationToken: CancellationToken.None);
        }
        catch (Exception ex) { logger.LogError(ex, "Speech quota release deferred for reconciliation {RunId}", run.Id); }
    }

    private async Task RecoverExpiredAsync()
    {
        // 终态写入与并发槽位释放之间宕机时，幂等补偿释放，不能永久占住账号额度。
        var unsettled = await db.SpeechRuns.Find(x => x.Environment == EnvironmentId && x.QuotaLedgerId != null && !x.QuotaReleased
            && (x.Status == SpeechRunStatus.Completed || x.Status == SpeechRunStatus.Failed || x.Status == SpeechRunStatus.Unknown))
            .Limit(10).ToListAsync();
        foreach (var terminal in unsettled) await TryReleaseQuotaAsync(terminal, terminal.QuotaRefundRequested);
        var expired = await db.SpeechRuns.Find(x => x.Environment == EnvironmentId && x.Status != SpeechRunStatus.Queued
            && x.Status != SpeechRunStatus.Completed && x.Status != SpeechRunStatus.Failed && x.Status != SpeechRunStatus.Unknown
            && x.LeaseUntil < DateTime.UtcNow).Limit(10).ToListAsync();
        foreach (var stale in expired)
        {
            var owner = Guid.NewGuid().ToString("N");
            var claim = await db.SpeechRuns.UpdateOneAsync(x => x.Id == stale.Id && x.LeaseUntil < DateTime.UtcNow,
                Builders<SpeechRun>.Update.Set(x => x.LeaseUntil, DateTime.UtcNow.AddMinutes(6)).Set(x => x.WorkerId, owner), cancellationToken: CancellationToken.None);
            if (claim.ModifiedCount == 0) continue;
            if (stale.Status == SpeechRunStatus.Saving && stale.AssetKey != null && await storage.ExistsAsync(stale.AssetKey, CancellationToken.None))
                await CompleteAsync(stale);
            else await FinishAsync(stale, stale.UpstreamStartedAt == null ? SpeechRunStatus.Failed : SpeechRunStatus.Unknown,
                "WORKER_INTERRUPTED", "执行进程已中断，系统没有重新调用上游。请联系管理员按任务标识核查。", stale.UpstreamStartedAt == null);
        }
    }
}
