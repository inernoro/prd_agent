using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Prompts.Templates;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Services.VisualAgent;
using System.Text.RegularExpressions;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Security;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 生图 / 批量生图
/// </summary>
[ApiController]
[Route("api/visual-agent/image-gen")]
[Authorize]
[AdminController("visual-agent", AdminPermissionCatalog.VisualAgentUse)]
public class ImageGenController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IModelDomainService _modelDomain;
    private readonly IModelPoolQueryService _modelPoolQuery;
    private readonly OpenAIImageClient _imageClient;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<ImageGenController> _logger;
    private readonly IAppSettingsService _settingsService;
    private readonly IAssetStorage _assetStorage;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IRunEventStore _runStore;
    private readonly IMultiImageComposeService _composeService;

    // 硬编码的 appCallerCode（应用身份隔离原则）
    private static class AppCallerCodes
    {
        public const string Text2Img = "visual-agent.image.text2img::generation";
        public const string Img2Img = "visual-agent.image.img2img::generation";
        public const string VisionGen = "visual-agent.image.vision::generation";
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ImageGenController(
        MongoDbContext db,
        IModelDomainService modelDomain,
        IModelPoolQueryService modelPoolQuery,
        OpenAIImageClient imageClient,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<ImageGenController> logger,
        IAppSettingsService settingsService,
        IAssetStorage assetStorage,
        IHttpClientFactory httpClientFactory,
        IRunEventStore runStore,
        IMultiImageComposeService composeService)
    {
        _db = db;
        _modelDomain = modelDomain;
        _modelPoolQuery = modelPoolQuery;
        _imageClient = imageClient;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
        _settingsService = settingsService;
        _assetStorage = assetStorage;
        _httpClientFactory = httpClientFactory;
        _runStore = runStore;
        _composeService = composeService;
    }

    private string GetAdminId() => this.GetRequiredUserId();

    private static bool IsRegisteredImageGenAppCaller(string? appCallerCode)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode)) return false;
        var def = AppCallerRegistrationService.FindByAppCode(appCallerCode);
        return def != null && def.ModelTypes.Contains(ModelTypes.ImageGen);
    }

    #region 模型池查询（硬编码 appCallerCode，应用身份隔离）

    /// <summary>
    /// 获取视觉创作所有生图场景的模型池列表（文生图 + 图生图 + 多图合成，合并去重）
    /// </summary>
    [HttpGet("models")]
    public async Task<IActionResult> GetImageGenModels(CancellationToken ct)
    {
        var codes = new[] { AppCallerCodes.Text2Img, AppCallerCodes.Img2Img, AppCallerCodes.VisionGen };
        const string modelType = "generation";

        var seen = new HashSet<string>();
        var merged = new List<ModelPoolForAppResult>();

        foreach (var code in codes)
        {
            var pools = await _modelPoolQuery.GetModelPoolsAsync(code, modelType, ct);
            foreach (var pool in pools)
            {
                if (seen.Add(pool.Id))
                {
                    merged.Add(pool);
                }
            }
        }

        return Ok(ApiResponse<List<ModelPoolForAppResult>>.Ok(merged));
    }

    /// <summary>
    /// 获取视觉创作"文生图"可用的模型池列表
    /// </summary>
    [HttpGet("models/text2img")]
    public async Task<IActionResult> GetText2ImgModels(CancellationToken ct)
    {
        var result = await _modelPoolQuery.GetModelPoolsAsync(AppCallerCodes.Text2Img, "generation", ct);
        return Ok(ApiResponse<List<ModelPoolForAppResult>>.Ok(result));
    }

    /// <summary>
    /// 获取视觉创作"图生图"可用的模型池列表
    /// </summary>
    [HttpGet("models/img2img")]
    public async Task<IActionResult> GetImg2ImgModels(CancellationToken ct)
    {
        var result = await _modelPoolQuery.GetModelPoolsAsync(AppCallerCodes.Img2Img, "generation", ct);
        return Ok(ApiResponse<List<ModelPoolForAppResult>>.Ok(result));
    }

    /// <summary>
    /// 获取视觉创作"多图合成"可用的模型池列表
    /// </summary>
    [HttpGet("models/vision")]
    public async Task<IActionResult> GetVisionGenModels(CancellationToken ct)
    {
        var result = await _modelPoolQuery.GetModelPoolsAsync(AppCallerCodes.VisionGen, "generation", ct);
        return Ok(ApiResponse<List<ModelPoolForAppResult>>.Ok(result));
    }

    /// <summary>
    /// 视觉分镜台：把一段想法/文章拆成若干"镜头"，每镜产出一个关键帧图 prompt（喂给生图引擎渲染）
    /// + 一个运动 prompt（预留给后续 image-to-video）。纯 LLM 调用；前端拿到后用现有生图链路渲染关键帧。
    /// </summary>
    [HttpPost("storyboard-script")]
    public async Task<IActionResult> StoryboardScript([FromBody] StoryboardScriptRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var brief = (request?.Brief ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(brief))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先填写想法或文章内容"));
        if (brief.Length > 20000) brief = brief[..20000];

        var style = (request?.Style ?? string.Empty).Trim();
        var sceneCount = Math.Clamp(request?.SceneCount ?? 0, 0, 12);

        const string appCallerCode = AppCallerRegistry.VisualAgent.Storyboard.Script;

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: adminId,
            ViewRole: "ADMIN",
            DocumentChars: brief.Length,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        var countHint = sceneCount > 0
            ? $"必须恰好拆成 {sceneCount} 个镜头。"
            : "拆成 4-8 个镜头（按内容繁简自定）。";
        var styleLine = string.IsNullOrWhiteSpace(style)
            ? "（你自定一种最适合内容的统一视觉风格）"
            : $"：{style}";

        var systemPrompt =
            "你是一位电影分镜导演 + 概念美术。把用户给的想法/文章拆成一组\"镜头\"，每个镜头先以一张关键帧静态图存在（后续可让它动起来）。\n"
            + countHint + "\n\n"
            + "每个镜头输出：\n"
            + "- topic：中文小标题（不超过 8 字）\n"
            + "- keyframePrompt：英文关键帧图生成 prompt，描述画面主体、构图、镜头景别（wide/medium/close-up）、光影、色调、质感，电影级，细节充分（30-60 词）\n"
            + "- motionPrompt：英文运动 prompt，描述这张图动起来时的镜头运动与主体动作（10-25 词），预留给后续 image-to-video\n"
            + "- duration：该镜头建议时长秒数（整数 3-8）\n\n"
            + "整组镜头视觉风格必须高度统一" + styleLine + "。每个 keyframePrompt 里都要体现这个统一风格，保证人物/色调/质感连贯。\n\n"
            + "禁止使用任何 emoji 字符（title / topic / keyframePrompt / motionPrompt 全部不得包含 emoji）。\n\n"
            + "只输出 JSON，不要解释、不要 markdown 代码块：\n"
            + "{\"title\":\"整组分镜中文标题(不超过14字)\",\"style\":\"英文统一风格描述\",\"scenes\":[{\"topic\":\"..\",\"keyframePrompt\":\"..\",\"motionPrompt\":\"..\",\"duration\":5}]}";

        var userMsg = string.IsNullOrWhiteSpace(style) ? brief : $"统一风格要求：{style}\n\n内容：\n{brief}";

        var resolution = await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.Chat, null, ct);
        if (!resolution.Success)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, $"模型调度失败：{resolution.ErrorMessage}"));

        var resp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Chat,
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userMsg },
                },
                ["temperature"] = 0.8,
            },
            TimeoutSeconds = 120,
        }, resolution, ct);

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
        {
            // 转发 gateway 已构造的中文报错（如 LLM_QUOTA_EXCEEDED 的额度文案），别用 ErrorCode 覆盖成泛化提示（Bugbot review）
            var detail = !string.IsNullOrWhiteSpace(resp.ErrorMessage)
                ? resp.ErrorMessage
                : (resp.ErrorCode ?? "未知错误");
            var failCode = string.IsNullOrWhiteSpace(resp.ErrorCode) ? ErrorCodes.LLM_ERROR : resp.ErrorCode!;
            return BadRequest(ApiResponse<object>.Fail(failCode, $"分镜生成失败：{detail}"));
        }

        var text = ExtractChatText(resp.Content);
        var parsed = ParseStoryboard(text);
        if (parsed == null || parsed.Scenes.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "分镜解析失败，请重试或调整描述"));

        return Ok(ApiResponse<StoryboardScriptResponse>.Ok(parsed));
    }

    private static string ExtractChatText(string apiResponseJson)
    {
        try
        {
            var doc = System.Text.Json.Nodes.JsonNode.Parse(apiResponseJson)?.AsObject();
            var content = doc?["choices"]?[0]?["message"]?["content"];
            if (content == null) return string.Empty;
            // content 可能是纯字符串、单个对象部件 {type,text}、或部件数组 [{type,text},..]（不同 chat 兼容网关形态不一）。
            // 任一形态当字符串读都会抛异常 → 退回整段响应 → ExtractFirstJsonObject 抓到外层 envelope 而非分镜 JSON（Bugbot review）。
            if (content is System.Text.Json.Nodes.JsonArray arr)
            {
                var sb = new System.Text.StringBuilder();
                foreach (var part in arr) sb.Append(PartText(part));
                return sb.ToString();
            }
            return PartText(content); // 纯字符串或单对象部件

            static string PartText(System.Text.Json.Nodes.JsonNode? node)
            {
                if (node is System.Text.Json.Nodes.JsonValue v) { try { return v.GetValue<string>() ?? string.Empty; } catch { return string.Empty; } }
                if (node is System.Text.Json.Nodes.JsonObject o) return o["text"]?.GetValue<string>() ?? string.Empty;
                return string.Empty;
            }
        }
        catch { return apiResponseJson; }
    }

    /// <summary>
    /// 从文本中提取第一个完整 JSON 对象：从首个 '{' 起按括号深度匹配（字符串内花括号不计、正确处理转义）。
    /// 比「首 { 到末 }」鲁棒：模型在 JSON 后夹带说明文字、或值里含 '}' 都不会截错。
    /// </summary>
    private static string? ExtractFirstJsonObject(string text)
    {
        var t = (text ?? string.Empty).Trim();
        // 去掉 markdown ```json 围栏
        if (t.StartsWith("```"))
        {
            var nl = t.IndexOf('\n');
            if (nl >= 0) t = t[(nl + 1)..];
            if (t.EndsWith("```")) t = t[..^3];
            t = t.Trim();
        }
        var start = t.IndexOf('{');
        if (start < 0) return null;
        int depth = 0;
        bool inStr = false, esc = false;
        for (var i = start; i < t.Length; i++)
        {
            var c = t[i];
            if (inStr)
            {
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
            }
            else if (c == '"') inStr = true;
            else if (c == '{') depth++;
            else if (c == '}')
            {
                depth--;
                if (depth == 0) return t[start..(i + 1)];
            }
        }
        return null; // 未闭合
    }

    private static StoryboardScriptResponse? ParseStoryboard(string text)
    {
        var json = ExtractFirstJsonObject(text);
        if (json == null) return null;
        try
        {
            var obj = System.Text.Json.Nodes.JsonNode.Parse(json)?.AsObject();
            var arr = obj?["scenes"]?.AsArray();
            if (obj == null || arr == null) return null;

            var res = new StoryboardScriptResponse
            {
                Title = StripEmoji(obj["title"]?.GetValue<string>()?.Trim()) is { Length: > 0 } t ? t : "未命名分镜",
                Style = StripEmoji(obj["style"]?.GetValue<string>()?.Trim()),
                Scenes = new List<StoryboardSceneDto>()
            };

            for (var i = 0; i < arr.Count; i++)
            {
                var it = arr[i]?.AsObject();
                if (it == null) continue;
                var kf = StripEmoji(it["keyframePrompt"]?.GetValue<string>()?.Trim());
                if (string.IsNullOrWhiteSpace(kf)) continue;

                var dur = 5;
                var dn = it["duration"];
                if (dn != null)
                {
                    try { dur = dn.GetValue<int>(); }
                    catch
                    {
                        try { dur = (int)Math.Round(dn.GetValue<double>()); }
                        catch
                        {
                            try { int.TryParse(dn.GetValue<string>(), out dur); } catch { /* keep default */ }
                        }
                    }
                }
                if (dur < 3) dur = 3;
                if (dur > 8) dur = 8;

                res.Scenes.Add(new StoryboardSceneDto
                {
                    Index = res.Scenes.Count,
                    Topic = StripEmoji(it["topic"]?.GetValue<string>()?.Trim()) is { Length: > 0 } tp ? tp : $"镜头 {res.Scenes.Count + 1}",
                    KeyframePrompt = kf,
                    MotionPrompt = StripEmoji(it["motionPrompt"]?.GetValue<string>()?.Trim()),
                    Duration = dur
                });
            }

            return res.Scenes.Count > 0 ? res : null;
        }
        catch { return null; }
    }

    // 防御性去除 emoji：CLAUDE.md/AGENTS.md §0 禁止 UI 渲染输出含 emoji，分镜 title/topic/prompt 由 LLM 生成，
    // 即便已在 system prompt 里要求无 emoji 也不赌模型自觉，落库/返回前再剥一层（Codex review）。
    // 覆盖：星平面字符(代理对，绝大多数 emoji)、杂项符号/dingbats/箭头/几何符号块、变体选择符、keycap 组合符。
    private static readonly System.Text.RegularExpressions.Regex EmojiRegex = new(
        @"[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    private static string StripEmoji(string? s)
    {
        if (string.IsNullOrEmpty(s)) return string.Empty;
        return EmojiRegex.Replace(s, string.Empty).Trim();
    }

    /// <summary>
    /// 获取模型适配信息（尺寸选项、能力等，纯静态注册表查询，无需数据库）
    /// </summary>
    /// <param name="modelId">平台侧模型ID（如 doubao-seedream-4-5、gpt-4-turbo）</param>
    [HttpGet("adapter-info")]
    public IActionResult GetAdapterInfo([FromQuery] string modelId)
    {
        if (string.IsNullOrWhiteSpace(modelId))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "modelId 不能为空"));
        }

        var adapterInfo = Infrastructure.LLM.ImageGenModelAdapterRegistry.GetAdapterInfo(modelId.Trim());
        if (adapterInfo == null || !adapterInfo.Matched)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                matched = false,
                modelId = modelId.Trim(),
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            matched = true,
            modelId = modelId.Trim(),
            adapterName = adapterInfo.AdapterName,
            displayName = adapterInfo.DisplayName,
            provider = adapterInfo.Provider,
            officialDocUrl = adapterInfo.OfficialDocUrl,
            lastUpdated = adapterInfo.LastUpdated,
            sizeConstraint = new
            {
                type = adapterInfo.SizeConstraintType,
                description = adapterInfo.SizeConstraintDescription,
            },
            sizesByResolution = adapterInfo.SizesByResolution,
            sizeParamFormat = adapterInfo.SizeParamFormat,
            limitations = new
            {
                mustBeDivisibleBy = adapterInfo.MustBeDivisibleBy,
                maxWidth = adapterInfo.MaxWidth,
                maxHeight = adapterInfo.MaxHeight,
                minWidth = adapterInfo.MinWidth,
                minHeight = adapterInfo.MinHeight,
                maxPixels = adapterInfo.MaxPixels,
                notes = adapterInfo.Notes,
            },
            supportsImageToImage = adapterInfo.SupportsImageToImage,
            supportsInpainting = adapterInfo.SupportsInpainting,
            isAdaptive = adapterInfo.IsAdaptive,
        }));
    }

    #endregion

    #region 日志查询（应用域内转发，避免前端跨权限调用 /api/logs/llm）

    /// <summary>
    /// 获取 visual-agent 相关的 LLM 请求日志（只读）
    /// 硬编码 requestPurpose 前缀为 visual-agent，避免数据泄露
    /// </summary>
    [HttpGet("logs")]
    public async Task<IActionResult> GetLogs(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null,
        [FromQuery] string? model = null,
        [FromQuery] string? status = null,
        [FromQuery] string? requestPurpose = null,
        CancellationToken ct = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 200);

        // 强制过滤 requestPurpose 以 visual-agent 开头
        var filter = Builders<LlmRequestLog>.Filter.Regex(
            x => x.AppCallerCode,
            new MongoDB.Bson.BsonRegularExpression("^visual-agent", "i"));

        if (from.HasValue) filter &= Builders<LlmRequestLog>.Filter.Gte(x => x.StartedAt, from.Value);
        if (to.HasValue) filter &= Builders<LlmRequestLog>.Filter.Lte(x => x.StartedAt, to.Value);
        if (!string.IsNullOrWhiteSpace(model)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Model, model);
        if (!string.IsNullOrWhiteSpace(status)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Status, status);
        if (!string.IsNullOrWhiteSpace(requestPurpose))
        {
            // 在 visual-agent 范围内进一步过滤
            var rp = requestPurpose.Trim();
            if (!rp.StartsWith("visual-agent", StringComparison.OrdinalIgnoreCase))
                rp = "visual-agent." + rp;
            filter &= Builders<LlmRequestLog>.Filter.Regex(
                x => x.AppCallerCode,
                new MongoDB.Bson.BsonRegularExpression($"^{Regex.Escape(rp)}", "i"));
        }

        var total = await _db.LlmRequestLogs.CountDocumentsAsync(filter, cancellationToken: ct);
        var rawItems = await _db.LlmRequestLogs.Find(filter)
            .SortByDescending(x => x.StartedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .Project(x => new
            {
                x.Id, x.RequestId, x.Provider, x.Model, x.PlatformId, x.PlatformName,
                x.ModelResolutionType, x.ModelGroupId, x.ModelGroupName,
                x.AppCallerCode, x.AppCallerCodeDisplayName,
                x.Status, x.StartedAt, x.FirstByteAt, x.EndedAt, x.DurationMs, x.StatusCode,
                x.InputTokens, x.OutputTokens, x.Error,
                x.QuestionText, x.AnswerText
            })
            .ToListAsync(ct);

        var items = rawItems.Select(x => new
        {
            x.Id, x.RequestId, x.Provider, x.Model, x.PlatformId, x.PlatformName,
            x.ModelResolutionType, x.ModelGroupId, x.ModelGroupName,
            x.AppCallerCode, x.AppCallerCodeDisplayName,
            x.Status, x.StartedAt, x.FirstByteAt, x.EndedAt, x.DurationMs, x.StatusCode,
            x.InputTokens, x.OutputTokens, x.Error,
            questionPreview = TruncatePreview(x.QuestionText, 260),
            answerPreview = TruncatePreview(x.AnswerText, 1800)
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 获取 visual-agent 日志的元数据（模型列表、状态列表等）
    /// 只返回 visual-agent 范围内的数据
    /// </summary>
    [HttpGet("logs/meta")]
    public async Task<IActionResult> GetLogsMeta(CancellationToken ct)
    {
        var vaFilter = Builders<LlmRequestLog>.Filter.Regex(
            x => x.AppCallerCode,
            new MongoDB.Bson.BsonRegularExpression("^visual-agent", "i"));

        var models = (await _db.LlmRequestLogs
                .Distinct(x => x.Model, vaFilter)
                .ToListAsync(ct))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var requestPurposeAggregation = await _db.LlmRequestLogs
            .Aggregate()
            .Match(vaFilter)
            .Group(x => x.AppCallerCode, g => new
            {
                Value = g.Key,
                StoredDisplayName = g.First().AppCallerCodeDisplayName
            })
            .ToListAsync(ct);

        var requestPurposes = requestPurposeAggregation
            .Where(x => !string.IsNullOrWhiteSpace(x.Value))
            .Select(x => new
            {
                value = x.Value,
                displayName = !string.IsNullOrWhiteSpace(x.StoredDisplayName)
                    ? x.StoredDisplayName
                    : AppCallerRegistrationService.FindByAppCode(x.Value!)?.DisplayName ?? x.Value
            })
            .OrderBy(x => x.displayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var statuses = new[] { "running", "succeeded", "failed", "cancelled" };

        return Ok(ApiResponse<object>.Ok(new { models, requestPurposes, statuses }));
    }

    /// <summary>
    /// 获取 visual-agent 日志详情
    /// </summary>
    [HttpGet("logs/{id}")]
    public async Task<IActionResult> GetLogDetail(string id, CancellationToken ct)
    {
        var log = await _db.LlmRequestLogs.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (log == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "日志不存在"));
        // 安全检查：只允许查看 visual-agent 的日志
        if (string.IsNullOrWhiteSpace(log.AppCallerCode) ||
            !log.AppCallerCode.StartsWith("visual-agent", StringComparison.OrdinalIgnoreCase))
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "日志不存在"));
        }
        return Ok(ApiResponse<object>.Ok(log));
    }

    private static string TruncatePreview(string? s, int maxChars)
    {
        var raw = (s ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        if (raw.Length <= maxChars) return raw;
        return raw[..maxChars] + "…";
    }

    #endregion

    /// <summary>
    /// 批量生图：先用意图模型解析"将生成多少张 + 每张的 prompt"
    /// </summary>
    [HttpPost("plan")]
    [ProducesResponseType(typeof(ApiResponse<ImageGenPlanResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> Plan([FromBody] ImageGenPlanRequest request, CancellationToken ct)
    {
        var text = (request?.Text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "text 不能为空"));
        }

        // 使用系统配置的字符限制（默认 200k，所有大模型请求输入的字符限制统一来源）
        var settings = await _settingsService.GetSettingsAsync(ct);
        var maxChars = LlmLogLimits.GetRequestBodyMaxChars(settings);
        if (text.Length > maxChars)
        {
            _logger.LogWarning("ImageGen plan text truncated: {OriginalLength} -> {MaxChars}", text.Length, maxChars);
            text = text[..maxChars];
        }

        var maxItems = request?.MaxItems ?? 10;
        maxItems = Math.Clamp(maxItems, 1, 20);

        var hasIntentModel = await _db.LLMModels.Find(m => m.IsIntent && m.Enabled).AnyAsync(ct);
        var usedPurpose = hasIntentModel ? "intent" : "fallbackMain";

        var adminId = GetAdminId();
        var systemPromptOverride = (request?.SystemPromptOverride ?? string.Empty).Trim();
        if (systemPromptOverride.Length > 20_000)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "systemPromptOverride 过长（最多 20000 字符）"));
        }

        var systemPrompt = string.Empty;
        if (!string.IsNullOrWhiteSpace(systemPromptOverride))
        {
            systemPrompt = systemPromptOverride;
        }
        else
        {
            // 读取管理员已保存的覆盖提示词（若存在则优先使用）
            var saved = await _db.AdminPromptOverrides
                .Find(x => x.OwnerAdminId == adminId && x.Key == "imageGenPlan")
                .FirstOrDefaultAsync(ct);
            systemPrompt = !string.IsNullOrWhiteSpace(saved?.PromptText) ? saved!.PromptText : ImageGenPlanPrompt.Build(maxItems);
        }

        try
        {
            var appCallerCode = VisualAgent.ImageGen.Plan;
            var llmClient = _gateway.CreateClient(appCallerCode, "intent");
            var requestContext = new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: adminId,
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[IMAGE_GEN_PLAN]",
                RequestType: "intent",
                AppCallerCode: appCallerCode);

            _logger.LogInformation("ImageGen.Plan: BeginScope with RequestType={RequestType}, AppCallerCode={AppCallerCode}",
                requestContext.RequestType, requestContext.AppCallerCode);

            using var _ = _llmRequestContext.BeginScope(requestContext);

            var messages = new List<LLMMessage> { new() { Role = "user", Content = text } };

            var raw = await CollectToTextAsync(llmClient, systemPrompt, messages, ct);
            var plan = TryParsePlan(raw, maxItems, out var err);
            if (plan == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "解析失败"));
            }

            // 统一限制：最多 20 张
            // 允许空清单：当文档中未识别到任何插图提示词时，返回 total=0 items=[]
            if (plan.Total < 0)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "解析失败：total 不合法"));
            }
            if (plan.Total > 20)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, $"单次最多生成 20 张（当前 {plan.Total} 张）"));
            }

            return Ok(ApiResponse<ImageGenPlanResponse>.Ok(new ImageGenPlanResponse
            {
                Total = plan.Total,
                Items = plan.Items,
                UsedPurpose = usedPurpose
            }));
        }
        catch (OperationCanceledException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求已取消"));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Image plan failed");
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "意图模型调用失败"));
        }
    }

    /// <summary>
    /// 提示词澄清：将用户自由文本改写为明确的英文生图提示词，降低生图失败率
    /// </summary>
    [HttpPost("clarify")]
    [ProducesResponseType(typeof(ApiResponse<ImageGenClarifyResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> ClarifyPrompt([FromBody] ImageGenClarifyRequest request, CancellationToken ct)
    {
        var originalPrompt = (request?.Prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(originalPrompt))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空"));
        }

        // 长度限制（澄清场景不需要长文本，上限 2000 字符足够）
        var prompt = originalPrompt.Length > 2000 ? originalPrompt[..2000] : originalPrompt;
        var hasRefImage = request?.HasReferenceImage ?? false;

        // 快速跳过：如果已经是高质量英文提示词（≥30 词，含描述性内容），直接返回
        var wordCount = prompt.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
        var looksLikeEnglishPrompt = wordCount >= 30 && Regex.IsMatch(prompt, @"^[\x20-\x7E\s]+$");
        if (looksLikeEnglishPrompt)
        {
            return Ok(ApiResponse<ImageGenClarifyResponse>.Ok(new ImageGenClarifyResponse
            {
                OriginalPrompt = originalPrompt,
                ClarifiedPrompt = prompt,
                WasModified = false
            }));
        }

        try
        {
            var appCallerCode = VisualAgent.ImageGen.Clarify;
            var llmClient = _gateway.CreateClient(appCallerCode, "intent", maxTokens: 512, temperature: 0.3);
            var requestContext = new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: GetAdminId(),
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[IMAGE_GEN_CLARIFY]",
                RequestType: "intent",
                AppCallerCode: appCallerCode);

            using var _ = _llmRequestContext.BeginScope(requestContext);

            var systemPrompt = ImageGenClarifyPrompt.Build(hasRefImage);
            var messages = new List<LLMMessage> { new() { Role = "user", Content = prompt } };

            var clarified = await CollectToTextAsync(llmClient, systemPrompt, messages, CancellationToken.None);
            clarified = (clarified ?? string.Empty).Trim();

            if (string.IsNullOrWhiteSpace(clarified))
            {
                // 兜底：澄清失败时返回原始输入
                return Ok(ApiResponse<ImageGenClarifyResponse>.Ok(new ImageGenClarifyResponse
                {
                    OriginalPrompt = originalPrompt,
                    ClarifiedPrompt = prompt,
                    WasModified = false
                }));
            }

            return Ok(ApiResponse<ImageGenClarifyResponse>.Ok(new ImageGenClarifyResponse
            {
                OriginalPrompt = originalPrompt,
                ClarifiedPrompt = clarified,
                WasModified = !string.Equals(clarified, prompt, StringComparison.OrdinalIgnoreCase)
            }));
        }
        catch (OperationCanceledException)
        {
            // CancellationToken.None 不会触发此异常，但防御性保留
            return Ok(ApiResponse<ImageGenClarifyResponse>.Ok(new ImageGenClarifyResponse
            {
                OriginalPrompt = originalPrompt,
                ClarifiedPrompt = prompt,
                WasModified = false
            }));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Image prompt clarify failed, falling back to original prompt");
            // 兜底：LLM 调用失败时返回原始输入，不阻断生图流程
            return Ok(ApiResponse<ImageGenClarifyResponse>.Ok(new ImageGenClarifyResponse
            {
                OriginalPrompt = originalPrompt,
                ClarifiedPrompt = prompt,
                WasModified = false
            }));
        }
    }

    /// <summary>
    /// 生图尺寸白名单缓存（用于前端展示"智能尺寸替换"状态）
    /// </summary>
    [HttpGet("size-caps")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetSizeCaps([FromQuery] bool includeFallback = false, CancellationToken ct = default)
    {
        var filter = includeFallback
            ? Builders<ImageGenSizeCaps>.Filter.Empty
            : Builders<ImageGenSizeCaps>.Filter.Ne(x => x.ModelId, null);

        var items = await _db.ImageGenSizeCaps
            .Find(filter)
            .Project(x => new
            {
                x.ModelId,
                x.PlatformId,
                x.ModelName,
                allowedSizes = x.AllowedSizes,
                allowedCount = x.AllowedSizes.Count,
                x.UpdatedAt
            })
            .SortByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 单张生图（将 prompt 一次性丢给生图模型生成）
    /// </summary>
    [HttpPost("generate")]
    [ProducesResponseType(typeof(ApiResponse<ImageGenResult>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> Generate([FromBody] ImageGenGenerateRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var prompt = (request?.Prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(prompt))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空"));
        }

        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var modelName = (request?.ModelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelName)) modelName = null;
        var appCallerCode = VisualAgent.ImageGen.Generate;
        GatewayModelResolution? resolved = null;
        if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(platformId))
        {
            resolved = await _gateway.ResolveModelAsync(appCallerCode, "generation", ct: ct);
            if (resolved != null)
            {
                platformId = resolved.ActualPlatformId;
                modelId = resolved.ActualModel;
                if (string.IsNullOrWhiteSpace(modelName)) modelName = resolved.ActualModel;
            }
        }

        // 单次允许一个提示词生成多张（上限 20；与“批量生图总上限”一致）
        var n = request?.N ?? 1;
        n = Math.Clamp(n, 1, 20);

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();
        // 统一参考图列表：优先使用 Images 字段，兼容旧的 InitImageBase64/Url/Sha256
        var images = request?.Images?.Where(x => !string.IsNullOrWhiteSpace(x)).ToList() ?? new List<string>();

        var initImageBase64 = (request?.InitImageBase64 ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(initImageBase64)) initImageBase64 = null;
        var initImageUrl = (request?.InitImageUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(initImageUrl)) initImageUrl = null;
        var initImageAssetSha256 = (request?.InitImageAssetSha256 ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(initImageAssetSha256)) initImageAssetSha256 = null;

        // 说明：即使后续因"Volces 降级"或其它原因把 initImageBase64 清空，也希望日志能追溯"用户是否提供过参考图"
        var initImageProvided = images.Count > 0
                                || !string.IsNullOrWhiteSpace(initImageBase64)
                                || !string.IsNullOrWhiteSpace(initImageUrl)
                                || !string.IsNullOrWhiteSpace(initImageAssetSha256);

        // 兼容：允许前端只传 URL / sha，服务端负责下载/读取并转为 base64（避免浏览器 CORS 与性能问题）
        if (initImageBase64 == null && !string.IsNullOrWhiteSpace(initImageAssetSha256))
        {
            var sha = initImageAssetSha256.Trim().ToLowerInvariant();
            if (sha.Length != 64 || !Regex.IsMatch(sha, "^[0-9a-f]{64}$"))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "initImageAssetSha256 格式不正确"));
            }

            // 权限：仅允许使用当前管理员自己的资产 sha
            var owned = await _db.ImageAssets.Find(x => x.OwnerUserId == adminId && x.Sha256 == sha).FirstOrDefaultAsync(ct);
            if (owned == null)
            {
                return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权使用该参考图"));
            }

            var found = await _assetStorage.TryReadByShaAsync(sha, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
            if (found == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "参考图文件不存在或不可用"));
            }
            if (found.Value.bytes.Length > 10 * 1024 * 1024)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "参考图过大（上限 10MB）"));
            }
            var b64 = Convert.ToBase64String(found.Value.bytes);
            var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? "image/png" : found.Value.mime.Trim();
            initImageBase64 = $"data:{mime};base64,{b64}";
        }

        if (initImageBase64 == null && !string.IsNullOrWhiteSpace(initImageUrl))
        {
            if (!TryValidateExternalImageUrl(initImageUrl, out var uri) || uri == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "initImageUrl 不合法（仅允许 https 外链）"));
            }
            if (!await IsPublicHostAsync(uri, ct))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "initImageUrl 不合法（禁止内网/本机地址）"));
            }
            try
            {
                var (bytes, mime) = await DownloadExternalAsync(uri, ct);
                if (bytes.Length > 10 * 1024 * 1024)
                {
                    return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "参考图过大（上限 10MB）"));
                }
                var b64 = Convert.ToBase64String(bytes);
                var ctMime = string.IsNullOrWhiteSpace(mime) ? "image/png" : mime.Trim();
                initImageBase64 = $"data:{ctMime};base64,{b64}";
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "ImageGen initImageUrl download failed: {Url}", uri.ToString());
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "参考图下载失败"));
            }
        }

        // seedream/volces：多数情况下不支持 OpenAI 标准 images/edits 的“首帧图生图”语义。
        // 策略：检测到 volces API 时，将首帧图交给 Vision 模型提取风格描述，拼进 prompt，再走 images/generations。
        if (!string.IsNullOrWhiteSpace(initImageBase64))
        {
            var apiUrlForDetect = await TryResolveImageGenApiUrlAsync(modelId, platformId, ct);
            if (IsVolcesApiUrl(apiUrlForDetect))
            {
                var styleHint = await TryExtractStyleHintAsync(initImageBase64, ct);
                if (!string.IsNullOrWhiteSpace(styleHint))
                {
                    prompt = $"{prompt}\n\n【参考首帧风格】\n{styleHint}";
                    // 不再走 edits（避免“看似支持但实际忽略”的错觉）
                    initImageBase64 = null;
                }
                else
                {
                    // 无法提取风格：仍降级为纯文生图（并让前端通过提示告知用户）
                    initImageBase64 = null;
                }
            }
        }

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: adminId,
            ViewRole: "ADMIN",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[IMAGE_GEN_GENERATE]",
            RequestType: "imageGen",
            AppCallerCode: appCallerCode));

        // 合并所有参考图来源到统一列表
        if (images.Count == 0 && !string.IsNullOrWhiteSpace(initImageBase64))
        {
            images.Add(initImageBase64);
        }
        var maskB64 = string.IsNullOrWhiteSpace(request?.MaskBase64) ? null : request!.MaskBase64!.Trim();
        var res = await _imageClient.GenerateUnifiedAsync(prompt, n, size, responseFormat, ct, appCallerCode,
            images: images.Count > 0 ? images : null, modelId, platformId, modelName, maskBase64: maskB64);
        if (!res.Success)
        {
            // 将 LLM_ERROR 映射为 502，其他保持 400
            var code = res.Error?.Code ?? ErrorCodes.INTERNAL_ERROR;
            if (code == ErrorCodes.LLM_ERROR)
            {
                return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(code, res.Error?.Message ?? "生图失败"));
            }
            return BadRequest(ApiResponse<object>.Fail(code, res.Error?.Message ?? "生图失败"));
        }

        return Ok(ApiResponse<ImageGenResult>.Ok(res.Data!));
    }

    /// <summary>
    /// 多图组合生成：解析用户指令中的多图关系，生成组合图片
    /// </summary>
    [HttpPost("compose")]
    [ProducesResponseType(typeof(ApiResponse<ImageGenComposeResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> Compose([FromBody] ImageGenComposeRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var instruction = (request?.Instruction ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(instruction))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "instruction 不能为空"));
        }

        var images = request?.Images ?? new List<ImageGenComposeImageRef>();
        if (images.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "images 不能为空"));
        }

        if (images.Count > 10)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "最多支持 10 张图片"));
        }

        // 转换为服务层的 ImageReference
        var imageRefs = images.Select(x => new ImageReference
        {
            Index = x.Index,
            AssetId = x.AssetId,
            Name = x.Name
        }).ToList();

        // 1. 解析组合意图
        ComposeIntentResult intentResult;
        try
        {
            intentResult = await _composeService.ParseComposeIntentAsync(instruction, imageRefs, adminId, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Compose intent parsing failed");
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "意图解析失败"));
        }

        if (string.IsNullOrWhiteSpace(intentResult.GeneratedPrompt))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法解析组合意图"));
        }

        // 2. 如果仅请求解析（不生图），直接返回 Prompt
        if (request?.ParseOnly == true)
        {
            return Ok(ApiResponse<ImageGenComposeResponse>.Ok(new ImageGenComposeResponse
            {
                GeneratedPrompt = intentResult.GeneratedPrompt,
                Images = new List<ImageGenImage>(),
                ImageDescriptions = intentResult.ImageDescriptions.Select(x => new ImageDescriptionDto
                {
                    Index = x.Index,
                    AssetId = x.AssetId,
                    Description = x.Description,
                    HasDescription = x.HasDescription
                }).ToList()
            }));
        }

        // 3. 调用生图模型
        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var configModelId = (request?.ConfigModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(configModelId)) configModelId = null;

        // 如果提供了 configModelId，解析 platformId 和 modelId
        if (!string.IsNullOrWhiteSpace(configModelId))
        {
            var m = await _db.LLMModels.Find(x => x.Id == configModelId && x.Enabled).FirstOrDefaultAsync(ct);
            if (m != null)
            {
                platformId = m.PlatformId;
                modelId = m.ModelName;
            }
        }

        // 如果仍然没有模型信息，使用调度器解析
        var appCallerCode = AppCallerRegistry.VisualAgent.Compose.Generation;
        GatewayModelResolution? resolved = null;
        if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(platformId))
        {
            resolved = await _gateway.ResolveModelAsync(appCallerCode, "generation", ct: ct);
            if (resolved != null)
            {
                platformId = resolved.ActualPlatformId;
                modelId = resolved.ActualModel;
            }
        }

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: adminId,
            ViewRole: "ADMIN",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[IMAGE_GEN_COMPOSE]",
            RequestType: "imageGen",
            AppCallerCode: appCallerCode));

        var res = await _imageClient.GenerateAsync(intentResult.GeneratedPrompt, n: 1, size, responseFormat, ct, appCallerCode, modelId, platformId);
        if (!res.Success)
        {
            var code = res.Error?.Code ?? ErrorCodes.INTERNAL_ERROR;
            if (code == ErrorCodes.LLM_ERROR)
            {
                return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(code, res.Error?.Message ?? "生图失败"));
            }
            return BadRequest(ApiResponse<object>.Fail(code, res.Error?.Message ?? "生图失败"));
        }

        return Ok(ApiResponse<ImageGenComposeResponse>.Ok(new ImageGenComposeResponse
        {
            GeneratedPrompt = intentResult.GeneratedPrompt,
            Images = res.Data?.Images ?? new List<ImageGenImage>(),
            ImageDescriptions = intentResult.ImageDescriptions.Select(x => new ImageDescriptionDto
            {
                Index = x.Index,
                AssetId = x.AssetId,
                Description = x.Description,
                HasDescription = x.HasDescription
            }).ToList()
        }));
    }

    private static bool TryValidateExternalImageUrl(string raw, out Uri? uri)
    {
        uri = null;
        if (!Uri.TryCreate((raw ?? string.Empty).Trim(), UriKind.Absolute, out var u)) return false;
        if (!string.Equals(u.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return false;
        if (string.IsNullOrWhiteSpace(u.Host)) return false;
        if (string.Equals(u.Host, "localhost", StringComparison.OrdinalIgnoreCase)) return false;
        uri = u;
        return true;
    }

    private static bool IsBlockedIp(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;

        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10
            if (b[0] == 0) return true;
            if (b[0] == 10) return true;
            if (b[0] == 127) return true;
            if (b[0] == 169 && b[1] == 254) return true;
            if (b[0] == 192 && b[1] == 168) return true;
            if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
            if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return true;
        }
        else if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (ip.IsIPv6LinkLocal) return true;
            if (ip.IsIPv6SiteLocal) return true;
            if (ip.IsIPv6Multicast) return true;
            // Unique local fc00::/7
            var b = ip.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) return true;
        }

        return false;
    }

    private static async Task<bool> IsPublicHostAsync(Uri uri, CancellationToken ct)
    {
        // Host 是 IP 时直接判断
        if (IPAddress.TryParse(uri.Host, out var ip))
        {
            return !IsBlockedIp(ip);
        }

        try
        {
            var ips = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, ct);
            if (ips == null || ips.Length == 0) return false;
            // 任意一个解析到内网/保留地址 => 拒绝（防止 DNS rebinding）
            return ips.All(x => !IsBlockedIp(x));
        }
        catch
        {
            return false;
        }
    }

    private async Task<(byte[] bytes, string mime)> DownloadExternalAsync(Uri uri, CancellationToken ct)
    {
        var http = _httpClientFactory.CreateClient("LoggedHttpClient");
        http.Timeout = TimeSpan.FromSeconds(60);
        http.DefaultRequestHeaders.Remove("Authorization");
        using var req = new HttpRequestMessage(HttpMethod.Get, uri);
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!resp.IsSuccessStatusCode)
        {
            _logger.LogWarning("ImageGen download failed: HTTP {Status} host={Host}", (int)resp.StatusCode, uri.Host);
            throw new InvalidOperationException("下载失败");
        }
        var mime = resp.Content.Headers.ContentType?.MediaType ?? "image/png";
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var ms = new MemoryStream(capacity: 1024 * 1024);
        await stream.CopyToAsync(ms, ct);
        return (ms.ToArray(), mime);
    }

    private async Task<string?> TryResolveImageGenApiUrlAsync(string? modelId, string? platformId, CancellationToken ct)
    {
        // 优先模型配置
        if (!string.IsNullOrWhiteSpace(modelId))
        {
            var m = await _db.LLMModels.Find(x => x.Id == modelId && x.Enabled).FirstOrDefaultAsync(ct);
            if (m != null)
            {
                if (!string.IsNullOrWhiteSpace(m.ApiUrl)) return m.ApiUrl;
                if (!string.IsNullOrWhiteSpace(m.PlatformId))
                {
                    var p = await _db.LLMPlatforms.Find(x => x.Id == m.PlatformId && x.Enabled).FirstOrDefaultAsync(ct);
                    if (p != null && !string.IsNullOrWhiteSpace(p.ApiUrl)) return p.ApiUrl;
                }
            }
        }

        // 平台回退调用
        if (!string.IsNullOrWhiteSpace(platformId))
        {
            var p = await _db.LLMPlatforms.Find(x => x.Id == platformId && x.Enabled).FirstOrDefaultAsync(ct);
            if (p != null && !string.IsNullOrWhiteSpace(p.ApiUrl)) return p.ApiUrl;
        }
        return null;
    }

    private static bool IsVolcesApiUrl(string? apiUrl)
    {
        var raw = (apiUrl ?? string.Empty).Trim().TrimEnd('#');
        if (string.IsNullOrWhiteSpace(raw)) return false;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var u)) return false;
        return u.Host.EndsWith("volces.com", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<string?> TryExtractStyleHintAsync(string initImageBase64, CancellationToken ct)
    {
        if (!TryParseDataUrlOrBase64(initImageBase64, out var mime, out var b64)) return null;
        if (string.IsNullOrWhiteSpace(b64)) return null;

        try
        {
            var appCallerCode = VisualAgent.ImageGen.ExtractStyle;
            var llmClient = _gateway.CreateClient(appCallerCode, "vision");
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: GetAdminId(),
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[IMAGE_GEN_EXTRACT_STYLE]",
                RequestType: "vision",
                AppCallerCode: appCallerCode));

            var systemPrompt =
                "你是“图片风格提取器”。你的任务：根据输入图片，提取可直接用于生图模型的风格描述。\n" +
                "要求：\n" +
                "- 只输出风格描述，不要解释过程\n" +
                "- 输出中文，80-160字\n" +
                "- 关注：构图、光照、色彩、材质、镜头感、景深、氛围、画面风格（写实/插画/3D/胶片等）\n" +
                "- 不要出现“这张图里有……”的叙述口吻；用“风格指令”写法\n";

            var msg = new LLMMessage
            {
                Role = "user",
                Content = "请提取该图片的风格指令。",
                Attachments = new List<LLMAttachment>
                {
                    new()
                    {
                        Type = "image",
                        MimeType = mime,
                        Base64Data = b64
                    }
                }
            };

            var raw = await CollectToTextAsync(llmClient, systemPrompt, new List<LLMMessage> { msg }, ct);
            var s = NormalizeStyleHint(raw);
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }
        catch
        {
            return null;
        }
    }

    private static string NormalizeStyleHint(string raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return string.Empty;
        // 取第一段，避免模型输出多段
        s = Regex.Replace(s, @"\n{3,}", "\n\n");
        if (s.Length > 220) s = s[..220].Trim();
        return s;
    }

    private static bool TryParseDataUrlOrBase64(string raw, out string mime, out string base64)
    {
        mime = "image/png";
        base64 = string.Empty;
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return false;
        if (s.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = s.IndexOf(',');
            if (comma < 0) return false;
            var header = s.Substring(5, comma - 5);
            var payload = s[(comma + 1)..];
            var semi = header.IndexOf(';');
            var ct = semi >= 0 ? header[..semi] : header;
            if (!string.IsNullOrWhiteSpace(ct)) mime = ct.Trim();
            s = payload.Trim();
        }
        // 仅保留 base64 内容
        base64 = s;
        return !string.IsNullOrWhiteSpace(base64);
    }

    /// <summary>
    /// 批量生图（SSE）：前端在确认 total 后才会调用
    /// </summary>
    [HttpPost("batch/stream")]
    [Produces("text/event-stream")]
    public async Task BatchStream([FromBody] ImageGenBatchRequest request, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var adminId = GetAdminId();
        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var modelName = (request?.ModelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelName)) modelName = null;
        var appCallerCode = VisualAgent.ImageGen.BatchGenerate;
        GatewayModelResolution? resolved = null;
        if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(platformId))
        {
            resolved = await _gateway.ResolveModelAsync(appCallerCode, "generation", ct: cancellationToken);
            if (resolved != null)
            {
                platformId = resolved.ActualPlatformId;
                modelId = resolved.ActualModel;
                if (string.IsNullOrWhiteSpace(modelName)) modelName = resolved.ActualModel;
            }
        }
        var items = request?.Items ?? new List<ImageGenPlanItem>();
        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();

        if (items.Count == 0)
        {
            await WriteEventAsync("run", new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "items 不能为空" }, cancellationToken);
            return;
        }

        // 统一限制：最多 20 张
        var total = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var c = items[i].Count <= 0 ? 1 : items[i].Count;
            total += c;
        }
        if (total > 20)
        {
            await WriteEventAsync("run", new { type = "error", errorCode = ErrorCodes.RATE_LIMITED, errorMessage = $"单次最多生成 20 张（当前 {total} 张）" }, cancellationToken);
            return;
        }

        var runId = Guid.NewGuid().ToString("N");
        await WriteEventAsync("run", new { type = "runStart", runId, adminId, total, modelId, platformId, modelName }, cancellationToken);

        var done = 0;
        var failed = 0;

        // 使用 SemaphoreSlim 控制并发数
        var maxConc = Math.Clamp(request?.MaxConcurrency ?? 3, 1, 10);
        var sem = new SemaphoreSlim(maxConc, maxConc);
        var writeLock = new SemaphoreSlim(1, 1);
        var tasks = new List<Task>();

        // 收集所有需要生成的图片任务
        for (var itemIndex = 0; itemIndex < items.Count; itemIndex++)
        {
            var prompt = (items[itemIndex].Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(prompt))
            {
                failed += Math.Max(1, items[itemIndex].Count);
                await WriteEventAsync("image", new { type = "imageError", runId, itemIndex, imageIndex = 0, prompt = "", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "prompt 不能为空" }, cancellationToken);
                continue;
            }

            var itemSize = string.IsNullOrWhiteSpace(items[itemIndex].Size) ? size : items[itemIndex].Size!.Trim();
            var count = Math.Clamp(items[itemIndex].Count <= 0 ? 1 : items[itemIndex].Count, 1, 5);
            for (var k = 0; k < count; k++)
            {
                if (cancellationToken.IsCancellationRequested) break;

                var currentItemIndex = itemIndex;
                var imageIndex = k;
                var currentPrompt = prompt;
                var currentSize = itemSize;

                // 创建并发任务
                tasks.Add(Task.Run(async () =>
                {
                    await sem.WaitAsync(cancellationToken);
                    try
                    {
                        // 发送开始事件
                        await writeLock.WaitAsync(cancellationToken);
                        try
                        {
                            await WriteEventAsync("image", new { type = "imageStart", runId, itemIndex = currentItemIndex, imageIndex, prompt = currentPrompt, size = currentSize }, cancellationToken);
                        }
                        finally
                        {
                            writeLock.Release();
                        }

                        try
                        {
                            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                                RequestId: Guid.NewGuid().ToString("N"),
                                GroupId: null,
                                SessionId: null,
                                UserId: adminId,
                                ViewRole: "ADMIN",
                                DocumentChars: null,
                                DocumentHash: null,
                                SystemPromptRedacted: "[IMAGE_GEN_BATCH_GENERATE]",
                                RequestType: "imageGen",
                                AppCallerCode: appCallerCode));

                            var res = await _imageClient.GenerateAsync(currentPrompt, n: 1, currentSize, responseFormat, cancellationToken, appCallerCode, modelId, platformId, modelName);
                            
                            await writeLock.WaitAsync(cancellationToken);
                            try
                            {
                                if (!res.Success)
                                {
                                    Interlocked.Increment(ref failed);
                                    await WriteEventAsync("image", new
                                    {
                                        type = "imageError",
                                        runId,
                                        itemIndex = currentItemIndex,
                                        imageIndex,
                                        prompt = currentPrompt,
                                        requestedSize = currentSize,
                                        modelId,
                                        platformId,
                                        modelName,
                                        errorCode = res.Error?.Code ?? ErrorCodes.LLM_ERROR,
                                        errorMessage = res.Error?.Message ?? "生图失败"
                                    }, cancellationToken);
                                    return;
                                }

                                var first = res.Data?.Images?.FirstOrDefault();
                                var meta = res.Data?.Meta;
                                Interlocked.Increment(ref done);
                                await WriteEventAsync("image", new
                                {
                                    type = "imageDone",
                                    runId,
                                    itemIndex = currentItemIndex,
                                    imageIndex,
                                    prompt = currentPrompt,
                                    requestedSize = currentSize,
                                    effectiveSize = meta?.EffectiveSize,
                                    sizeAdjusted = meta?.SizeAdjusted ?? false,
                                    ratioAdjusted = meta?.RatioAdjusted ?? false,
                                    modelId,
                                    platformId,
                                    modelName,
                                    base64 = first?.Base64,
                                    url = first?.Url,
                                    revisedPrompt = first?.RevisedPrompt
                                }, cancellationToken);
                            }
                            finally
                            {
                                writeLock.Release();
                            }
                        }
                        catch (Exception ex)
                        {
                            await writeLock.WaitAsync(cancellationToken);
                            try
                            {
                                Interlocked.Increment(ref failed);
                                await WriteEventAsync("image", new
                                {
                                    type = "imageError",
                                    runId,
                                    itemIndex = currentItemIndex,
                                    imageIndex,
                                    prompt = currentPrompt,
                                    requestedSize = currentSize,
                                    modelId,
                                    platformId,
                                    modelName,
                                    errorCode = ErrorCodes.LLM_ERROR,
                                    errorMessage = ex.Message
                                }, cancellationToken);
                            }
                            finally
                            {
                                writeLock.Release();
                            }
                        }
                    }
                    finally
                    {
                        sem.Release();
                    }
                }, cancellationToken));
            }
        }

        // 等待所有任务完成
        try
        {
            await Task.WhenAll(tasks);
        }
        catch (OperationCanceledException)
        {
            // 取消时忽略异常
        }

        await WriteEventAsync("run", new { type = "runDone", runId, total, done, failed, endedAt = DateTime.UtcNow }, cancellationToken);
    }

    /// <summary>
    /// 创建生图任务（runId）：用于断线可恢复的批量/单张生图
    /// </summary>
    [HttpPost("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateRun([FromBody] CreateImageGenRunRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].FirstOrDefault() ?? string.Empty).Trim();
        if (idemKey.Length > 200) idemKey = idemKey[..200];

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
            if (existed != null)
            {
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
                return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
            }
        }

        var cfgModelId = (request?.ConfigModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(cfgModelId)) cfgModelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var modelNameLegacy = (request?.ModelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelNameLegacy)) modelNameLegacy = null;
        modelId ??= modelNameLegacy;

        if (!string.IsNullOrWhiteSpace(cfgModelId))
        {
            var m = await _db.LLMModels.Find(x => x.Id == cfgModelId && x.Enabled).FirstOrDefaultAsync(ct);
            if (m == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "指定的模型不存在或未启用"));
            }
            platformId = m.PlatformId;
            modelId = m.ModelName;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelId))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "必须提供 configModelId，或提供 platformId + modelId"));
            }
        }

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();
        var maxConc = Math.Clamp(request?.MaxConcurrency ?? 3, 1, 10);

        var items = request?.Items ?? new List<ImageGenRunPlanItemInput>();
        if (items.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "items 不能为空"));
        }
        // 清洗与限制：单条最多 5 张，总计最多 20 张
        var plan = new List<ImageGenRunPlanItem>();
        var total = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var p = (items[i].Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(p)) continue;
            var c = Math.Clamp(items[i].Count <= 0 ? 1 : items[i].Count, 1, 5);
            var s = (items[i].Size ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(s)) s = null;
            plan.Add(new ImageGenRunPlanItem { Prompt = p, Count = c, Size = s });
            total += c;
            if (total > 20) break;
        }
        if (plan.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "items 不能为空（无有效 prompt）"));
        }
        if (total > 20)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, $"单次最多生成 20 张（当前 {total} 张）"));
        }

        // 可选：绑定 WorkspaceId（若提供，生成的图片会自动保存到 COS）
        var workspaceId = (request?.WorkspaceId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(workspaceId)) workspaceId = null;

        // AppKey（用于水印等功能隔离）
        // 优先从请求体读取，如果没有则从请求头 X-App-Name 读取
        var appKey = (request?.AppKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(appKey))
        {
            appKey = (Request.Headers["X-App-Name"].ToString() ?? string.Empty).Trim();
        }
        if (string.IsNullOrWhiteSpace(appKey)) appKey = null;

        // 模型池调度逻辑统一在 ImageGenRunWorker 中处理
        // 只允许已注册的 AppCallerCode（禁止拼接/隐式生成）
        var resolvedAppCallerCode = (request?.AppCallerCode ?? string.Empty).Trim();
        
        // 参考图/底图 SHA256（提前检查，用于决定 appCallerCode）
        var initImageAssetSha256 = (request?.InitImageAssetSha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(initImageAssetSha256)) initImageAssetSha256 = null;
        
        // 文学创作场景：检查是否有激活的参考图配置（必须按用户隔离）
        bool hasActiveReferenceImage = false;
        if (string.Equals(appKey, "literary-agent", StringComparison.OrdinalIgnoreCase) && initImageAssetSha256 == null)
        {
            var activeRefConfig = await _db.ReferenceImageConfigs
                .Find(x => x.AppKey == "literary-agent" && x.IsActive && x.CreatedByAdminId == adminId)
                .FirstOrDefaultAsync(ct);
            hasActiveReferenceImage = activeRefConfig != null && !string.IsNullOrWhiteSpace(activeRefConfig.ImageSha256);
        }
        
        if (string.IsNullOrWhiteSpace(resolvedAppCallerCode))
        {
            if (string.Equals(appKey, "visual-agent", StringComparison.OrdinalIgnoreCase))
            {
                resolvedAppCallerCode = VisualAgent.Image.Text2Img; // 默认文生图，后续根据参考图切换
            }
            else if (string.Equals(appKey, "literary-agent", StringComparison.OrdinalIgnoreCase))
            {
                // 根据是否有参考图选择 Text2Img 或 Img2Img
                resolvedAppCallerCode = (initImageAssetSha256 != null || hasActiveReferenceImage)
                    ? LiteraryAgent.Illustration.Img2Img
                    : LiteraryAgent.Illustration.Text2Img;
            }
        }
        if (!IsRegisteredImageGenAppCaller(resolvedAppCallerCode))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "appCallerCode 未注册或不支持 imageGen"));
        }

        // 文学创作场景：关联的配图标记索引
        var articleMarkerIndex = request?.ArticleMarkerIndex;

        // 参考图风格提示词（用于追加到生图 prompt）
        string? referenceImagePrompt = null;

        // 文学创作场景：若未指定参考图，自动从当前用户的配置中获取底图
        if (initImageAssetSha256 == null && appKey == "literary-agent")
        {
            // 优先从新的 ReferenceImageConfigs 获取当前用户激活的配置
            var activeRefConfig = await _db.ReferenceImageConfigs
                .Find(x => x.AppKey == "literary-agent" && x.IsActive && x.CreatedByAdminId == adminId)
                .FirstOrDefaultAsync(ct);

            if (activeRefConfig != null && !string.IsNullOrWhiteSpace(activeRefConfig.ImageSha256))
            {
                initImageAssetSha256 = activeRefConfig.ImageSha256.Trim().ToLowerInvariant();
                referenceImagePrompt = activeRefConfig.Prompt;
            }
            else
            {
                // 回退到旧的 LiteraryAgentConfigs
                var literaryConfig = await _db.LiteraryAgentConfigs.Find(x => x.Id == "literary-agent").FirstOrDefaultAsync(ct);
                if (literaryConfig != null && !string.IsNullOrWhiteSpace(literaryConfig.ReferenceImageSha256))
                {
                    initImageAssetSha256 = literaryConfig.ReferenceImageSha256.Trim().ToLowerInvariant();
                }
            }
        }

        // 如果有参考图风格提示词，追加到每个 plan item 的 prompt 中
        // DisplayPrompt 在追加前保存原始用户 prompt，避免系统提示词泄漏到消息记录
        if (!string.IsNullOrWhiteSpace(referenceImagePrompt) && initImageAssetSha256 != null)
        {
            for (var i = 0; i < plan.Count; i++)
            {
                plan[i].DisplayPrompt = plan[i].Prompt;
                plan[i].Prompt = $"{referenceImagePrompt}\n\n{plan[i].Prompt}";
            }
        }

        var run = new ImageGenRun
        {
            OwnerAdminId = adminId,
            Status = ImageGenRunStatus.Queued,
            ConfigModelId = cfgModelId,
            PlatformId = platformId,
            ModelId = modelId,
            // ⚠ 用户显式选择优先：同 ImageMasterController.CreateWorkspaceImageGenRun。
            ModelResolutionType = PrdAgent.Core.Models.ModelResolutionType.DirectModel,
            Size = size,
            ResponseFormat = responseFormat,
            MaxConcurrency = maxConc,
            Items = plan,
            Total = total,
            Done = 0,
            Failed = 0,
            CancelRequested = false,
            LastSeq = 0,
            IdempotencyKey = string.IsNullOrWhiteSpace(idemKey) ? null : idemKey,
            WorkspaceId = workspaceId,
            AppCallerCode = resolvedAppCallerCode,
            AppKey = appKey,
            ArticleMarkerIndex = articleMarkerIndex,
            InitImageAssetSha256 = initImageAssetSha256,
            MaskBase64 = string.IsNullOrWhiteSpace(request?.MaskBase64) ? null : request!.MaskBase64!.Trim(),
            CreatedAt = DateTime.UtcNow
        };

        try
        {
            await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: ct);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && !string.IsNullOrWhiteSpace(idemKey))
        {
            // 幂等键并发冲突：返回已存在的 run
            var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
            if (existed != null)
            {
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
                return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
            }
            throw;
        }

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
    }

    /// <summary>
    /// 查询生图任务状态/进度（可选返回 items）
    /// </summary>
    [HttpGet("runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetRun(string runId, [FromQuery] bool includeItems = true, [FromQuery] bool includeImages = false, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        }

        var run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId).FirstOrDefaultAsync(ct);
        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, "run 不存在"));
        }

        object? items = null;
        if (includeItems)
        {
            var list = await _db.ImageGenRunItems
                .Find(x => x.RunId == runId && x.OwnerAdminId == adminId)
                .SortBy(x => x.ItemIndex).ThenBy(x => x.ImageIndex)
                .ToListAsync(ct);
            items = list.Select(x => new
            {
                x.RunId,
                x.ItemIndex,
                x.ImageIndex,
                x.Prompt,
                x.RequestedSize,
                x.EffectiveSize,
                x.SizeAdjusted,
                x.RatioAdjusted,
                status = x.Status.ToString(),
                base64 = includeImages ? x.Base64 : null,
                x.Url,
                x.RevisedPrompt,
                x.ErrorCode,
                x.ErrorMessage,
                x.CreatedAt,
                x.StartedAt,
                x.EndedAt
            });
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            run = new
            {
                run.Id,
                run.OwnerAdminId,
                status = run.Status.ToString(),
                run.ConfigModelId,
                run.PlatformId,
                run.ModelId,
                run.Size,
                run.ResponseFormat,
                run.MaxConcurrency,
                run.Total,
                run.Done,
                run.Failed,
                run.CancelRequested,
                run.LastSeq,
                run.CreatedAt,
                run.StartedAt,
                run.EndedAt
            },
            items
        }));
    }

    /// <summary>
    /// 订阅生图任务事件（SSE）：支持 afterSeq 断线续传
    /// </summary>
    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task RunStream(string runId, [FromQuery] long afterSeq = 0, CancellationToken cancellationToken = default)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            await WriteSseAsync(id: null, eventName: "run", dataJson: JsonSerializer.Serialize(new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "runId 不能为空" }, JsonOptions), cancellationToken);
            return;
        }

        var run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId).FirstOrDefaultAsync(cancellationToken);
        if (run == null)
        {
            await WriteSseAsync(id: null, eventName: "run", dataJson: JsonSerializer.Serialize(new { type = "error", errorCode = ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, errorMessage = "run 不存在" }, JsonOptions), cancellationToken);
            return;
        }

        // snapshot（可选）：用于断线恢复时快速拿到当前进度
        var snap = await _runStore.GetSnapshotAsync(RunKinds.ImageGen, runId, cancellationToken);
        if (snap != null && snap.Seq > afterSeq)
        {
            await WriteSseAsync(id: snap.Seq.ToString(), eventName: "run", dataJson: snap.SnapshotJson, cancellationToken);
            afterSeq = snap.Seq;
        }

        var lastKeepAliveAt = DateTime.UtcNow;
        while (!cancellationToken.IsCancellationRequested)
        {
            // 取一批事件，避免一次性刷太多
            var evts = await _runStore.GetEventsAsync(RunKinds.ImageGen, runId, afterSeq, limit: 120, cancellationToken);

            if (evts.Count > 0)
            {
                foreach (var e in evts)
                {
                    await WriteSseAsync(id: e.Seq.ToString(), eventName: e.EventName, dataJson: e.PayloadJson, cancellationToken);
                    afterSeq = e.Seq;
                }
                lastKeepAliveAt = DateTime.UtcNow;
            }
            else
            {
                // keepalive：避免代理/浏览器超时关闭连接
                if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
                {
                    await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                }

                // 如果 run 已结束且已追到最新 seq，则关闭 SSE
                run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId).FirstOrDefaultAsync(cancellationToken);
                if (run == null) break;
                if (run.Status is ImageGenRunStatus.Completed or ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled)
                {
                    // run.LastSeq 不再按事件频率更新（避免 Mongo 写放大）；改为“run 已结束且一段时间无新事件”就退出
                    if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 2) break;
                }

                await Task.Delay(650, cancellationToken);
            }
        }
    }

    /// <summary>
    /// 请求取消生图任务（后台会尽量停止继续派发新的生成）
    /// </summary>
    [HttpPost("runs/{runId}/cancel")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> CancelRun(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        }

        var res = await _db.ImageGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.OwnerAdminId == adminId,
            Builders<ImageGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        if (res.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, "run 不存在"));
        }

        return Ok(ApiResponse<object>.Ok(true));
    }

    private async Task WriteSseAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            await Response.WriteAsync($"id: {id}\n", ct);
        }
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    private static async Task<string> CollectToTextAsync(ILLMClient client, string systemPrompt, List<LLMMessage> messages, CancellationToken ct)
    {
        var sb = new StringBuilder(capacity: 1024);
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, ct).WithCancellation(ct))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException(chunk.ErrorMessage ?? ErrorCodes.LLM_ERROR);
            }
        }
        return sb.ToString();
    }

    private static ParsedPlan? TryParsePlan(string raw, int maxItems, out string? error)
    {
        error = null;
        var text = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            error = "意图模型未返回内容";
            return null;
        }

        // 容错：截取最外层 JSON 对象
        var first = text.IndexOf('{');
        var last = text.LastIndexOf('}');
        if (first >= 0 && last > first)
        {
            text = text.Substring(first, last - first + 1);
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;

            var itemsEl = root.TryGetProperty("items", out var ie) ? ie : default;
            if (itemsEl.ValueKind != JsonValueKind.Array)
            {
                error = "解析失败：items 必须为数组";
                return null;
            }

            var items = new List<ImageGenPlanItem>();
            var total = 0;
            foreach (var it in itemsEl.EnumerateArray())
            {
                if (items.Count >= maxItems) break;

                var prompt = it.TryGetProperty("prompt", out var pEl) && pEl.ValueKind == JsonValueKind.String ? pEl.GetString() : null;
                var count = it.TryGetProperty("count", out var cEl) && cEl.ValueKind == JsonValueKind.Number ? cEl.GetInt32() : 1;
                var size = it.TryGetProperty("size", out var sEl) && sEl.ValueKind == JsonValueKind.String ? sEl.GetString() : null;

                prompt = (prompt ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(prompt)) continue;

                count = Math.Clamp(count <= 0 ? 1 : count, 1, 5);
                size = (size ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(size)) size = null;
                items.Add(new ImageGenPlanItem { Prompt = prompt, Count = count, Size = size });
                total += count;
            }

            // total 以 items 汇总为准（避免模型输出不一致）
            return new ParsedPlan { Total = total, Items = items };
        }
        catch
        {
            error = "解析失败：返回不是合法 JSON";
            return null;
        }
    }

    private async Task WriteEventAsync(string eventName, object payload, CancellationToken ct)
    {
        var data = JsonSerializer.Serialize(payload, JsonOptions);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {data}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    private class ParsedPlan
    {
        public int Total { get; set; }
        public List<ImageGenPlanItem> Items { get; set; } = new();
    }
}

