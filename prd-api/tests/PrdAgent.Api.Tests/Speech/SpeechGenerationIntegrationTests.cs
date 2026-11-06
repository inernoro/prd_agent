using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.Assets;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Speech;

[CollectionDefinition("Speech environment isolation", DisableParallelization = true)]
public sealed class SpeechEnvironmentIsolationCollection { }

/// <summary>只使用显式启动的本地测试Mongo；每例独立随机数据库，不读取现有业务数据。</summary>
[Trait("Category", "Integration")]
[Collection("Speech environment isolation")]
public sealed class SpeechGenerationIntegrationTests : IAsyncLifetime
{
    private const string MongoConnection = "mongodb://127.0.0.1:27088/?serverSelectionTimeoutMS=5000";
    private readonly string databaseName = $"map_speech_test_{Guid.NewGuid():N}";
    private readonly string? previousProject = Environment.GetEnvironmentVariable("CDS_PROJECT_ID");
    private readonly MongoDbContext db;
    private readonly Mock<ILlmGateway> gateway = new();
    private readonly EphemeralDataProtectionProvider protection = new();
    private readonly MemoryStorage storage = new();
    private readonly TestHost host = new() { EnvironmentName = "SpeechTestEnvironmentA" };
    private readonly List<GatewayRawRequest> sent = new();
    private GatewayRawResponse upstream = new()
    {
        Success = true, StatusCode = 200, ContentType = "audio/mpeg", LogId = "test-gateway-log",
        // 100ms 的单声道静音 MP3；不依赖付费上游，也不把仅有文件头的字节当音频。
        BinaryContent = Convert.FromBase64String("SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAzAAAAAAAAAAAAAAD/4xjEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEOwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEdgAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEsQAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU="),
    };
    private GatewayModelResolution resolution = Resolution("openai");
    private SpeechGenerationService service;

