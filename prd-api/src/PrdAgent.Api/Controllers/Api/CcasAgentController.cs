using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.CcasAgent;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Services.CcasAgent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 赋码采集关联系统综合智能体（ccas-agent）
/// 三大子能力：
///   1) PRD 文档生成（按米多 product-document-generator skill 模板，工程版 / 敏捷版双模板）
///   2) 设备素材库（按预设风格生成 + 复用，供流程图节点引用）
///   3) 流程示意图绘制（LLM 解析输入 → 节点 + 边 JSON → 前端 ReactFlow 拼装素材图渲染）
/// </summary>
[ApiController]
[Route("api/ccas-agent")]
[Authorize]
[AdminController("ccas-agent", AdminPermissionCatalog.CcasAgentUse)]
public class CcasAgentController : ControllerBase
{
    private const string AppKey = "ccas-agent";

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly OpenAIImageClient _imageClient;
    private readonly IAssetStorage _assetStorage;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<CcasAgentController> _logger;

    public CcasAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        OpenAIImageClient imageClient,
        IAssetStorage assetStorage,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<CcasAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _imageClient = imageClient;
        _assetStorage = assetStorage;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    // ──────────────────────────────────────────────
    // 元数据：模板清单 + 风格预设清单（前端启动时拉取）
    // ──────────────────────────────────────────────

    [HttpGet("meta")]
    public IActionResult GetMeta()
    {
        return Ok(ApiResponse<object>.Ok(new
        {
            templates = CcasPrdPrompts.AvailableTemplates,
            equipmentStyles = CcasEquipmentStyles.Presets,
            associationModes = new[]
            {
                new { key = "bottle-box-stack", label = "瓶箱垛", description = "瓶 → 箱 → 垛 三层赋码绑定" },
                new { key = "bottle-pack-box-stack", label = "瓶盒箱垛", description = "瓶 → 盒 → 箱 → 垛 四层" },
                new { key = "box-stack", label = "箱垛", description = "仅箱 → 垛" },
                new { key = "custom", label = "自定义", description = "完全按用户描述" },
            },
        }));
    }

    // ──────────────────────────────────────────────
    // 子能力 1：PRD 文档生成（SSE 流式）
    // ──────────────────────────────────────────────

    public class GeneratePrdRequest
    {
        /// <summary>模板 key：engineering-main / engineering-sub / agile</summary>
        public string TemplateKey { get; set; } = CcasPrdPrompts.TemplateKeys.EngineeringMain;

        /// <summary>当前阶段：A（仅输出 Part A）/ B（用户确认 Part A 后输出 Part B）</summary>
        public string Phase { get; set; } = "A";

        /// <summary>用户原始输入：自由文本（可包含基本业务、产线设备清单、关联模式等）</summary>
        public string Input { get; set; } = string.Empty;

        /// <summary>可选：上传 markdown 文件抽取出的现有内容（让 AI 在已有内容上补全/优化）</summary>
        public string? ExistingMarkdown { get; set; }

        /// <summary>当 phase=B 时，传入用户确认过的 Part A 内容（拼到上下文，让 LLM 不重复输出）</summary>
        public string? ConfirmedPartA { get; set; }
    }