public class ImageGenClarifyRequest
{
    public string Prompt { get; set; } = string.Empty;
    /// <summary>是否有参考图（影响改写策略）</summary>
    public bool HasReferenceImage { get; set; }
}

public class ImageGenClarifyResponse
{
    public string OriginalPrompt { get; set; } = string.Empty;
    public string ClarifiedPrompt { get; set; } = string.Empty;
    /// <summary>是否做了实质修改（已经很好的 prompt 可能几乎不改）</summary>
    public bool WasModified { get; set; }
}

public class ImageGenPlanRequest
{
    public string Text { get; set; } = string.Empty;
    public int? MaxItems { get; set; }
    /// <summary>
    /// 可选：仅本次请求覆盖 system prompt（用于“生图意图解析”）。
    /// 不传时将优先使用管理员已保存的覆盖提示词；两者都无则回退默认模板。
    /// </summary>
    public string? SystemPromptOverride { get; set; }
}

public class ImageGenPlanResponse
{
    public int Total { get; set; }
    public List<ImageGenPlanItem> Items { get; set; } = new();
    public string UsedPurpose { get; set; } = "intent";
}

public class ImageGenPlanItem
{
    public string Prompt { get; set; } = string.Empty;
    public int Count { get; set; } = 1;
    /// <summary>
    /// 可选：单条覆盖的生图尺寸（如 "1024x1024"）。为空时回退到批量请求的 Size。
    /// </summary>
    public string? Size { get; set; }
}

