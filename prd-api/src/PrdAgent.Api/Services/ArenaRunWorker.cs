using System.Text;
using System.Text.Json;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using MongoDB.Driver;

namespace PrdAgent.Api.Services;

/// <summary>
/// 竞技场 Run 后台执行器：将多模型并行 LLM 调用与 HTTP SSE 连接解耦。
/// 前端通过 afterSeq 实现断线重连，刷新页面不丢失已生成内容。
/// </summary>
public sealed class ArenaRunWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunQueue _queue;
    private readonly IRunEventStore _runStore;
    private readonly IConfiguration _config;
    private readonly ILogger<ArenaRunWorker> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ArenaRunWorker(
        IServiceScopeFactory scopeFactory,
        IRunQueue queue,
        IRunEventStore runStore,
        IConfiguration config,
        ILogger<ArenaRunWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _queue = queue;
        _runStore = runStore;
        _config = config;
        _logger = logger;
    }

    private sealed record ArenaRunInput(
        string Prompt,
        string GroupKey,
        List<ArenaSlotInput> Slots,
        string UserId);

    private sealed record ArenaSlotInput(
        string SlotId,
        string PlatformId,
        string ModelId,
        string Label,
        int LabelIndex);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            string? runId = null;
            try
            {
                runId = await _queue.DequeueAsync(RunKinds.Arena, TimeSpan.FromSeconds(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "ArenaRunWorker dequeue failed");
            }

            if (string.IsNullOrWhiteSpace(runId))
            {
                try { await Task.Delay(300, stoppingToken); }
                catch (OperationCanceledException) { break; }
                continue;
            }

            try
            {
                await ProcessRunAsync(runId.Trim(), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "ArenaRunWorker process failed: {RunId}", runId);
                try
                {
                    var meta = await _runStore.GetRunAsync(RunKinds.Arena, runId, CancellationToken.None);
                    if (meta != null)
                    {
                        meta.Status = RunStatuses.Error;
                        meta.EndedAt = DateTime.UtcNow;
                        meta.ErrorCode = ErrorCodes.INTERNAL_ERROR;
                        meta.ErrorMessage = ex.Message;
                        await _runStore.SetRunAsync(RunKinds.Arena, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "run",
                            new { type = "error", errorCode = ErrorCodes.INTERNAL_ERROR, errorMessage = ex.Message },
                            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                    }
                }
                catch { /* ignore */ }
            }
        }
    }

    private static ArenaRunInput? ParseInput(string? inputJson)
    {
        if (string.IsNullOrWhiteSpace(inputJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(inputJson);
            var root = doc.RootElement;
            var prompt = root.TryGetProperty("prompt", out var p) ? (p.GetString() ?? "") : "";
            var groupKey = root.TryGetProperty("groupKey", out var gk) ? (gk.GetString() ?? "") : "";
            var userId = root.TryGetProperty("userId", out var uid) ? (uid.GetString() ?? "") : "";

            var slots = new List<ArenaSlotInput>();
            if (root.TryGetProperty("slots", out var slotsArr) && slotsArr.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in slotsArr.EnumerateArray())
                {
                    var slotId = s.TryGetProperty("slotId", out var si) ? (si.GetString() ?? "") : "";
                    var platformId = s.TryGetProperty("platformId", out var pi) ? (pi.GetString() ?? "") : "";
                    var modelId = s.TryGetProperty("modelId", out var mi) ? (mi.GetString() ?? "") : "";
                    var label = s.TryGetProperty("label", out var lb) ? (lb.GetString() ?? "") : "";
                    var labelIndex = s.TryGetProperty("labelIndex", out var li) && li.TryGetInt32(out var liVal) ? liVal : 0;
                    if (!string.IsNullOrWhiteSpace(slotId) && !string.IsNullOrWhiteSpace(platformId) && !string.IsNullOrWhiteSpace(modelId))
                        slots.Add(new ArenaSlotInput(slotId.Trim(), platformId.Trim(), modelId.Trim(), label.Trim(), labelIndex));
                }
            }

            if (string.IsNullOrWhiteSpace(prompt) || slots.Count == 0) return null;
            return new ArenaRunInput(prompt.Trim(), groupKey.Trim(), slots, userId.Trim());
        }
        catch { return null; }
    }

    private async Task ProcessRunAsync(string runId, CancellationToken stoppingToken)
    {
        var meta = await _runStore.GetRunAsync(RunKinds.Arena, runId, stoppingToken);
        if (meta == null) return;
        if (meta.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled) return;

        var input = ParseInput(meta.InputJson);
        if (input == null)
        {
            meta.Status = RunStatuses.Error;
            meta.EndedAt = DateTime.UtcNow;
            meta.ErrorCode = ErrorCodes.INVALID_FORMAT;
            meta.ErrorMessage = "arena run input 为空或不合法";
            await _runStore.SetRunAsync(RunKinds.Arena, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            await _runStore.AppendEventAsync(RunKinds.Arena, runId, "run",
                new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = meta.ErrorMessage },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            return;
        }

        meta.Status = RunStatuses.Running;
        meta.StartedAt = DateTime.UtcNow;
        await _runStore.SetRunAsync(RunKinds.Arena, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);

        // Emit runStart event
        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "run",
            new { type = "runStart", runId },
            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var httpClientFactory = scope.ServiceProvider.GetRequiredService<IHttpClientFactory>();
        var logWriter = scope.ServiceProvider.GetRequiredService<ILlmRequestLogWriter>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();
        var claudeLogger = scope.ServiceProvider.GetRequiredService<ILogger<ClaudeClient>>();
        var jwtSecret = _config["Jwt:Secret"] ?? "";

        // Check for cancel
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        _ = Task.Run(async () =>
        {
            while (!cts.IsCancellationRequested && !stoppingToken.IsCancellationRequested)
            {
                try
                {
                    if (await _runStore.IsCancelRequestedAsync(RunKinds.Arena, runId, CancellationToken.None))
                    {
                        cts.Cancel();
                        break;
                    }
                }
                catch { /* ignore */ }
                await Task.Delay(200);
            }
        }, CancellationToken.None);

        // Per-slot snapshot accumulators
        var slotTexts = new Dictionary<string, StringBuilder>();
        foreach (var slot in input.Slots)
            slotTexts[slot.SlotId] = new StringBuilder();

        var lastSnapshotAt = DateTime.UtcNow;
        var lastSnapshotSeq = 0L;

        // Process all slots in parallel
        var sem = new SemaphoreSlim(Math.Min(input.Slots.Count, 20), Math.Min(input.Slots.Count, 20));
        var tasks = new List<Task>();

        foreach (var slot in input.Slots)
        {
            tasks.Add(Task.Run(async () =>
            {
                await sem.WaitAsync(CancellationToken.None);
                try
                {
                    await RunOneSlotAsync(runId, slot, input.Prompt, db, httpClientFactory, logWriter, ctxAccessor, claudeLogger, jwtSecret, slotTexts, cts.Token);
                }
                catch (OperationCanceledException) { /* expected on cancel */ }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "ArenaRunWorker slot failed: {RunId}/{SlotId}", runId, slot.SlotId);
                    try
                    {
                        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                            new { type = "modelError", slotId = slot.SlotId, errorCode = "LLM_ERROR", errorMessage = ex.Message },
                            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                    }
                    catch { /* ignore */ }
                }
                finally
                {
                    sem.Release();
                }
            }, CancellationToken.None));
        }

        try
        {
            await Task.WhenAll(tasks);
        }
        catch { /* individual errors already handled */ }

        // Write final snapshot with all slot texts
        await WriteFinalSnapshotAsync(runId, slotTexts, input);

        // Final status
        var cancel = await _runStore.IsCancelRequestedAsync(RunKinds.Arena, runId, CancellationToken.None);
        if (cancel)
        {
            meta.Status = RunStatuses.Cancelled;
        }
        else
        {
            meta.Status = RunStatuses.Done;
        }
        meta.EndedAt = DateTime.UtcNow;
        await _runStore.SetRunAsync(RunKinds.Arena, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);

        // runDone event
        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "run",
            new { type = "runDone", runId, status = meta.Status },
            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);

        // Save battle to MongoDB for history
        try
        {
            var battle = new ArenaBattle
            {
                UserId = input.UserId,
                Prompt = input.Prompt,
                GroupKey = input.GroupKey,
                Responses = input.Slots.Select(slot =>
                {
                    var text = slotTexts.TryGetValue(slot.SlotId, out var sb) ? sb.ToString() : "";
                    return new ArenaBattleResponse
                    {
                        SlotId = slot.SlotId,
                        Label = slot.Label,
                        PlatformId = slot.PlatformId,
                        ModelId = slot.ModelId,
                        Content = text,
                        Status = string.IsNullOrEmpty(text) ? "error" : "done",
                    };
                }).ToList(),
                Revealed = false,
                CreatedAt = DateTime.UtcNow
            };
            await db.ArenaBattles.InsertOneAsync(battle, cancellationToken: CancellationToken.None);

            // Store battleId in run meta for frontend retrieval
            meta.InputJson = JsonSerializer.Serialize(new
            {
                prompt = input.Prompt,
                groupKey = input.GroupKey,
                userId = input.UserId,
                slots = input.Slots,
                battleId = battle.Id
            }, JsonOptions);
            await _runStore.SetRunAsync(RunKinds.Arena, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "ArenaRunWorker failed to save battle: {RunId}", runId);
        }
    }

    private async Task RunOneSlotAsync(
        string runId,
        ArenaSlotInput slot,
        string prompt,
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        ILlmRequestLogWriter logWriter,
        ILLMRequestContextAccessor ctxAccessor,
        ILogger<ClaudeClient> claudeLogger,
        string jwtSecret,
        Dictionary<string, StringBuilder> slotTexts,
        CancellationToken ct)
    {
        // Resolve platform + model
        var platform = await db.LLMPlatforms.Find(p => p.Id == slot.PlatformId).FirstOrDefaultAsync(CancellationToken.None);
        if (platform == null || !platform.Enabled)
        {
            await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                new { type = "modelStart", slotId = slot.SlotId },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                new { type = "modelError", slotId = slot.SlotId, errorCode = "PLATFORM_NOT_FOUND", errorMessage = "平台不存在或未启用" },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            return;
        }

        var apiUrl = platform.ApiUrl;
        var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
        var platformType = platform.PlatformType?.ToLowerInvariant();

        // Check if model exists in llm_models for override config
        var model = await db.LLMModels.Find(m => m.PlatformId == slot.PlatformId && m.ModelName == slot.ModelId).FirstOrDefaultAsync(CancellationToken.None);
        if (model != null)
        {
            if (!string.IsNullOrEmpty(model.ApiUrl)) apiUrl = model.ApiUrl;
            if (!string.IsNullOrEmpty(model.ApiKeyEncrypted))
                apiKey = ApiKeyCrypto.Decrypt(model.ApiKeyEncrypted, jwtSecret);
        }

        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                new { type = "modelStart", slotId = slot.SlotId },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                new { type = "modelError", slotId = slot.SlotId, errorCode = "INVALID_CONFIG", errorMessage = "API 配置不完整" },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            return;
        }

        var httpClient = httpClientFactory.CreateClient("LoggedHttpClient");
        httpClient.BaseAddress = new Uri(apiUrl.TrimEnd('/'));

        ILLMClient client = platformType == "anthropic" || apiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase)
            ? new ClaudeClient(httpClient, apiKey, slot.ModelId, 4096, 0.2, false, claudeLogger, logWriter, ctxAccessor, platform.Id, platform.Name)
            : new OpenAIClient(httpClient, apiKey, slot.ModelId, 4096, 0.2, false, logWriter, ctxAccessor, null, platform.Id, platform.Name);

        // Emit modelStart
        var startedAt = DateTime.UtcNow;
        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
            new { type = "modelStart", slotId = slot.SlotId },
            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);

        var messages = new List<LLMMessage> { new() { Role = "user", Content = prompt } };
        var sb = slotTexts[slot.SlotId];
        var sawFirstDelta = false;

        try
        {
            await foreach (var chunk in client.StreamGenerateAsync("", messages, false, CancellationToken.None))
            {
                if (ct.IsCancellationRequested) break;

                // thinking / reasoning tokens (DeepSeek, QwQ, etc.)
                if (chunk.Type == "thinking" && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (!sawFirstDelta)
                    {
                        sawFirstDelta = true;
                        var ttftMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                            new { type = "firstToken", slotId = slot.SlotId, ttftMs },
                            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                    }

                    await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                        new { type = "thinking", slotId = slot.SlotId, content = chunk.Content },
                        ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                }

                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (!sawFirstDelta)
                    {
                        sawFirstDelta = true;
                        var ttftMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                            new { type = "firstToken", slotId = slot.SlotId, ttftMs },
                            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                    }

                    sb.Append(chunk.Content);

                    await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                        new { type = "delta", slotId = slot.SlotId, content = chunk.Content },
                        ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                }

                if (chunk.Type == "error")
                {
                    throw new InvalidOperationException(chunk.ErrorMessage ?? "LLM_ERROR");
                }

                if (chunk.Type == "done")
                {
                    continue; // let iterator finish naturally
                }
            }
        }
        catch (OperationCanceledException)
        {
            // cancel requested
            await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                new { type = "modelError", slotId = slot.SlotId, errorCode = "CANCELLED", errorMessage = "请求已被取消" },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            return;
        }
        catch (Exception ex)
        {
            await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
                new { type = "modelError", slotId = slot.SlotId, errorCode = "LLM_ERROR", errorMessage = ex.Message },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            return;
        }

        var totalMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
        var ttftFinal = sawFirstDelta ? (long?)null : totalMs;

        await _runStore.AppendEventAsync(RunKinds.Arena, runId, "model",
            new { type = "modelDone", slotId = slot.SlotId, totalMs, ttftMs = ttftFinal },
            ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
    }

    private async Task WriteFinalSnapshotAsync(string runId, Dictionary<string, StringBuilder> slotTexts, ArenaRunInput input)
    {
        try
        {
            var slotSnapshots = input.Slots.Select(s => new
            {
                slotId = s.SlotId,
                label = s.Label,
                labelIndex = s.LabelIndex,
                content = slotTexts.TryGetValue(s.SlotId, out var sb) ? sb.ToString() : ""
            }).ToList();

            var snapshotJson = JsonSerializer.Serialize(new
            {
                type = "arenaSnapshot",
                slots = slotSnapshots,
                prompt = input.Prompt,
                groupKey = input.GroupKey
            }, JsonOptions);

            var meta = await _runStore.GetRunAsync(RunKinds.Arena, runId, CancellationToken.None);
            var seq = meta?.LastSeq ?? 0;

            await _runStore.SetSnapshotAsync(RunKinds.Arena, runId,
                new RunSnapshot { Seq = seq, SnapshotJson = snapshotJson, UpdatedAt = DateTime.UtcNow },
                ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "ArenaRunWorker failed to write snapshot: {RunId}", runId);
        }
    }
}