    public SpeechGenerationIntegrationTests()
    {
        Environment.SetEnvironmentVariable("CDS_PROJECT_ID", null);
        db = new MongoDbContext(MongoConnection, databaseName);
        gateway.Setup(x => x.GetAvailablePoolsAsync(It.IsAny<string>(), ModelTypes.Tts, It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => new() { new() { Code = "future-unconfigured-tts-model", Name = "未来语音模型" } });
        gateway.Setup(x => x.ResolveModelMetadataAsync(It.IsAny<string>(), ModelTypes.Tts, It.IsAny<string>(),
                It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => resolution);
        gateway.Setup(x => x.ResolveRequiredLogicalModelAsync(It.IsAny<string>(), ModelTypes.Tts,
                It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => resolution);
        gateway.Setup(x => x.ResolveOfferingAsync(It.IsAny<string>(), ModelTypes.Tts,
                It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => resolution);
        gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Callback<GatewayRawRequest, GatewayModelResolution, CancellationToken>((request, _, _) => sent.Add(request))
            .ReturnsAsync(() => upstream);
        service = Service(host);
    }

    public async Task InitializeAsync() => await db.SpeechRuns.CountDocumentsAsync(FilterDefinition<SpeechRun>.Empty);
    public async Task DisposeAsync()
    {
        await new MongoClient(MongoConnection).DropDatabaseAsync(databaseName);
        Environment.SetEnvironmentVariable("CDS_PROJECT_ID", previousProject);
    }

    private SpeechGenerationService Service(IHostEnvironment environment) => new(db, gateway.Object,
        new LLMRequestContextAccessor(), protection, storage, new SpeechQuotaService(db), environment,
        NullLogger<SpeechGenerationService>.Instance);

    private static GatewayModelResolution Resolution(string protocol, string offering = "pinned-offering", string model = "future-supplier-model") => new()
    {
        Success = true, LogicalModelPublicId = "future-unconfigured-tts-model", OfferingId = offering,
        ActualModel = model, ActualPlatformName = "测试上游", Protocol = "openai",
        IsExchange = protocol == "doubao-tts", ExchangeTransformerType = protocol == "doubao-tts" ? protocol : null,
    };

    private async Task<SpeechProfile> ConfigureAsync(string protocol = "openai")
    {
        resolution = Resolution(protocol);
        var profile = SpeechCapabilityPolicyTests.Profile(protocol);
        if (protocol == "openai") profile.SupportsInstructions = true;
        else { profile.SupportsEmotion = true; profile.Emotions = new() { "happy" }; }
        return (await service.SaveSettingsAsync(0, new() { profile })).Profiles.Single();
    }

    [Theory]
    [InlineData("openai")]
    [InlineData("doubao-tts")]
    public async Task GenerateStoresEncryptedAudioAndPublishesOwnedAsset(string protocol)
    {
        var profile = await ConfigureAsync(protocol);
        const string original = "  这段文字必须原样朗读。\n保留换行。";
        var request = new SpeechCreateRequest
        {
            Text = original, ProfileId = profile.Id, ProfileRevision = profile.Revision, ClientRequestId = "request-1",
            Instructions = protocol == "openai" ? "平缓朗读" : null,
            Emotion = protocol == "doubao-tts" ? "happy" : null,
        };
        var created = await service.CreateAsync("owner-a", "client-a", request);
        Assert.False(created.Deduplicated);
        Assert.True(await service.ProcessNextAsync("worker-a"));
        var run = (await service.GetRunAsync("owner-a", created.Run.Id))!;
        Assert.Equal(SpeechRunStatus.Completed, run.Status);
        Assert.Equal(original, run.Text);
        Assert.Equal("test-gateway-log", run.LogId);
        Assert.Equal($"speech-{run.Id}", run.AssetId);
        Assert.Single(storage.Objects);
        Assert.False(upstream.BinaryContent!.SequenceEqual(storage.Objects.Values.Single()));
        var audio = await service.ReadAudioAsync("owner-a", run.Id);
        Assert.Equal(upstream.BinaryContent, audio.Bytes);
        Assert.Equal("audio/mpeg", audio.Mime);
        var lostKeyService = new SpeechGenerationService(db, gateway.Object, new LLMRequestContextAccessor(),
            new EphemeralDataProtectionProvider(), storage, new SpeechQuotaService(db), host,
            NullLogger<SpeechGenerationService>.Instance);
        Assert.Equal("AUDIO_KEY_UNAVAILABLE", (await Assert.ThrowsAsync<SpeechException>(() =>
            lostKeyService.ReadAudioAsync("owner-a", run.Id))).Code);
        Assert.Equal("RUN_NOT_FOUND", (await Assert.ThrowsAsync<SpeechException>(() => service.ReadAudioAsync("other-owner", run.Id))).Code);
        var assets = await new SpeechAssetProvider(db, host).GetAssetsAsync("owner-a", 20, default);
        var asset = Assert.Single(assets);
        Assert.Equal("audio", asset.Type);
        Assert.Equal($"/api/mcp-speech/runs/{run.Id}/audio", asset.Url);
        Assert.Empty(await new SpeechAssetProvider(db, host).GetAssetsAsync("other-owner", 20, default));
        var actual = Assert.Single(sent);
        Assert.Equal("pinned-offering", actual.RequiredOfferingId);
        Assert.Equal(profile.ModelPoolId, actual.RequiredLogicalModelPublicId);
        Assert.Equal(original, actual.RequestBody!["input"]!.GetValue<string>());
        Assert.Equal(protocol == "openai" ? "平缓朗读" : null, actual.RequestBody["instructions"]?.GetValue<string>());
        Assert.Equal(protocol == "doubao-tts" ? "happy" : null, actual.RequestBody["emotion"]?.GetValue<string>());
        Assert.Equal("owner-a", actual.Context!.UserId);
        var ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(run.CharacterCount, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
    }

    [Fact]
    public async Task ConcurrentIdempotentCreatesProduceOneRunAndChangedContentConflicts()
    {
        await ConfigureAsync();
        var request = new SpeechCreateRequest { Text = "完全相同的请求", ClientRequestId = "one-logical-request" };
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => service.CreateAsync("owner-a", "client-a", request)));
        Assert.Single(results.Select(x => x.Run.Id).Distinct());
        Assert.Single(results.Where(x => !x.Deduplicated));
        Assert.Equal(1, await db.SpeechRuns.CountDocumentsAsync(FilterDefinition<SpeechRun>.Empty));
        var conflict = await Assert.ThrowsAsync<SpeechException>(() => service.CreateAsync("owner-a", "client-a",
            new() { Text = "已经改变的请求", ClientRequestId = "one-logical-request" }));
        Assert.Equal("IDEMPOTENCY_CONFLICT", conflict.Code);
        Assert.Empty(sent);
    }

    [Fact]
    public async Task UpstreamTimeoutRemainsUnknownAndCannotBeAutomaticallyRetried()
    {
        await ConfigureAsync();
        upstream = new() { Success = false, StatusCode = 504, ErrorCode = "TIMEOUT", LogId = "timeout-log" };
        var request = new SpeechCreateRequest { Text = "可能已计费的朗读请求", ClientRequestId = "timeout-request" };
        var created = await service.CreateAsync("owner-a", "client-a", request);
        Assert.True(await service.ProcessNextAsync("worker-a"));
        var run = (await service.GetRunAsync("owner-a", created.Run.Id))!;
        Assert.Equal(SpeechRunStatus.Unknown, run.Status);
        Assert.Equal("UPSTREAM_RESULT_UNKNOWN", run.ErrorCode);
        Assert.False(await service.ProcessNextAsync("worker-b"));
        var replay = await service.CreateAsync("owner-a", "client-a", request);
        Assert.True(replay.Deduplicated);
        Assert.Equal(SpeechRunStatus.Unknown, replay.Run.Status);
        Assert.Single(sent);
        Assert.Empty(storage.Objects);
        var ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(run.CharacterCount, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
    }

    [Fact]
    public async Task FailedRouteBeforePhysicalCallRefundsCharacterReservation()
    {
        await ConfigureAsync();
        var created = await service.CreateAsync("owner-a", null, new() { Text = "路由变化不得错误发送" });
        resolution = new() { Success = false };
        Assert.True(await service.ProcessNextAsync("worker-a"));
        var run = (await service.GetRunAsync("owner-a", created.Run.Id))!;
        Assert.Equal(SpeechRunStatus.Failed, run.Status);
        Assert.Equal("MODEL_UNAVAILABLE", run.ErrorCode);
        Assert.Empty(sent);
        var ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(0, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
    }

    [Fact]
    public async Task ChangedProfileInvalidatesPresetAndOptimisticUpdateRejectsStaleSettings()
    {
        var profile = await ConfigureAsync();
        var preset = await service.SavePresetAsync("owner-a", new() { Name = "旁白", ProfileId = profile.Id, ProfileRevision = profile.Revision });
        var settings = await service.GetSettingsAsync();
        settings.Profiles.Single().Name = "已更新的能力";
        await service.SaveSettingsAsync(settings.Revision, settings.Profiles);
        Assert.Equal("PRESET_STALE", (await Assert.ThrowsAsync<SpeechException>(() =>
            service.CreateAsync("owner-a", null, new() { Text = "原文", PresetId = preset.Id }))).Code);
        Assert.Equal("SETTINGS_CHANGED", (await Assert.ThrowsAsync<SpeechException>(() =>
            service.SaveSettingsAsync(settings.Revision, settings.Profiles))).Code);
        Assert.Equal("PRESET_NOT_FOUND", (await Assert.ThrowsAsync<SpeechException>(() =>
            service.CreateAsync("other-owner", null, new() { Text = "原文", PresetId = preset.Id }))).Code);
        Assert.Empty(sent);
    }

    [Fact]
    public async Task EnvironmentIsolatesSettingsPresetsRunsAndAssets()
    {
        var profile = await ConfigureAsync();
        await service.SavePresetAsync("owner-a", new() { Name = "旁白", ProfileId = profile.Id });
        var created = await service.CreateAsync("owner-a", null, new() { Text = "环境隔离的音频" });
        await service.ProcessNextAsync("worker-a");
        var environmentB = new TestHost { EnvironmentName = "SpeechTestEnvironmentB" };
        var otherService = Service(environmentB);
        Assert.Empty((await otherService.GetSettingsAsync()).Profiles);
        Assert.Empty(await otherService.GetPresetsAsync("owner-a"));
        Assert.Empty(await otherService.ListRunsAsync("owner-a", 30));
        Assert.Null(await otherService.GetRunAsync("owner-a", created.Run.Id));
        Assert.Empty(await new SpeechAssetProvider(db, environmentB).GetAssetsAsync("owner-a", 30, default));
        Assert.Equal("RUN_NOT_FOUND", (await Assert.ThrowsAsync<SpeechException>(() => otherService.ReadAudioAsync("owner-a", created.Run.Id))).Code);
    }

    [Fact]
    public async Task DeletedAndRecreatedProfileDoesNotReviveOldPreset()
    {
        var profile = await ConfigureAsync();
        var preset = await service.SavePresetAsync("owner-a", new() { Name = "旧旁白", ProfileId = profile.Id });
        var settings = await service.GetSettingsAsync();
        var removed = await service.SaveSettingsAsync(settings.Revision, new());
        var recreated = await service.SaveSettingsAsync(removed.Revision, new() { SpeechCapabilityPolicyTests.Profile() });
        Assert.True(recreated.Profiles.Single().Revision > preset.ProfileRevision);
        Assert.Equal("PRESET_STALE", (await Assert.ThrowsAsync<SpeechException>(() =>
            service.CreateAsync("owner-a", null, new() { Text = "原文", PresetId = preset.Id }))).Code);
    }

    [Fact]
    public async Task ConcurrentQuotaReservationIsAtomicAndReleaseIsExactlyOnce()
    {
        var quota = new SpeechQuotaService(db);
        var profile = SpeechCapabilityPolicyTests.Profile();
        profile.DailyCharacterQuota = 10;
        profile.MaxConcurrentRuns = 10;
        var runs = Enumerable.Range(0, 20).Select(_ => new SpeechRun
        {
            Environment = "quota-test", OwnerUserId = "owner-a", ProfileId = profile.Id,
            ProfileSnapshot = profile, CharacterCount = 3,
        }).ToList();
        var decisions = await Task.WhenAll(runs.Select(run => quota.ReserveAsync(run)));
        Assert.Equal(3, decisions.Count(x => x));
        var ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(9, ledger.Characters);
        Assert.Equal(3, ledger.ActiveRuns);
        var admitted = runs.Where((_, index) => decisions[index]).ToList();
        await Task.WhenAll(admitted.SelectMany(run => new[] { quota.ReleaseAsync(run, true), quota.ReleaseAsync(run, true) }));
        ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(0, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
    }

    [Fact]
    public async Task MidnightResetPreservesConcurrencyAndDoesNotRefundYesterdayIntoToday()
    {
        var quota = new SpeechQuotaService(db);
        var profile = SpeechCapabilityPolicyTests.Profile();
        profile.DailyCharacterQuota = 10;
        profile.MaxConcurrentRuns = 1;
        var old = new SpeechRun { Environment = "quota-test", OwnerUserId = "owner-a", ProfileId = profile.Id,
            ProfileSnapshot = profile, CharacterCount = 3 };
        Assert.True(await quota.ReserveAsync(old));
        var yesterday = DateTime.UtcNow.AddDays(-1).ToString("yyyy-MM-dd");
        await db.SpeechQuotaLedgers.UpdateOneAsync(x => x.Id == old.QuotaLedgerId,
            Builders<SpeechQuotaLedger>.Update.Set(x => x.Day, yesterday).Set($"Reservations.{old.Id}.Day", yesterday));
        var today = new SpeechRun { Environment = old.Environment, OwnerUserId = old.OwnerUserId, ProfileId = profile.Id,
            ProfileSnapshot = profile, CharacterCount = 3 };
        Assert.False(await quota.ReserveAsync(today));
        var ledger = await db.SpeechQuotaLedgers.Find(x => x.Id == old.QuotaLedgerId).SingleAsync();
        Assert.Equal(0, ledger.Characters);
        Assert.Equal(1, ledger.ActiveRuns);
        await quota.ReleaseAsync(old, true);
        ledger = await db.SpeechQuotaLedgers.Find(x => x.Id == old.QuotaLedgerId).SingleAsync();
        Assert.Equal(0, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
        Assert.Empty(ledger.Reservations);
        Assert.True(await quota.ReserveAsync(today));
        ledger = await db.SpeechQuotaLedgers.Find(x => x.Id == old.QuotaLedgerId).SingleAsync();
        Assert.Equal(3, ledger.Characters);
        Assert.Equal(1, ledger.ActiveRuns);
    }

    [Theory]
    [InlineData("offering", "VOICE_RESOURCE_CHANGED")]
    [InlineData("model", "VOICE_MODEL_CHANGED")]
    [InlineData("protocol", "PROTOCOL_MISMATCH")]
    public async Task RouteChangesCannotSilentlyReplaceTheSubmittedVoice(string change, string expectedCode)
    {
        await ConfigureAsync();
        var created = await service.CreateAsync("owner-a", null, new() { Text = "声音必须保持提交时的资源" });
        resolution = change switch
        {
            "offering" => Resolution("openai", offering: "other-account-offering"),
            "model" => Resolution("openai", model: "other-model"),
            _ => Resolution("doubao-tts"),
        };
        await service.ProcessNextAsync("worker-a");
        var run = (await service.GetRunAsync("owner-a", created.Run.Id))!;
        Assert.Equal(SpeechRunStatus.Failed, run.Status);
        Assert.Equal(expectedCode, run.ErrorCode);
        Assert.Empty(sent);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InterruptedWorkerRecoversSavedAudioOrMarksUnknownWithoutRegenerating(bool saved)
    {
        await ConfigureAsync();
        var run = (await service.CreateAsync("owner-a", null, new() { Text = "恢复任务不得再次调用上游" })).Run;
        Assert.True(await new SpeechQuotaService(db).ReserveAsync(run));
        run.UpstreamStartedAt = DateTime.UtcNow.AddMinutes(-8);
        run.Status = saved ? SpeechRunStatus.Saving : SpeechRunStatus.Generating;
        run.LeaseUntil = DateTime.UtcNow.AddMinutes(-1);
        run.WorkerId = "interrupted-worker";
        if (saved)
        {
            var encrypted = protection.CreateProtector("map.mcp-speech.audio.v1", run.Environment, run.OwnerUserId, run.Id)
                .Protect(upstream.BinaryContent!);
            var stored = await storage.SaveAsync(encrypted, "application/octet-stream", default, "private", "audio");
            run.AssetKey = stored.Key;
            run.Mime = "audio/mpeg";
            run.SizeBytes = upstream.BinaryContent!.Length;
        }
        await db.SpeechRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        Assert.False(await service.ProcessNextAsync("recovery-worker"));
        var recovered = (await service.GetRunAsync("owner-a", run.Id))!;
        Assert.Equal(saved ? SpeechRunStatus.Completed : SpeechRunStatus.Unknown, recovered.Status);
        if (saved) Assert.Equal(upstream.BinaryContent, (await service.ReadAudioAsync("owner-a", run.Id)).Bytes);
        else Assert.Equal("WORKER_INTERRUPTED", recovered.ErrorCode);
        Assert.Empty(sent);
        var ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(run.CharacterCount, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TerminalRunResumesQuotaSettlementAfterCrash(bool refund)
    {
        await ConfigureAsync();
        var run = (await service.CreateAsync("owner-a", null, new() { Text = "终态与额度释放之间的中断" })).Run;
        Assert.True(await new SpeechQuotaService(db).ReserveAsync(run));
        run.Status = refund ? SpeechRunStatus.Failed : SpeechRunStatus.Unknown;
        run.QuotaRefundRequested = refund;
        if (!refund) run.UpstreamStartedAt = DateTime.UtcNow.AddMinutes(-1);
        await db.SpeechRuns.ReplaceOneAsync(x => x.Id == run.Id, run);
        Assert.False(await service.ProcessNextAsync("recovery-worker"));
        var settled = (await service.GetRunAsync("owner-a", run.Id))!;
        Assert.True(settled.QuotaReleased);
        var ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(refund ? 0 : run.CharacterCount, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
        Assert.Empty(ledger.Reservations);
        Assert.False(await service.ProcessNextAsync("another-worker"));
        ledger = await db.SpeechQuotaLedgers.Find(FilterDefinition<SpeechQuotaLedger>.Empty).SingleAsync();
        Assert.Equal(refund ? 0 : run.CharacterCount, ledger.Characters);
        Assert.Equal(0, ledger.ActiveRuns);
        Assert.Empty(sent);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task WorkerOnlyTakesOtherDeploymentQueuedJobsThatPredateStartup(bool predatesStartup)
    {
        await ConfigureAsync();
        var run = (await service.CreateAsync("owner-a", null, new() { Text = "同环境部署升级时接管旧的排队任务" })).Run;
        await db.SpeechRuns.UpdateOneAsync(x => x.Id == run.Id,
            Builders<SpeechRun>.Update.Set(x => x.DeploymentSlug, "other-deployment-revision")
                .Set(x => x.CreatedAt, predatesStartup ? DateTime.UtcNow.AddHours(-1) : DateTime.UtcNow));
        Assert.Equal(predatesStartup, await service.ProcessNextAsync("new-worker"));
        var result = (await service.GetRunAsync("owner-a", run.Id))!;
        Assert.Equal(predatesStartup ? SpeechRunStatus.Completed : SpeechRunStatus.Queued, result.Status);
        Assert.Equal(predatesStartup ? 1 : 0, sent.Count);
    }

    private sealed class TestHost : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "SpeechTests";
        public string ApplicationName { get; set; } = "SpeechTests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class MemoryStorage : IAssetStorage
    {
        public ConcurrentDictionary<string, byte[]> Objects { get; } = new();
        public string? TryBuildContentAddressedKey(byte[] bytes, string mime, string? domain = null, string? type = null,
            string? fileName = null, string? extensionHint = null) => $"{domain}/{type}/{Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()}{extensionHint}";
        public Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null,
            string? type = null, string? fileName = null, string? extensionHint = null)
        {
            var key = TryBuildContentAddressedKey(bytes, mime, domain, type, fileName, extensionHint)!;
            Objects[key] = bytes.ToArray();
            return Task.FromResult(new StoredAsset(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), "https://unused.invalid/", bytes.Length, mime, key));
        }
        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
            => Task.FromResult(Objects.TryGetValue(key, out var bytes) ? bytes.ToArray() : null);
        public Task<bool> ExistsAsync(string key, CancellationToken ct) => Task.FromResult(Objects.ContainsKey(key));
        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => Task.FromResult<(byte[], string)?>(null);
        public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null) => Task.CompletedTask;
        public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null) => null;
        public Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null)
        { Objects[key] = bytes.ToArray(); return Task.CompletedTask; }
        public string BuildUrlForKey(string key) => $"https://unused.invalid/{key}";
        public Task DeleteByKeyAsync(string key, CancellationToken ct) { Objects.TryRemove(key, out _); return Task.CompletedTask; }
        public string BuildSiteKey(string siteId, string filePath) => $"{siteId}/{filePath}";
    }
}