public class ImageGenGenerateRequest
{
    public string Prompt { get; set; } = string.Empty;
    public string? ModelId { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelName { get; set; }
    public int? N { get; set; }
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
    /// <summary>
    /// 统一参考图列表（data URI 格式）。前端统一用此字段，后端根据数量自动路由：
    /// 0 张 → 文生图, 1 张 → 图生图, 2+ 张 → 多图生图
    /// </summary>
    public List<string>? Images { get; set; }

    /// <summary>
    /// [兼容] 图生图首帧（DataURL 或纯 base64）。推荐改用 Images 字段
    /// </summary>
    public string? InitImageBase64 { get; set; }
    /// <summary>
    /// [兼容] 图生图首帧 URL（服务端下载并转 base64；用于规避浏览器 CORS）
    /// </summary>
    public string? InitImageUrl { get; set; }
    /// <summary>
    /// [兼容] 图生图首帧：已上传到系统资产的 sha256（服务端读取文件；用于规避浏览器 CORS）
    /// </summary>
    public string? InitImageAssetSha256 { get; set; }

    /// <summary>
    /// 可选：局部重绘蒙版（base64 data URI）。白色 = 重绘区域，黑色 = 保持。
    /// </summary>
    public string? MaskBase64 { get; set; }
}

public class ImageGenBatchRequest
{
    public string? ModelId { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelName { get; set; }
    public List<ImageGenPlanItem> Items { get; set; } = new();
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
    public int? MaxConcurrency { get; set; } // 最大并发数
}

public class CreateImageGenRunRequest
{
    /// <summary>
    /// 可选：内部配置模型 ID（LLMModel.Id）。若提供，则会自动解析 platformId + modelId。
    /// </summary>
    public string? ConfigModelId { get; set; }

