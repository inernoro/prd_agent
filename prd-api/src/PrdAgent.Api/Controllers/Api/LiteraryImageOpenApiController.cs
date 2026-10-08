using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using static PrdAgent.Core.Models.AppCallerRegistry;
using StyleChoice = PrdAgent.Api.Services.LiteraryIllustrationChoices.StyleChoice;
using WatermarkChoice = PrdAgent.Api.Services.LiteraryIllustrationChoices.WatermarkChoice;

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
        /// <summary>尺寸：比例（如 3:2）或 宽x高（如 1536x1024）；不传 = 1:1。能用哪些取决于所用模型，见 presets 的 sizes。</summary>
        public string? Size { get; set; }
    }

    /// <summary>这次请求要占几格生图额度：批量按去重后的标记数，单张为 1。网关与直连两条闸门共用这一处。</summary>
    public static int RequestedImageCount(int? markerIndex, IEnumerable<int>? markerIndexes)
    {
        var batch = markerIndexes?.Distinct().Count() ?? 0;
        if (batch > 0) return Math.Min(batch, LiteraryMcpWorkflow.MaxMarkers);
        return 1;
    }

    private const string AppKey = LiteraryIllustrationChoices.AppKey;
    private const string LegacyStyleId = LiteraryIllustrationChoices.LegacyStyleId;

    internal Task<(StyleChoice? choice, string? error)> ResolveStyleAsync(string userId, string? style, CancellationToken ct)
        => LiteraryIllustrationChoices.ResolveStyleAsync(db, userId, style, ct);

    private Task<StyleChoice?> LegacyStyleAsync(CancellationToken ct) => LiteraryIllustrationChoices.LegacyStyleAsync(db, ct);

    internal Task<(WatermarkChoice? choice, string? error)> ResolveWatermarkAsync(string userId, string? watermark, CancellationToken ct)
        => LiteraryIllustrationChoices.ResolveWatermarkAsync(db, userId, watermark, ct);

    /// <summary>
    /// 这台客户端生图时会用哪个模型、它收哪些尺寸。appCallerCode 跟着风格走（有参考图走图生图），
    /// 与入队时同一个判据。读不到时把原因交给调用方去说，不当作「什么尺寸都收」。
    /// </summary>
    private async Task<(string? modelId, ImageGenAdapterInfo? caps, string? errorCode, string? error)> ResolveModelSizesAsync(
        string userId, string appCallerCode, CancellationToken ct)
    {
        var keyId = McpIdempotency.KeyIdOf(User);
        if (keyId == "unknown")
            return (null, null, "MODEL_KEY_NOT_FOUND", "当前请求没有可识别的 MCP 客户端配置，请重新连接客户端。");
        var selected = await modelSelection.ResolveForRunAsync(userId, keyId, appCallerCode, ct);
        if (!selected.Success || string.IsNullOrWhiteSpace(selected.LogicalModelPublicId))
            return (null, null, selected.ErrorCode ?? "MODEL_UNAVAILABLE", selected.ErrorMessage ?? "当前没有可用的文学配图模型。");
        var caps = await modelSelection.GetImageCapabilitiesAsync(appCallerCode, selected.LogicalModelPublicId, ct);
        return caps == null
            ? (selected.LogicalModelPublicId, null, "MODEL_CAPABILITIES_UNAVAILABLE",
                $"读不到模型「{selected.LogicalModelPublicId}」支持哪些尺寸，没有入队，也没有扣生图额度。请稍后重试，或在智能体接入台给这台客户端换一个模型。")
            : (selected.LogicalModelPublicId, caps, null, null);
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
        // 尺寸按这台客户端实际会用的模型列：以前列的是一张固定表，16:9 在默认模型上必然失败（MCP-LIT-18）。
        var presetCaller = defaultStyle?.Sha == null ? LiteraryAgent.Illustration.Text2Img : LiteraryAgent.Illustration.Img2Img;
        var (sizeModel, sizeCaps, _, sizeError) = await ResolveModelSizesAsync(userId, presetCaller, ct);
        var sizeChoices = sizeCaps == null ? new List<LiteraryIllustrationChoices.SizeChoice>() : LiteraryIllustrationChoices.SupportedSizes(sizeCaps);
        var defaultSize = sizeCaps == null ? null
            : LiteraryIllustrationChoices.FitSize(LiteraryIllustrationChoices.ParseSize(null).request!, sizeCaps, sizeModel!).size;
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
            sizes = sizeChoices.Select(c => new { aspect = c.Aspect, size = c.Size }),
            defaultSize,
            sizeModel,
            sizeNote = sizeError ?? (sizeCaps!.SizesNotApplicable
                ? $"模型「{sizeModel}」不按尺寸参数出图，画面比例由描述决定，size 传了也不起作用。"
                : $"以上是这台客户端所用模型「{sizeModel}」支持的尺寸：传比例会落到右边那个像素尺寸，也可以直接传宽x高；"
                  + "传它不支持的会在入队前被拒绝并列出可选项，不扣额度。换了模型，这张表会跟着变。"),
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
        // 这次没传的项，先沿用这篇文章上次明确指定的那套，再退回账号默认。
        // 用户说「重画一张」「按新稿重新配」时不会再报一遍风格水印，预期却一定是原来那套。
        var remembered = await db.ImageMasterWorkspaces
            .Find(x => x.Id == workspaceId && x.OwnerUserId == userId && x.ScenarioType == "article-illustration")
            .Project(x => x.IllustrationPrefs).FirstOrDefaultAsync(ct);
        var notes = new List<string>();
        var explicitStyle = !string.IsNullOrWhiteSpace(req.Style);
        var explicitWatermark = !string.IsNullOrWhiteSpace(req.Watermark);
        var explicitSize = !string.IsNullOrWhiteSpace(req.Size);

        // 这里只解析写法；模型收不收，要等选出模型后再判（同一比例在不同模型上落到的像素可能不同）。
        var sizeSource = explicitSize ? "explicit" : !string.IsNullOrWhiteSpace(remembered?.Size) ? "remembered" : "account-default";
        var (sizeRequest, sizeError) = LiteraryIllustrationChoices.ParseSize(explicitSize ? req.Size : remembered?.Size);
        if (sizeError != null && explicitSize) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, sizeError));
        if (sizeError != null)
        {
            (sizeRequest, _) = LiteraryIllustrationChoices.ParseSize(null);
            sizeSource = "account-default";
        }
        string? size = null;

        var styleSource = explicitStyle ? "explicit" : !string.IsNullOrWhiteSpace(remembered?.StyleId) ? "remembered" : "account-default";
        var (style, styleError) = await ResolveStyleAsync(userId, explicitStyle ? req.Style : remembered?.StyleId, ct);
        if (styleError != null && styleSource == "remembered")
        {
            // 记住的那套已经被删了：不静默换，回执里写明本次改用了账号默认。
            (style, styleError) = await ResolveStyleAsync(userId, null, ct);
            styleSource = "account-default";
            notes.Add("这篇文章上次用的风格已不存在，本次改用账号默认风格。");
        }

        var watermarkSource = explicitWatermark ? "explicit" : !string.IsNullOrWhiteSpace(remembered?.WatermarkId) ? "remembered" : "account-default";
        var (watermark, watermarkError) = await ResolveWatermarkAsync(userId, explicitWatermark ? req.Watermark : remembered?.WatermarkId, ct);
        if (watermarkError != null && watermarkSource == "remembered")
        {
            (watermark, watermarkError) = await ResolveWatermarkAsync(userId, null, ct);
            watermarkSource = "account-default";
            notes.Add("这篇文章上次用的水印已不存在，本次改用账号默认水印。");
        }

        // 单张沿用原幂等键（已发出去的重试仍能命中）；批量按「请求 + 标记」派生，每个标记一个独立任务。
        string IdemFor(int index)
        {
            var raw = batch ? $"{req.ClientRequestId}#m{index}" : req.ClientRequestId;
            var fingerprint = McpIdempotency.Fingerprint("mcp-literary-image", McpIdempotency.ScopedByKey(User, raw));
            return DeploymentScope.ScopeIdempotencyKey($"mcp:{fingerprint}");
        }

        var results = new List<object>();
        var pending = new List<int>();
        var newlyQueued = 0;
        // 重放只比「这次请求本身说了什么」：账号默认、文章记住的那套都是会变的状态，
        // 重试前它们变了（甚至被删了），同一个 clientRequestId 也必须照样回放原任务。
        var explicitSizeValue = explicitSize ? sizeRequest : null;
        var explicitStyleValue = explicitStyle ? style : null;
        var explicitWatermarkValue = explicitWatermark ? watermark : null;
        foreach (var index in indexes)
        {
            var key = IdemFor(index);
            var previous = await db.ImageGenRuns.Find(x => x.OwnerAdminId == userId && x.IdempotencyKey == key).FirstOrDefaultAsync(ct);
            if (previous == null) { pending.Add(index); continue; }
            if (IsReplayConflict(previous, workspaceId, index, req.WorkflowVersion.Value, explicitSizeValue, explicitStyleValue, explicitWatermarkValue))
                return Conflict(ApiResponse<object>.Fail("IDEMPOTENCY_CONFLICT", "这个 clientRequestId 已用于另一项配图请求（工作区、标记、风格、水印或尺寸不同），请为新的请求使用新的值。"));
            results.Add(new { markerIndex = index, runId = previous.Id, deduplicated = true });
            size ??= previous.Size;
        }

        string? usedModel = null;
        if (pending.Count > 0)
        {
            if (styleError != null) return BadRequest(ApiResponse<object>.Fail("STYLE_NOT_FOUND", styleError));
            if (watermarkError != null) return BadRequest(ApiResponse<object>.Fail("WATERMARK_NOT_FOUND", watermarkError));
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
                var p = LiteraryMcpWorkflow.EffectivePrompt(m);
                return string.IsNullOrWhiteSpace(p) || p.Length > 4000;
            }).ToList();
            if (tooLong.Count > 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"配图标记 {string.Join("、", tooLong)} 的描述需为 1-4000 字，请先调整标记。"));

            var appCallerCode = style!.Sha == null
                ? LiteraryAgent.Illustration.Text2Img
                : LiteraryAgent.Illustration.Img2Img;
            var (modelId, caps, modelErrorCode, modelError) = await ResolveModelSizesAsync(userId, appCallerCode, ct);
            if (modelErrorCode == "MODEL_KEY_NOT_FOUND")
                return Unauthorized(ApiResponse<object>.Fail(modelErrorCode, modelError!));
            if (caps == null)
                return Conflict(ApiResponse<object>.Fail(modelErrorCode!, modelError!));
            usedModel = modelId;

            // 入队前按所选模型的真实尺寸能力落尺寸（MCP-LIT-18）：网关执行前用的是同一个判据，
            // 这里放行的网关一定收；不收的在这里拒，不让一批任务入队后全部失败、还占着额度。
            var (fitted, fitError) = LiteraryIllustrationChoices.FitSize(sizeRequest!, caps, modelId!);
            if (fitError != null && sizeSource == "remembered")
            {
                // 文章记住的尺寸是上次那个模型的像素。换了模型不收时，先按同一比例重新落；
                // 这个比例也不收，才退回 1:1。两种都在回执里说清楚，不静默改。
                var sameRatio = LiteraryIllustrationChoices.AsRatio(sizeRequest!);
                var (byRatio, ratioError) = LiteraryIllustrationChoices.FitSize(sameRatio, caps, modelId!);
                if (ratioError == null)
                {
                    notes.Add($"这篇文章上次用的尺寸 {remembered!.Size} 当前模型「{modelId}」不支持，本次按同一比例 {sameRatio.Raw} 改用 {byRatio}。");
                    (fitted, fitError) = (byRatio, null);
                }
                else
                {
                    var (fallback, fallbackError) = LiteraryIllustrationChoices.FitSize(LiteraryIllustrationChoices.ParseSize(null).request!, caps, modelId!);
                    if (fallbackError == null)
                    {
                        notes.Add($"这篇文章上次用的尺寸 {remembered!.Size}（{sameRatio.Raw}）当前模型「{modelId}」不支持，本次改用 1:1 的 {fallback}。");
                        (fitted, fitError, sizeSource) = (fallback, null, "account-default");
                    }
                }
            }
            if (fitError != null)
                return BadRequest(ApiResponse<object>.Fail("SIZE_NOT_SUPPORTED", fitError));
            size = fitted;

            foreach (var index in pending)
            {
                var marker = ws.ArticleWorkflow.Markers.First(m => m.Index == index);
                var prompt = LiteraryMcpWorkflow.EffectivePrompt(marker);
                var effectivePrompt = style.PromptPrefix != null ? $"{style.PromptPrefix}\n\n{prompt}" : prompt;
                var idem = IdemFor(index);
                var run = new ImageGenRun
                {
                    Id = McpIdempotency.Fingerprint("literary-run", idem)!,
                    OwnerAdminId = userId, WorkspaceId = ws.Id,
                    AppKey = AppKey,
                    AppCallerCode = appCallerCode,
                    PlatformId = "logical-model",
                    ModelId = modelId,
                    LogicalModelPublicId = modelId,
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
                    if (IsReplayConflict(existing, workspaceId, index, req.WorkflowVersion.Value, explicitSizeValue, explicitStyleValue, explicitWatermarkValue))
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
                newlyQueued++;
            }
        }

        // 至少真入队了一张，才把这次明确指定的项记到文章上（只改指定了的那几项，没指定的保持原样）。
        if (newlyQueued > 0 && (explicitStyle || explicitWatermark || explicitSize))
        {
            // 只写明确指定的那几项：整份写回读到的旧快照，会把入队期间网页顶栏刚改的另一项改回去。
            // 不动 UpdatedAt：它是正文的版本令牌，记住偏好不该让智能体手里的令牌失效。
            await LiteraryIllustrationChoices.RememberExplicitAsync(db, workspaceId, userId,
                explicitStyle ? style!.StyleId : null, explicitWatermark ? watermark!.WatermarkId : null, explicitSize ? size : null);
        }

        const string hint = "图在服务端生成，关掉客户端也不会断。每 5-10 秒调用一次 map_literary_get_workspace 看 illustrations[].status（done 即有 url），全部 done 后用 format=illustrated 取图文稿；也可用 map_literary_get_image_run 查单张。";
        // source：explicit = 本次指定；remembered = 沿用这篇文章上次指定的；account-default = 账号默认
        // 全部是重放、且当前预设已解析不出时（重试前被删了），没有可回报的「这次套了哪套」：applied 为空，原任务照旧
        object? applied = style == null || watermark == null ? null : new
        {
            style = new { styleId = style.StyleId, name = style.Label, source = styleSource },
            watermark = new { watermarkId = watermark.WatermarkId, name = watermark.Label, source = watermarkSource },
            size, sizeSource,
            // 这次新入队的任务用的模型；全是重放时为空（原任务各自钉着当时的模型）
            model = usedModel,
            notes,
        };
        // queuedImages：这次真正新入队的张数。网关按请求张数预占日额度，按它把重放与没排上的退回去
        if (!batch)
        {
            var only = JsonSerializer.SerializeToElement(results[0]);
            var runId = only.TryGetProperty("runId", out var r) ? r.GetString() : null;
            var dedup = only.TryGetProperty("deduplicated", out var d) && d.GetBoolean();
            return Ok(ApiResponse<object>.Ok(dedup
                ? new { runId, deduplicated = true, queuedImages = 0, applied, hint }
                : new { runId, status = "queued", total = 1, queuedImages = newlyQueued, applied, hint }));
        }
        var allReplayed = newlyQueued == 0 && results.Count > 0 && results.All(x =>
            JsonSerializer.SerializeToElement(x).TryGetProperty("deduplicated", out var d) && d.GetBoolean());
        return Ok(ApiResponse<object>.Ok(allReplayed
            ? new { workspaceId, runs = results, total = results.Count, deduplicated = true, queuedImages = 0, applied, hint }
            : (object)new { workspaceId, runs = results, total = results.Count, queuedImages = newlyQueued, applied, hint }));
    }

    /// <summary>
    /// 同一个幂等键再来时，只有「同一件事」才回放；换了工作区 / 标记 / 版本，或这次明确指定的风格 / 水印 / 尺寸
    /// 与原任务不同，一律冲突。没有明确指定的项不比：它取自账号默认或文章记住的那套，是会变的状态，不是请求本身。
    /// 明确指定的项此刻解析不出（重试前被删了）时同样不比，原任务就是那次请求的结果。
    /// </summary>
    private static bool IsReplayConflict(ImageGenRun previous, string workspaceId, int markerIndex, int version,
        LiteraryIllustrationChoices.SizeRequest? explicitSize, StyleChoice? explicitStyle, WatermarkChoice? explicitWatermark)
        => previous.WorkspaceId != workspaceId || previous.ArticleMarkerIndex != markerIndex
           || previous.ArticleWorkflowVersion != version
           // 比尺寸意图而不是落到的像素：同一个「16:9」在不同模型上像素不同，但仍是同一件事
           || (explicitSize != null && previous.Size != null && !LiteraryIllustrationChoices.SameIntent(previous.Size, explicitSize))
           || (explicitWatermark != null && previous.WatermarkConfigId != null && previous.WatermarkConfigId != explicitWatermark.WatermarkId)
           || (explicitStyle != null && !string.Equals(previous.InitImageAssetSha256, explicitStyle.Sha, StringComparison.Ordinal));

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
