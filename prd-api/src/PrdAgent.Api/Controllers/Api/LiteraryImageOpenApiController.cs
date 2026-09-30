using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>文学 MCP 只入队与查询，执行、资产保存与标记回填使用网页同一个 Worker。</summary>
[ApiController]
[Route("api/open/literary")]
[Authorize(AuthenticationSchemes = "ApiKey")]
[RequireScope(McpCapabilityCatalog.ScopeLiteraryUse)]
public class LiteraryImageOpenApiController(
    MongoDbContext db,
    ILiteraryMcpModelSelectionService modelSelection) : ControllerBase
{
    private string UserId => User.FindFirst("boundUserId")?.Value
        ?? throw new UnauthorizedAccessException("Missing boundUserId claim");

    public class GenerateRequest
    {
        /// <summary>单张：要生成的标记序号。与 MarkerIndexes 二选一。</summary>
        public int? MarkerIndex { get; set; }
        /// <summary>批量：一次为多个标记各入队一张（每个标记一个独立任务，互不影响）。</summary>
        public List<int>? MarkerIndexes { get; set; }
        public int? WorkflowVersion { get; set; }
        public string? ClientRequestId { get; set; }
        /// <summary>风格（参考图配置）：ID 或名称；none = 不用参考图；不传 = 账号当前启用的那套。</summary>
        public string? Style { get; set; }
        /// <summary>水印：ID 或名称；none = 不打水印；不传 = 账号给文学创作绑定的那套。</summary>
        public string? Watermark { get; set; }
        /// <summary>尺寸：比例（如 16:9）或 宽x高（如 1376x768）；不传 = 1024x1024。</summary>
        public string? Size { get; set; }
    }

    private const string AppKey = "literary-agent";
    private const string DefaultSize = "1024x1024";
    private const string LegacyStyleId = "legacy-default";

    /// <summary>比例 → 1K 档尺寸。与前端 imageAspectOptions 的 size1k 列同源（文学页的尺寸选项就是这张表）。</summary>
    internal static readonly IReadOnlyDictionary<string, string> AspectSizes = new Dictionary<string, string>
    {
        ["1:1"] = "1024x1024", ["4:3"] = "1200x896", ["3:4"] = "896x1200", ["4:5"] = "928x1152",
        ["5:4"] = "1152x928", ["16:9"] = "1376x768", ["9:16"] = "768x1376", ["2:3"] = "848x1264",
        ["3:2"] = "1264x848", ["21:9"] = "1584x672",
    };

    /// <summary>这次请求要占几格生图额度：批量按去重后的标记数，单张为 1。网关与直连两条闸门共用这一处。</summary>
    public static int RequestedImageCount(int? markerIndex, IEnumerable<int>? markerIndexes)
    {
        var batch = markerIndexes?.Distinct().Count() ?? 0;
        if (batch > 0) return Math.Min(batch, LiteraryMcpWorkflow.MaxMarkers);
        return 1;
    }

    internal sealed record StyleChoice(string? StyleId, string Label, string? Sha, string? PromptPrefix);
    internal sealed record WatermarkChoice(string WatermarkId, string Label);

    private static bool IsNone(string value)
        => value.Equals("none", StringComparison.OrdinalIgnoreCase) || value is "无" or "不使用" or "不要";

    /// <summary>
    /// 风格（参考图配置）按 ID 或名称选。不传时与网页完全同一个判据：当前启用且有参考图的那套 →
    /// 历史的全局参考图 → 无。选中的结果会回给调用方，不再让它猜「平台到底套了哪一套」。
    /// </summary>
    internal async Task<(StyleChoice? choice, string? error)> ResolveStyleAsync(string userId, string? style, CancellationToken ct)
    {
        var wanted = style?.Trim();
        var configs = await db.ReferenceImageConfigs.Find(x => x.AppKey == AppKey && x.CreatedByAdminId == userId).ToListAsync(ct);
        if (string.IsNullOrEmpty(wanted))
        {
            var active = configs.FirstOrDefault(x => x.IsActive && !string.IsNullOrWhiteSpace(x.ImageSha256));
            if (active != null)
                return (new StyleChoice(active.Id, active.Name, active.ImageSha256!.Trim().ToLowerInvariant(),
                    string.IsNullOrWhiteSpace(active.Prompt) ? null : active.Prompt), null);
            var legacy = await LegacyStyleAsync(ct);
            return (legacy ?? new StyleChoice("none", "不使用参考图", null, null), null);
        }
        if (IsNone(wanted)) return (new StyleChoice("none", "不使用参考图", null, null), null);
        if (wanted == LegacyStyleId)
        {
            var legacy = await LegacyStyleAsync(ct);
            return legacy == null ? (null, "系统默认参考图不存在，请用 map_literary_list_presets 查看可用风格。") : (legacy, null);
        }
        var hits = configs.Where(x => x.Id == wanted).ToList();
        if (hits.Count == 0)
            hits = configs.Where(x => string.Equals(x.Name?.Trim(), wanted, StringComparison.OrdinalIgnoreCase)).ToList();
        if (hits.Count == 0)
        {
            var names = configs.Select(x => $"「{x.Name}」").ToList();
            return (null, names.Count == 0
                ? $"没有叫「{wanted}」的风格：这个账号在文学创作里还没有任何参考图配置，请先在页面「风格/参考图」里建一套，或传 none。"
                : $"没有叫「{wanted}」的风格。可用的有：{string.Join("、", names)}（也可传 none）。");
        }
        if (hits.Count > 1)
            return (null, $"有 {hits.Count} 套风格都叫「{wanted}」，请改传 ID：{string.Join("、", hits.Select(x => x.Id))}。");
        var hit = hits[0];
        var sha = string.IsNullOrWhiteSpace(hit.ImageSha256) ? null : hit.ImageSha256.Trim().ToLowerInvariant();
        return (new StyleChoice(hit.Id, hit.Name, sha, string.IsNullOrWhiteSpace(hit.Prompt) ? null : hit.Prompt), null);
    }

    private async Task<StyleChoice?> LegacyStyleAsync(CancellationToken ct)
    {
        var legacy = await db.LiteraryAgentConfigs.Find(x => x.Id == AppKey).FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(legacy?.ReferenceImageSha256) ? null
            : new StyleChoice(LegacyStyleId, "系统默认参考图", legacy.ReferenceImageSha256.Trim().ToLowerInvariant(), null);
    }

    /// <summary>
    /// 水印按 ID 或名称选。不传时在**入队这一刻**就把「账号给文学创作绑定的那套」钉进任务，
    /// 执行时不再重新猜——入队后改了绑定，也不会让已经排上的任务换一套水印。
    /// </summary>
    internal async Task<(WatermarkChoice? choice, string? error)> ResolveWatermarkAsync(string userId, string? watermark, CancellationToken ct)
    {
        var wanted = watermark?.Trim();
        var configs = await db.WatermarkConfigs.Find(x => x.UserId == userId).ToListAsync(ct);
        if (string.IsNullOrEmpty(wanted))
        {
            var bound = configs.FirstOrDefault(x => x.AppKeys != null && x.AppKeys.Contains(AppKey));
            return (bound == null ? new WatermarkChoice(WatermarkSelection.None, "不打水印（账号未给文学创作绑定水印）")
                : new WatermarkChoice(bound.Id, bound.Name), null);
        }
        if (IsNone(wanted)) return (new WatermarkChoice(WatermarkSelection.None, "不打水印"), null);
        var hits = configs.Where(x => x.Id == wanted).ToList();
        if (hits.Count == 0)
            hits = configs.Where(x => string.Equals(x.Name?.Trim(), wanted, StringComparison.OrdinalIgnoreCase)).ToList();
        if (hits.Count == 0)
        {
            var names = configs.Select(x => $"「{x.Name}」").ToList();
            return (null, names.Count == 0
                ? $"没有叫「{wanted}」的水印：这个账号还没有任何水印配置，请先在页面「水印」里建一套，或传 none。"
                : $"没有叫「{wanted}」的水印。可用的有：{string.Join("、", names)}（也可传 none）。");
        }
        if (hits.Count > 1)
            return (null, $"有 {hits.Count} 套水印都叫「{wanted}」，请改传 ID：{string.Join("、", hits.Select(x => x.Id))}。");
        return (new WatermarkChoice(hits[0].Id, hits[0].Name), null);
    }

    internal static (string? size, string? error) ResolveSize(string? size)
    {
        var wanted = size?.Trim();
        if (string.IsNullOrEmpty(wanted)) return (DefaultSize, null);
        if (AspectSizes.TryGetValue(wanted.Replace('：', ':'), out var mapped)) return (mapped, null);
        var m = System.Text.RegularExpressions.Regex.Match(wanted.ToLowerInvariant().Replace('×', 'x').Replace('*', 'x'), @"^(\d{3,4})x(\d{3,4})$");
        if (m.Success && int.Parse(m.Groups[1].Value) is >= 256 and <= 4096 && int.Parse(m.Groups[2].Value) is >= 256 and <= 4096)
            return ($"{m.Groups[1].Value}x{m.Groups[2].Value}", null);
        return (null, $"尺寸「{wanted}」认不出来。传比例（{string.Join(" / ", AspectSizes.Keys)}）或 宽x高（256-4096）。");
    }

    /// <summary>这个账号在文学创作里能选的风格、水印、尺寸，以及不传时会用哪一套。</summary>
    [HttpGet("presets")]
    public async Task<IActionResult> Presets(CancellationToken ct)
    {
        var userId = UserId;
        var styles = await db.ReferenceImageConfigs.Find(x => x.AppKey == AppKey && x.CreatedByAdminId == userId)
            .SortByDescending(x => x.IsActive).ToListAsync(ct);
        var legacy = await LegacyStyleAsync(ct);
        var (defaultStyle, _) = await ResolveStyleAsync(userId, null, ct);
        var watermarks = await db.WatermarkConfigs.Find(x => x.UserId == userId).ToListAsync(ct);
        var (defaultWatermark, _) = await ResolveWatermarkAsync(userId, null, ct);
        var styleItems = styles.Select(x => new
        {
            styleId = x.Id, name = x.Name,
            prompt = string.IsNullOrWhiteSpace(x.Prompt) ? null : (x.Prompt.Length > 200 ? x.Prompt[..200] + "…" : x.Prompt),
            hasReferenceImage = !string.IsNullOrWhiteSpace(x.ImageSha256),
            referenceImageUrl = Request.ResolveAbsoluteUrl(x.ImageUrl),
            isDefault = x.Id == defaultStyle?.StyleId,
        }).ToList<object>();
        if (legacy != null)
            styleItems.Add(new { styleId = LegacyStyleId, name = legacy.Label, prompt = (string?)null, hasReferenceImage = true,
                referenceImageUrl = (string?)null, isDefault = defaultStyle?.StyleId == LegacyStyleId });
        return Ok(ApiResponse<object>.Ok(new
        {
            styles = styleItems,
            defaultStyle = new { styleId = defaultStyle?.StyleId, name = defaultStyle?.Label },
            watermarks = watermarks.Select(x => new
            {
                watermarkId = x.Id, name = x.Name, text = x.Text,
                boundToLiterary = x.AppKeys != null && x.AppKeys.Contains(AppKey),
                isDefault = x.Id == defaultWatermark?.WatermarkId,
            }),
            defaultWatermark = new { watermarkId = defaultWatermark?.WatermarkId, name = defaultWatermark?.Label },
            sizes = AspectSizes.Select(kv => new { aspect = kv.Key, size = kv.Value }),
            defaultSize = DefaultSize,
            maxMarkersPerArticle = LiteraryMcpWorkflow.MaxMarkers,
            hint = "生图时 style / watermark 传这里的 ID 或名称，none 表示不用；不传就用 isDefault 那一套。",
        }));
    }

    [HttpPost("workspaces/{workspaceId}/images")]
    public async Task<IActionResult> Generate(string workspaceId, [FromBody] GenerateRequest? req, CancellationToken ct)
    {
        req ??= new GenerateRequest();
        var batch = req.MarkerIndexes is { Count: > 0 };
        if ((req.MarkerIndex.HasValue && batch) || (!req.MarkerIndex.HasValue && !batch))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                "markerIndex（单张）与 markerIndexes（批量）必须且只能传一个；序号来自读取工作区返回的 illustrations[].index。"));
        var indexes = batch ? req.MarkerIndexes!.Distinct().ToList() : new List<int> { req.MarkerIndex!.Value };
        if (indexes.Any(i => i < 0) || indexes.Count > LiteraryMcpWorkflow.MaxMarkers || req.WorkflowVersion is null or < 1
            || string.IsNullOrWhiteSpace(req.ClientRequestId) || req.ClientRequestId.Length > 200)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"请传 markerIndex 或 markerIndexes（最多 {LiteraryMcpWorkflow.MaxMarkers} 个）、workflowVersion 和 1-200 字的 clientRequestId；前两项来自读取工作区，重试保持同一个 clientRequestId。"));
        var userId = UserId;
        var (size, sizeError) = ResolveSize(req.Size);
        if (sizeError != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, sizeError));
        var (style, styleError) = await ResolveStyleAsync(userId, req.Style, ct);
        if (styleError != null) return BadRequest(ApiResponse<object>.Fail("STYLE_NOT_FOUND", styleError));
        var (watermark, watermarkError) = await ResolveWatermarkAsync(userId, req.Watermark, ct);
        if (watermarkError != null) return BadRequest(ApiResponse<object>.Fail("WATERMARK_NOT_FOUND", watermarkError));

        // 单张沿用原幂等键（已发出去的重试仍能命中）；批量按「请求 + 标记」派生，每个标记一个独立任务。
        string IdemFor(int index)
        {
            var raw = batch ? $"{req.ClientRequestId}#m{index}" : req.ClientRequestId;
            var fingerprint = McpIdempotency.Fingerprint("mcp-literary-image", McpIdempotency.ScopedByKey(User, raw));
            return DeploymentScope.ScopeIdempotencyKey($"mcp:{fingerprint}");
        }

        var results = new List<object>();
        var pending = new List<int>();
        foreach (var index in indexes)
        {
            var key = IdemFor(index);
            var previous = await db.ImageGenRuns.Find(x => x.OwnerAdminId == userId && x.IdempotencyKey == key).FirstOrDefaultAsync(ct);
            if (previous == null) { pending.Add(index); continue; }
            if (IsReplayConflict(previous, workspaceId, index, req.WorkflowVersion.Value, size!, style!, watermark!))
                return Conflict(ApiResponse<object>.Fail("IDEMPOTENCY_CONFLICT", "这个 clientRequestId 已用于另一项配图请求（工作区、标记、风格、水印或尺寸不同），请为新的请求使用新的值。"));
            results.Add(new { markerIndex = index, runId = previous.Id, deduplicated = true });
        }

        if (pending.Count > 0)
        {
            var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == workspaceId && x.OwnerUserId == userId
                && x.ScenarioType == "article-illustration").FirstOrDefaultAsync(ct);
            if (ws == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文学工作区不存在或不属于你。"));
            if (ws.ArticleWorkflow?.Version != req.WorkflowVersion)
                return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED", "正文或配图方案已变化，请重新读取工作区后再生成。"));
            var missing = pending.Where(i => ws.ArticleWorkflow.Markers.All(m => m.Index != i)).ToList();
            if (missing.Count > 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"配图标记 {string.Join("、", missing)} 不存在（这篇共 {ws.ArticleWorkflow.Markers.Count} 个，从 0 开始）。改稿后要重新配图，请用 map_literary_write_content 传 markedContent。"));
            var tooLong = pending.Where(i =>
            {
                var m = ws.ArticleWorkflow.Markers.First(x => x.Index == i);
                var p = string.IsNullOrWhiteSpace(m.DraftText) ? m.Text : m.DraftText;
                return string.IsNullOrWhiteSpace(p) || p.Length > 4000;
            }).ToList();
            if (tooLong.Count > 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"配图标记 {string.Join("、", tooLong)} 的描述需为 1-4000 字，请先调整标记。"));

            var appCallerCode = style!.Sha == null
                ? LiteraryAgent.Illustration.Text2Img
                : LiteraryAgent.Illustration.Img2Img;
            var keyId = McpIdempotency.KeyIdOf(User);
            if (keyId == "unknown")
                return Unauthorized(ApiResponse<object>.Fail("MODEL_KEY_NOT_FOUND", "当前请求没有可识别的 MCP 客户端配置，请重新连接客户端。"));
            var selectedModel = await modelSelection.ResolveForRunAsync(userId, keyId, appCallerCode, ct);
            if (!selectedModel.Success || string.IsNullOrWhiteSpace(selectedModel.LogicalModelPublicId))
                return Conflict(ApiResponse<object>.Fail(selectedModel.ErrorCode ?? "MODEL_UNAVAILABLE",
                    selectedModel.ErrorMessage ?? "当前没有可用的文学配图模型。"));

            foreach (var index in pending)
            {
                var marker = ws.ArticleWorkflow.Markers.First(m => m.Index == index);
                var prompt = string.IsNullOrWhiteSpace(marker.DraftText) ? marker.Text : marker.DraftText;
                var effectivePrompt = style.PromptPrefix != null ? $"{style.PromptPrefix}\n\n{prompt}" : prompt;
                var idem = IdemFor(index);
                var run = new ImageGenRun
                {
                    Id = McpIdempotency.Fingerprint("literary-run", idem)!,
                    OwnerAdminId = userId, WorkspaceId = ws.Id,
                    AppKey = AppKey,
                    AppCallerCode = appCallerCode,
                    PlatformId = "logical-model",
                    ModelId = selectedModel.LogicalModelPublicId,
                    LogicalModelPublicId = selectedModel.LogicalModelPublicId,
                    ModelResolutionType = PrdAgent.Core.Models.ModelResolutionType.LogicalModel,
                    InitImageAssetSha256 = style.Sha,
                    WatermarkConfigId = watermark!.WatermarkId,
                    ArticleMarkerIndex = marker.Index, ArticleWorkflowVersion = req.WorkflowVersion,
                    Status = ImageGenRunStatus.ScopedQueued, DeploymentSlug = DeploymentScope.Current,
                    IdempotencyKey = idem, Total = 1, MaxConcurrency = 1,
                    Size = size!, ResponseFormat = "b64_json",
                    Items = new() { new() { Prompt = effectivePrompt, DisplayPrompt = prompt, Count = 1, Size = size } },
                    CreatedAt = DateTime.UtcNow,
                };
                // 先在同一个原子写中认领当前版本，再让 Worker 看见任务。
                // 页面在查读后改版时必须拒绝，不能先消费生图额度再发现已无法回填。
                if (!await ClaimWorkflowAsync(ws, run))
                {
                    results.Add(new { markerIndex = index, runId = (string?)null, error = "WORKSPACE_CONTENT_CHANGED" });
                    if (!batch)
                        return Conflict(ApiResponse<object>.Fail("WORKSPACE_CONTENT_CHANGED", "正文或配图方案已变化，请重新读取工作区后再生成。"));
                    continue;
                }
                try { await db.ImageGenRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None); }
                catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                {
                    var existing = await db.ImageGenRuns.Find(x => x.OwnerAdminId == userId && x.IdempotencyKey == idem).FirstOrDefaultAsync(CancellationToken.None);
                    if (existing == null) throw;
                    if (IsReplayConflict(existing, workspaceId, index, req.WorkflowVersion.Value, size!, style, watermark))
                        return Conflict(ApiResponse<object>.Fail("IDEMPOTENCY_CONFLICT", "这个 clientRequestId 已用于另一项配图请求，请为新的请求使用新的值。"));
                    results.Add(new { markerIndex = index, runId = existing.Id, deduplicated = true });
                    continue;
                }
                catch
                {
                    // 写入报错可能只是确认丢失；已有任务或并发重试成功时不能误报失败。
                    await CompensateMissingRunAsync(run);
                    throw;
                }
                results.Add(new { markerIndex = index, runId = run.Id, status = "queued" });
            }
        }

        const string hint = "图在服务端生成，关掉客户端也不会断。每 5-10 秒调用一次 map_literary_get_workspace 看 illustrations[].status（done 即有 url），全部 done 后用 format=illustrated 取图文稿；也可用 map_literary_get_image_run 查单张。";
        var applied = new { style = new { styleId = style!.StyleId, name = style.Label }, watermark = new { watermarkId = watermark!.WatermarkId, name = watermark.Label }, size };
        if (!batch)
        {
            var only = JsonSerializer.SerializeToElement(results[0]);
            var runId = only.TryGetProperty("runId", out var r) ? r.GetString() : null;
            var dedup = only.TryGetProperty("deduplicated", out var d) && d.GetBoolean();
            return Ok(ApiResponse<object>.Ok(dedup
                ? new { runId, deduplicated = true, applied, hint }
                : new { runId, status = "queued", total = 1, applied, hint }));
        }
        return Ok(ApiResponse<object>.Ok(new { workspaceId, runs = results, total = results.Count, applied, hint }));
    }

    /// <summary>同一个幂等键再来时，只有「同一件事」才回放；换了工作区 / 标记 / 版本 / 风格 / 水印 / 尺寸一律冲突。</summary>
    private static bool IsReplayConflict(ImageGenRun previous, string workspaceId, int markerIndex, int version,
        string size, StyleChoice style, WatermarkChoice watermark)
        => previous.WorkspaceId != workspaceId || previous.ArticleMarkerIndex != markerIndex
           || previous.ArticleWorkflowVersion != version
           || (previous.Size != null && previous.Size != size)
           || (previous.WatermarkConfigId != null && previous.WatermarkConfigId != watermark.WatermarkId)
           || !string.Equals(previous.InitImageAssetSha256, style.Sha, StringComparison.Ordinal);

    internal async Task<bool> ClaimWorkflowAsync(ImageMasterWorkspace ws, ImageGenRun run)
    {
        var filter = Builders<ImageMasterWorkspace>.Filter;
        var result = await db.ImageMasterWorkspaces.UpdateOneAsync(
            filter.And(filter.Eq(x => x.Id, ws.Id), filter.Eq(x => x.OwnerUserId, run.OwnerAdminId),
                filter.Eq(x => x.ArticleWorkflow!.Version, run.ArticleWorkflowVersion),
                filter.ElemMatch(x => x.ArticleWorkflow!.Markers, m => m.Index == run.ArticleMarkerIndex)),
            Builders<ImageMasterWorkspace>.Update.Set("articleWorkflow.markers.$[target].runId", run.Id)
                .Set("articleWorkflow.markers.$[target].status", "running")
                .Set("articleWorkflow.markers.$[target].errorMessage", (string?)null)
                .Set("articleWorkflow.updatedAt", DateTime.UtcNow),
            new UpdateOptions { ArrayFilters = new[]
            {
                // 同一幂等请求并发到达时，不把已经成功或失败的同一任务改回 running。
                new BsonDocumentArrayFilterDefinition<BsonDocument>(new BsonDocument
                {
                    { "target.index", run.ArticleMarkerIndex!.Value },
                    { "$or", new BsonArray
                        {
                            new BsonDocument("target.runId", new BsonDocument("$ne", run.Id)),
                            new BsonDocument("target.status", "error"),
                        } },
                }),
            } }, CancellationToken.None);
        return result.MatchedCount != 0;
    }

    internal async Task CompensateMissingRunAsync(ImageGenRun run)
    {
        if (await db.ImageGenRuns.Find(x => x.Id == run.Id).AnyAsync(CancellationToken.None)) return;
        await db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == run.WorkspaceId && x.OwnerUserId == run.OwnerAdminId
                && x.ArticleWorkflow!.Version == run.ArticleWorkflowVersion,
            Builders<ImageMasterWorkspace>.Update.Set("articleWorkflow.markers.$[target].status", "error")
                .Set("articleWorkflow.markers.$[target].errorMessage", "配图任务未能保存，请重新生成；MCP 重试请保持相同 clientRequestId。")
                .Set("articleWorkflow.updatedAt", DateTime.UtcNow),
            new UpdateOptions { ArrayFilters = new[]
            {
                new BsonDocumentArrayFilterDefinition<BsonDocument>(new BsonDocument
                {
                    { "target.index", run.ArticleMarkerIndex!.Value },
                    { "target.runId", run.Id },
                    { "target.status", "running" },
                }),
            } }, CancellationToken.None);
    }

    [HttpGet("image-runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var userId = UserId;
        var run = await db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == userId && x.AppKey == "literary-agent").FirstOrDefaultAsync(ct);
        if (run == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "配图任务不存在或不属于你。"));
        var items = await db.ImageGenRunItems.Find(x => x.RunId == runId && x.OwnerAdminId == userId).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id, status = run.Status.ToString(), total = run.Total, done = run.Done, failed = run.Failed,
            finished = VisualOpenApiController.IsRunFinished(run.Status, run.Done, run.Failed, run.Total),
            error = VisualOpenApiController.RunFailure(run, items.Count),
            images = items.Select(x => new { index = x.ImageIndex, status = x.Status.ToString(),
                url = Request.ResolveAbsoluteUrl(x.Url), errorMessage = x.ErrorMessage == null ? null : McpArtifactExtractor.UserFacing(x.ErrorMessage) }),
        }));
    }

    public class MoveRequest { public string? FolderName { get; set; } }

    [HttpPost("workspaces/{workspaceId}/folder")]
    public async Task<IActionResult> Move(string workspaceId, [FromBody] MoveRequest req)
    {
        if (req.FolderName == null || req.FolderName.Trim().Length > 80)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请传 0-80 字的 folderName；空字符串表示移回未分类。"));
        var userId = UserId;
        var folder = string.IsNullOrWhiteSpace(req.FolderName) ? null : req.FolderName.Trim();
        var result = await db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == workspaceId && x.OwnerUserId == userId && x.ScenarioType == "article-illustration",
            Builders<ImageMasterWorkspace>.Update.Set(x => x.FolderName, folder).Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        return result.MatchedCount == 0
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文学工作区不存在或不属于你。"))
            : Ok(ApiResponse<object>.Ok(new { workspaceId, folderName = folder, published = false }));
    }
}