    /// <summary>
    /// 平台 ID（LLMPlatform.Id）。
    /// </summary>
    public string? PlatformId { get; set; }

    /// <summary>
    /// 平台侧模型 ID（业务语义 modelId）。
    /// </summary>
    public string? ModelId { get; set; }

    /// <summary>
    /// 兼容字段：历史接口使用；语义等同于 ModelId。
    /// </summary>
    public string? ModelName { get; set; }

    public List<ImageGenRunPlanItemInput> Items { get; set; } = new();

    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
    public int? MaxConcurrency { get; set; }

    /// <summary>
    /// 可选：绑定的 WorkspaceId。若提供，生成的图片会自动保存到 COS 并关联到该 Workspace。
    /// </summary>
    public string? WorkspaceId { get; set; }

    /// <summary>
    /// 可选：应用标识（如 "literary-agent"）。用于水印等功能的隔离。
    /// </summary>
    public string? AppKey { get; set; }

    /// <summary>
    /// 必填：已注册的 AppCallerCode（禁止拼接/隐式生成）。
    /// 为空时仅允许 visual-agent / literary-agent 走默认注册值。
    /// </summary>
    public string? AppCallerCode { get; set; }

    /// <summary>
    /// 可选：文学创作场景下，关联的配图标记索引。
    /// Worker 完成/失败时会自动回填 ArticleIllustrationMarker.Status。
    /// </summary>
    public int? ArticleMarkerIndex { get; set; }