    /// <summary>
    /// PRD 生成 SSE 流：每收到一个文本 chunk 就推 typing 事件，结束后推 done。
    /// 网关首个 Start chunk 携带的 model/platform 通过 model 事件推送（AI 模型可见性原则）。
    /// </summary>
    [HttpPost("prd/stream")]
    [Produces("text/event-stream")]
    public async Task GeneratePrdStream([FromBody] GeneratePrdRequest req, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        if (req == null || string.IsNullOrWhiteSpace(req.Input))
        {
            await WriteSseAsync("error", new { message = "请填写产品/项目的基本描述（input 不能为空）" });
            return;
        }

        var templateKey = string.IsNullOrWhiteSpace(req.TemplateKey)
            ? CcasPrdPrompts.TemplateKeys.EngineeringMain
            : req.TemplateKey.Trim();
        var phase = string.IsNullOrWhiteSpace(req.Phase) ? "A" : req.Phase.Trim().ToUpperInvariant();
        if (phase != "A" && phase != "B") phase = "A";

        var systemPrompt = CcasPrdPrompts.BuildSystemPrompt(templateKey, phase);

        // 拼装用户消息 — 保留 markdown 上传 + Part A 确认上下文
        var userPromptSb = new StringBuilder();
        userPromptSb.AppendLine("# 用户输入");
        userPromptSb.AppendLine(req.Input.Trim());
        if (!string.IsNullOrWhiteSpace(req.ExistingMarkdown))
        {
            userPromptSb.AppendLine();
            userPromptSb.AppendLine("# 已有 Markdown 内容（请在此基础上补全 / 优化，禁止删减用户已写的关键信息）");
            userPromptSb.AppendLine("---");
            userPromptSb.AppendLine(req.ExistingMarkdown.Trim());
            userPromptSb.AppendLine("---");
        }
        if (phase == "B" && !string.IsNullOrWhiteSpace(req.ConfirmedPartA))
        {
            userPromptSb.AppendLine();
            userPromptSb.AppendLine("# 用户已确认的 Part A 内容（仅作上下文参考，不要重复输出）");
            userPromptSb.AppendLine("---");
            userPromptSb.AppendLine(req.ConfirmedPartA.Trim());
            userPromptSb.AppendLine("---");
            userPromptSb.AppendLine();
            userPromptSb.AppendLine("请直接输出 Part B 的全部章节。");
        }

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.CcasAgent.Prd.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPromptSb.ToString() },
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = 8192,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
        };

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: req.Input.Length + (req.ExistingMarkdown?.Length ?? 0),
            DocumentHash: null,
            SystemPromptRedacted: $"[CCAS_PRD:{templateKey}:{phase}]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.CcasAgent.Prd.Chat));

        await WriteSseAsync("phase", new { phase = "preparing", message = $"准备中（模板：{templateKey}，阶段：{phase}）..." });

        var sentModelEvent = false;
        var startedAt = DateTime.UtcNow;

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModelEvent && chunk.Resolution != null)
                {
                    sentModelEvent = true;
                    await WriteSseAsync("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName,
                    });
                    await WriteSseAsync("phase", new { phase = "analyzing", message = "AI 正在生成文档..." });
                }
                else if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseAsync("thinking", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseAsync("typing", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                    _logger.LogError("CcasAgent PRD 网关错误 user={UserId}: {Error}", userId, err);
                    try { await WriteSseAsync("error", new { message = $"LLM 网关错误: {err}" }); }
                    catch { }
                    return;
                }
            }

            try
            {
                await WriteSseAsync("done", new
                {
                    phase,
                    elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                });
            }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CcasAgent PRD 生成失败 user={UserId}", userId);
            try { await WriteSseAsync("error", new { message = "PRD 生成失败：" + ex.Message }); } catch { }
        }
    }

    // ──────────────────────────────────────────────
    // 子能力 2：设备素材库
    // ──────────────────────────────────────────────

    public class GenerateEquipmentRequest
    {
        /// <summary>设备类型/中文名（必填，例如：裹包机 / 龙门架 / 工业相机）</summary>
        public string EquipmentType { get; set; } = string.Empty;

        /// <summary>风格预设 key（必填）</summary>
        public string StyleKey { get; set; } = string.Empty;

        /// <summary>用户额外的提示词（可选，会拼到主 prompt 后）</summary>
        public string? ExtraPrompt { get; set; }

        /// <summary>图片尺寸，默认 1024x1024</summary>
        public string? Size { get; set; }
    }

    /// <summary>
    /// 生成单张设备素材并入库。同步返回；前端可在 UI 用 loading 兜底动画。
    /// 之所以不走 SSE 是因为生图模型多为同步返回 b64_json。
    /// </summary>
    [HttpPost("equipment/generate")]
    public async Task<IActionResult> GenerateEquipment([FromBody] GenerateEquipmentRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        var equipType = (req?.EquipmentType ?? string.Empty).Trim();
        var styleKey = (req?.StyleKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(equipType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "equipmentType 不能为空"));
        if (string.IsNullOrWhiteSpace(styleKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "styleKey 不能为空"));

        var preset = CcasEquipmentStyles.FindByKey(styleKey);
        if (preset == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"未知风格：{styleKey}"));

        var size = string.IsNullOrWhiteSpace(req?.Size) ? "1024x1024" : req!.Size!.Trim();
        var extraPrompt = (req?.ExtraPrompt ?? string.Empty).Trim();

        // 组装最终 prompt：『主体描述 + 风格修饰 + 用户附加』
        var promptSb = new StringBuilder();
        promptSb.Append($"a single isolated industrial \"{equipType}\" used in a beverage production line for code-marking and packaging");
        promptSb.Append($"; centered composition, full-shot");
        promptSb.Append($"; {preset.PromptHint}");
        if (!string.IsNullOrWhiteSpace(extraPrompt))
        {
            promptSb.Append($"; {extraPrompt}");
        }
        var finalPrompt = promptSb.ToString();

        var appCallerCode = AppCallerRegistry.CcasAgent.Equipment.Generate;

        // 解析模型（拿 model/platform 做 AI 模型可见性 + 落库）
        var resolution = await _gateway.ResolveModelAsync(appCallerCode, "generation", ct: ct);
        if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    resolution.ErrorMessage ?? "未配置可用的生图模型，请管理员先配置 AppCallerCode `ccas-agent.equipment::generation`"));
        }

        // 拒绝 stub 占位模型：CDS 灰度环境默认生图池可能只挂了 stub，
        // 让用户拿到绿色占位图当成真实结果是产品级误导，必须在这里显式报错。
        // 注意：用 400 而非 502，避免 Cloudflare 对 origin 5xx 默认替换成自己的错误页（用户看不到具体提示）。
        var actualModel = (resolution.ActualModel ?? string.Empty).Trim();
        var actualPlatformName = (resolution.ActualPlatformName ?? string.Empty).Trim();
        if (actualModel.Contains("stub", StringComparison.OrdinalIgnoreCase)
            || actualPlatformName.Contains("Stub", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"当前生图模型解析到开发桩（model={actualModel}, platform={actualPlatformName}），" +
                $"无法生成真实素材图。请管理员到「模型管理 → 模型池」给 AppCallerCode " +
                $"`{appCallerCode}` 绑定一个真实生图模型池（推荐：seedream / dall-e-3 / sd-xl 等）。"));
        }

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: $"[CCAS_EQUIP:{styleKey}]",
            RequestType: "imageGen",
            AppCallerCode: appCallerCode));

        var res = await _imageClient.GenerateAsync(finalPrompt, n: 1, size, "b64_json", ct,
            appCallerCode, resolution.ActualModel, resolution.ActualPlatformId, resolution.ActualModel);

        if (!res.Success || res.Data == null || res.Data.Images.Count == 0)
        {
            var code = res.Error?.Code ?? ErrorCodes.LLM_ERROR;
            var msg = res.Error?.Message ?? "生图失败，请稍后重试";
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(code, msg));
        }

        var image = res.Data.Images[0];

        // 持久化：把 base64 落到资产存储 + 在 ccas_equipment_assets 集合记一笔
        byte[]? bytes = null;
        if (!string.IsNullOrEmpty(image.Base64))
        {
            try { bytes = Convert.FromBase64String(image.Base64); }
            catch { bytes = null; }
        }
        if (bytes == null || bytes.Length == 0)
        {
            // 模型返回 url（如某些 OpenAI 兼容上游）— 保留 url 不落本地，仍可在前端引用
            if (string.IsNullOrWhiteSpace(image.Url))
            {
                return StatusCode(StatusCodes.Status502BadGateway,
                    ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "生图模型未返回 base64 也未返回 URL"));
            }
        }

        StoredAsset? stored = null;
        if (bytes != null && bytes.Length > 0)
        {
            try
            {
                stored = await _assetStorage.SaveAsync(bytes, "image/png", CancellationToken.None,
                    domain: AppDomainPaths.DomainCcasAgent, type: AppDomainPaths.TypeImg);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "CcasAgent equipment 资产落盘失败，回退使用模型直返 URL");
            }
        }

        var url = stored?.Url ?? image.Url ?? string.Empty;
        if (string.IsNullOrWhiteSpace(url))
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "生图成功但落盘失败，无可用 URL"));
        }

        var asset = new CcasEquipmentAsset
        {
            OwnerUserId = userId,
            EquipmentType = equipType,
            StyleKey = styleKey,
            Prompt = finalPrompt,
            OriginalUserInput = extraPrompt,
            Url = url,
            OriginalUrl = url, // 本智能体默认无水印
            Mime = "image/png",
            SizeBytes = stored?.SizeBytes ?? 0,
            Model = resolution.ActualModel,
            PlatformName = resolution.ActualPlatformName,
        };
        await _db.CcasEquipmentAssets.InsertOneAsync(asset, cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new
        {
            asset,
            model = resolution.ActualModel,
            platform = resolution.ActualPlatformName,
        }));
    }

    /// <summary>
    /// 列出当前用户的素材库（默认按时间倒序，可按设备类型 / 风格筛选）。
    /// </summary>
    [HttpGet("equipment")]
    public async Task<IActionResult> ListEquipment(
        [FromQuery] string? equipmentType = null,
        [FromQuery] string? styleKey = null,
        [FromQuery] bool? favoriteOnly = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 60,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var fb = Builders<CcasEquipmentAsset>.Filter;
        var f = fb.Eq(x => x.OwnerUserId, userId);
        if (!string.IsNullOrWhiteSpace(equipmentType))
            f &= fb.Eq(x => x.EquipmentType, equipmentType.Trim());
        if (!string.IsNullOrWhiteSpace(styleKey))
            f &= fb.Eq(x => x.StyleKey, styleKey.Trim());
        if (favoriteOnly == true)
            f &= fb.Eq(x => x.IsFavorite, true);

        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 200);

        var total = await _db.CcasEquipmentAssets.CountDocumentsAsync(f, cancellationToken: ct);
        var items = await _db.CcasEquipmentAssets.Find(f)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    public class ToggleFavoriteRequest { public bool IsFavorite { get; set; } }

    [HttpPost("equipment/{id}/favorite")]
    public async Task<IActionResult> ToggleFavorite(string id, [FromBody] ToggleFavoriteRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        var asset = await _db.CcasEquipmentAssets.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (asset == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "素材不存在或无权操作"));

        await _db.CcasEquipmentAssets.UpdateOneAsync(
            x => x.Id == id,
            Builders<CcasEquipmentAsset>.Update.Set(x => x.IsFavorite, req?.IsFavorite ?? false),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { id, isFavorite = req?.IsFavorite ?? false }));
    }

    [HttpDelete("equipment/{id}")]
    public async Task<IActionResult> DeleteEquipment(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var asset = await _db.CcasEquipmentAssets.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (asset == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "素材不存在或无权操作"));

        await _db.CcasEquipmentAssets.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        // COS 资产不主动删（可能被其他流程图引用），由清理任务统一回收
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ──────────────────────────────────────────────
    // 子能力 3：流程示意图
    // ──────────────────────────────────────────────

    public class ParseFlowRequest
    {
        public string Title { get; set; } = string.Empty;
        public string AssociationMode { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
    }

    /// <summary>
    /// SSE 流式：LLM 边输出文本（推 typing）边生成 JSON；流结束后再尝试解析整个 JSON 推 parsed 事件。
    /// 禁止只在结束才 push（CLAUDE.md 规则 #6 流式可视化）。
    /// </summary>
    [HttpPost("flow/parse-stream")]
    [Produces("text/event-stream")]
    public async Task ParseFlowStream([FromBody] ParseFlowRequest req, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        if (req == null || string.IsNullOrWhiteSpace(req.Description))
        {
            await WriteSseAsync("error", new { message = "请填写流程描述（description 不能为空）" });
            return;
        }

        var title = string.IsNullOrWhiteSpace(req.Title) ? "未命名流程" : req.Title.Trim();
        var mode = string.IsNullOrWhiteSpace(req.AssociationMode) ? "自定义" : req.AssociationMode.Trim();

        var systemPrompt = CcasFlowPrompts.SystemPrompt;
        var userPrompt = CcasFlowPrompts.BuildUserPrompt(title, mode, req.Description.Trim());

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.CcasAgent.Flow.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = false,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                ["temperature"] = 0.1,
                ["max_tokens"] = 4096,
            },
        };

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: req.Description.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[CCAS_FLOW]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.CcasAgent.Flow.Chat));

        await WriteSseAsync("phase", new { phase = "analyzing", message = "AI 正在解析流程..." });

        var fullText = new StringBuilder();
        var sentModel = false;
        string? modelName = null;
        string? platformName = null;

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    modelName = chunk.Resolution.ActualModel;
                    platformName = chunk.Resolution.ActualPlatformName;
                    await WriteSseAsync("model", new { model = modelName, platform = platformName });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullText.Append(chunk.Content);
                    try { await WriteSseAsync("typing", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "网关错误";
                    try { await WriteSseAsync("error", new { message = err }); } catch { }
                    return;
                }
            }

            // 尝试解析 JSON
            var raw = fullText.ToString();
            var json = TryExtractJson(raw);
            if (json == null)
            {
                try { await WriteSseAsync("error", new { message = "AI 输出非合法 JSON，请点击重新生成或调整输入" }); }
                catch { }
                return;
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                await WriteSseAsync("parsed", new
                {
                    nodesJson = GetArrayOrEmpty(doc.RootElement, "nodes"),
                    edgesJson = GetArrayOrEmpty(doc.RootElement, "edges"),
                    groupsJson = GetArrayOrEmpty(doc.RootElement, "groups"),
                    model = modelName,
                    platform = platformName,
                });
                await WriteSseAsync("done", new { });
            }
            catch (JsonException jex)
            {
                _logger.LogWarning(jex, "CcasAgent flow JSON parse failed: {Raw}", raw[..Math.Min(500, raw.Length)]);
                try { await WriteSseAsync("error", new { message = "AI 输出 JSON 解析失败：" + jex.Message }); } catch { }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CcasAgent flow 解析异常 user={UserId}", userId);
            try { await WriteSseAsync("error", new { message = "解析失败：" + ex.Message }); } catch { }
        }
    }

    public class SaveFlowDiagramRequest
    {
        public string? Id { get; set; }
        public string Title { get; set; } = string.Empty;
        public string OriginalInput { get; set; } = string.Empty;
        public string? AssociationMode { get; set; }
        public string NodesJson { get; set; } = "[]";
        public string EdgesJson { get; set; } = "[]";
        public string GroupsJson { get; set; } = "[]";
        public string? Model { get; set; }
        public string? PlatformName { get; set; }
    }

    [HttpPost("flow/diagrams")]
    public async Task<IActionResult> SaveFlowDiagram([FromBody] SaveFlowDiagramRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(req?.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "title 不能为空"));

        // 校验 nodesJson / edgesJson / groupsJson 必须是合法 JSON 数组
        foreach (var (name, value) in new[] { ("nodesJson", req!.NodesJson), ("edgesJson", req.EdgesJson), ("groupsJson", req.GroupsJson) })
        {
            try
            {
                using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(value) ? "[]" : value);
                if (doc.RootElement.ValueKind != JsonValueKind.Array)
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"{name} 必须是 JSON 数组"));
            }
            catch (JsonException)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"{name} 不是合法 JSON"));
            }
        }

        if (!string.IsNullOrWhiteSpace(req.Id))
        {
            var existing = await _db.CcasFlowDiagrams.Find(x => x.Id == req.Id && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
            if (existing == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "流程图不存在或无权操作"));

            await _db.CcasFlowDiagrams.UpdateOneAsync(
                x => x.Id == req.Id,
                Builders<CcasFlowDiagram>.Update
                    .Set(x => x.Title, req.Title.Trim())
                    .Set(x => x.OriginalInput, req.OriginalInput ?? string.Empty)
                    .Set(x => x.AssociationMode, req.AssociationMode)
                    .Set(x => x.NodesJson, string.IsNullOrWhiteSpace(req.NodesJson) ? "[]" : req.NodesJson)
                    .Set(x => x.EdgesJson, string.IsNullOrWhiteSpace(req.EdgesJson) ? "[]" : req.EdgesJson)
                    .Set(x => x.GroupsJson, string.IsNullOrWhiteSpace(req.GroupsJson) ? "[]" : req.GroupsJson)
                    .Set(x => x.Model, req.Model)
                    .Set(x => x.PlatformName, req.PlatformName)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            var updated = await _db.CcasFlowDiagrams.Find(x => x.Id == req.Id).FirstOrDefaultAsync(CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { diagram = updated }));
        }

        var diagram = new CcasFlowDiagram
        {
            OwnerUserId = userId,
            Title = req.Title.Trim(),
            OriginalInput = req.OriginalInput ?? string.Empty,
            AssociationMode = req.AssociationMode,
            NodesJson = string.IsNullOrWhiteSpace(req.NodesJson) ? "[]" : req.NodesJson,
            EdgesJson = string.IsNullOrWhiteSpace(req.EdgesJson) ? "[]" : req.EdgesJson,
            GroupsJson = string.IsNullOrWhiteSpace(req.GroupsJson) ? "[]" : req.GroupsJson,
            Model = req.Model,
            PlatformName = req.PlatformName,
        };
        await _db.CcasFlowDiagrams.InsertOneAsync(diagram, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { diagram }));
    }

    [HttpGet("flow/diagrams")]
    public async Task<IActionResult> ListFlowDiagrams(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var fb = Builders<CcasFlowDiagram>.Filter.Eq(x => x.OwnerUserId, userId);
        var total = await _db.CcasFlowDiagrams.CountDocumentsAsync(fb, cancellationToken: ct);
        var items = await _db.CcasFlowDiagrams.Find(fb)
            .SortByDescending(x => x.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .Project(x => new
            {
                x.Id,
                x.Title,
                x.AssociationMode,
                x.Model,
                x.PlatformName,
                x.CreatedAt,
                x.UpdatedAt,
            })
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    [HttpGet("flow/diagrams/{id}")]
    public async Task<IActionResult> GetFlowDiagram(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var diagram = await _db.CcasFlowDiagrams.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (diagram == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "流程图不存在或无权访问"));
        return Ok(ApiResponse<object>.Ok(new { diagram }));
    }

    [HttpDelete("flow/diagrams/{id}")]
    public async Task<IActionResult> DeleteFlowDiagram(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var diagram = await _db.CcasFlowDiagrams.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (diagram == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "流程图不存在或无权操作"));
        await _db.CcasFlowDiagrams.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ──────────────────────────────────────────────
    // 私有工具
    // ──────────────────────────────────────────────

    private async Task WriteSseAsync(string eventType, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            });
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }

    private static string? TryExtractJson(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        // 先尝试 ```json fenced block
        var fenceMatch = System.Text.RegularExpressions.Regex.Match(
            raw, @"```(?:json)?\s*([\s\S]*?)\s*```",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        var search = fenceMatch.Success ? fenceMatch.Groups[1].Value : raw;
        var start = search.IndexOf('{');
        var end = search.LastIndexOf('}');
        return (start >= 0 && end > start) ? search[start..(end + 1)] : null;
    }

    private static string GetArrayOrEmpty(JsonElement root, string key)
    {
        if (root.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.Array)
        {
            return el.GetRawText();
        }
        return "[]";
    }
}