    /// <summary>
    /// 可选：图生图的参考图资产 SHA256。
    /// 若提供，Worker 会从 COS 读取此图片作为参考图进行图生图。
    /// </summary>
    public string? InitImageAssetSha256 { get; set; }

    /// <summary>
    /// 可选：局部重绘蒙版（base64 data URI）。白色 = 重绘区域，黑色 = 保持。
    /// </summary>
    public string? MaskBase64 { get; set; }
}

public class ImageGenRunPlanItemInput
{
    public string Prompt { get; set; } = string.Empty;
    public int Count { get; set; } = 1;
    public string? Size { get; set; }
}

// ===== 视觉分镜台 storyboard-script =====

public class StoryboardScriptRequest
{
    /// <summary>想法描述或整篇文章/PRD（必填）</summary>
    public string? Brief { get; set; }

    /// <summary>统一视觉风格（可选，留空让 AI 自定）</summary>
    public string? Style { get; set; }

    /// <summary>期望镜头数（可选，0 = 由 AI 自定 4-8 个）</summary>
    public int? SceneCount { get; set; }
}

public class StoryboardScriptResponse
{
    public string Title { get; set; } = string.Empty;
    public string Style { get; set; } = string.Empty;
    public List<StoryboardSceneDto> Scenes { get; set; } = new();
}

public class StoryboardSceneDto
{
    public int Index { get; set; }
    public string Topic { get; set; } = string.Empty;
    public string KeyframePrompt { get; set; } = string.Empty;
    public string MotionPrompt { get; set; } = string.Empty;
    public int Duration { get; set; } = 5;
}

// ===== 多图组合生成 =====

public class ImageGenComposeRequest
{
    /// <summary>
    /// 用户指令（如 "把 [IMAGE_1] 放进 [IMAGE_2] 里"）
    /// </summary>
    public string Instruction { get; set; } = string.Empty;

    /// <summary>
    /// 图片引用列表
    /// </summary>
    public List<ImageGenComposeImageRef> Images { get; set; } = new();

    /// <summary>
    /// 可选：仅解析意图，不生成图片
    /// </summary>
    public bool? ParseOnly { get; set; }

    /// <summary>
    /// 可选：内部配置模型 ID（LLMModel.Id）
    /// </summary>
    public string? ConfigModelId { get; set; }

    /// <summary>
    /// 平台侧模型 ID
    /// </summary>
    public string? ModelId { get; set; }

    /// <summary>
    /// 平台 ID
    /// </summary>
    public string? PlatformId { get; set; }

    /// <summary>
    /// 生图尺寸（如 "1024x1024"）
    /// </summary>
    public string? Size { get; set; }

    /// <summary>
    /// 响应格式（b64_json | url）
    /// </summary>
    public string? ResponseFormat { get; set; }
}

public class ImageGenComposeImageRef
{
    /// <summary>
    /// 引用索引（对应指令中的 [IMAGE_N]）
    /// </summary>
    public int Index { get; set; }

    /// <summary>
    /// 图片资产 ID
    /// </summary>
    public string AssetId { get; set; } = string.Empty;

    /// <summary>
    /// 显示名称（可选）
    /// </summary>
    public string? Name { get; set; }
}

public class ImageGenComposeResponse
{
    /// <summary>
    /// VLM 生成的英文 Prompt
    /// </summary>
    public string GeneratedPrompt { get; set; } = string.Empty;

    /// <summary>
    /// 生成的图片列表
    /// </summary>
    public List<ImageGenImage> Images { get; set; } = new();

    /// <summary>
    /// 图片描述信息（用于调试）
    /// </summary>
    public List<ImageDescriptionDto> ImageDescriptions { get; set; } = new();
}

public class ImageDescriptionDto
{
    public int Index { get; set; }
    public string AssetId { get; set; } = string.Empty;
    public string? Description { get; set; }
    public bool HasDescription { get; set; }
}
