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
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 赋码采集关联系统综合智能体（ccas-agent）
/// 三大子能力：
///   1) PRD 文档生成（按米多 product-document-generator skill 模板，工程版 / 敏捷版双模板）
///   2) 设备素材库（按预设风格生成 / 本地上传 + 复用，供流程图节点引用）
///   3) 流程示意图绘制（LLM 解析输入 → 节点 + 边 JSON → 前端 ReactFlow 拼装素材图渲染）
/// </summary>
[ApiController]
[Route("api/ccas-agent")]
[Authorize]
[AdminController("ccas-agent", AdminPermissionCatalog.CcasAgentUse)]
public class CcasAgentController : ControllerBase
{
    private const string AppKey = "ccas-agent";
    private const string AuthorName = "魏喜胜";

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
            authorName = AuthorName,
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

        /// <summary>
        /// 可选：从「文档空间 / 知识库」（document_store）中选择的参考条目 ID 列表。
        /// 后端会读取每条 entry 的内容（ParsedPrd.RawContent / Attachment.ExtractedText）。
        /// 权限校验：只能引用「自己创建的空间」或「公开的空间（IsPublic=true）」中的条目。
        /// </summary>
        public List<string>? ReferenceEntryIds { get; set; }

        /// <summary>整库引用的知识库空间 ID 列表，会展开为空间内所有非文件夹条目。</summary>
        public List<string>? ReferenceStoreIds { get; set; }
    }

    /// <summary>知识库参考资料注入预算：单条最大字符数</summary>
    private const int ReferenceEntryMaxChars = 40000;
    /// <summary>知识库参考资料注入预算：所有条目合计最大字符数</summary>
    private const int ReferenceTotalBudget = 120000;
    /// <summary>显式单篇引用最大数量，防止异常请求放大数据库读取。</summary>
    private const int ReferenceMaxExplicitEntries = 200;
    /// <summary>整库引用最大空间数量，支持多知识库但避免一次请求扫库过大。</summary>
    private const int ReferenceMaxStores = 50;

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

        // 知识库参考资料注入（可选）：支持整库引用 + 单篇引用，按模型上下文预算追加到 system prompt 末尾。
        var referenceInfo = await BuildReferenceContextAsync(req.ReferenceEntryIds, req.ReferenceStoreIds, userId);
        if (!string.IsNullOrEmpty(referenceInfo.AppendedContent))
        {
            systemPrompt += referenceInfo.AppendedContent;
        }

        // 即使没启用，只要前端传了 ID 也回个 reference 事件让用户知道实际状况（被跳过几条 / 注入几条）
        var requestedEntryCount = req.ReferenceEntryIds?.Count ?? 0;
        var requestedStoreCount = req.ReferenceStoreIds?.Count ?? 0;
        if (requestedEntryCount + requestedStoreCount > 0)
        {
            await WriteSseAsync("reference", new
            {
                requested = requestedEntryCount + requestedStoreCount,
                requestedEntries = requestedEntryCount,
                requestedStores = requestedStoreCount,
                included = referenceInfo.IncludedCount,
                totalChars = referenceInfo.TotalChars,
                budget = ReferenceTotalBudget,
                skipped = referenceInfo.Skipped,
            });
        }

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

    public class RevisePrdRequest
    {
        /// <summary>模板 key（与初稿生成一致，用于约束章节骨架）</summary>
        public string TemplateKey { get; set; } = CcasPrdPrompts.TemplateKeys.EngineeringMain;

        /// <summary>当前完整 Markdown（Part A + 可选 --- + Part B 合并稿）</summary>
        public string CurrentMarkdown { get; set; } = string.Empty;

        /// <summary>本轮改稿指令（必填）</summary>
        public string Message { get; set; } = string.Empty;

        /// <summary>多轮改稿历史：只传短气泡（用户原话 + 助手确认），禁止塞完整文档</summary>
        public List<QaHistoryItem>? History { get; set; }

        /// <summary>可选：初稿生成时的立项描述，作背景参考</summary>
        public string? OriginalInput { get; set; }

        /// <summary>可选：知识库单篇引用</summary>
        public List<string>? ReferenceEntryIds { get; set; }

        /// <summary>可选：知识库整库引用</summary>
        public List<string>? ReferenceStoreIds { get; set; }

        /// <summary>会话 ID（日志关联）</summary>
        public string? SessionId { get; set; }
    }

    /// <summary>
    /// PRD 多轮改稿 SSE 流：在已有 Markdown 基础上按用户指令修订，流式输出完整修订稿。
    /// history 走短气泡；当前文档每轮注入 user message，避免 history 重复嵌 40k 文档。
    /// </summary>
    [HttpPost("prd/revise/stream")]
    [Produces("text/event-stream")]
    public async Task RevisePrdStream([FromBody] RevisePrdRequest req, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        if (req == null || string.IsNullOrWhiteSpace(req.CurrentMarkdown))
        {
            await WriteSseAsync("error", new { message = "请先生成或粘贴 PRD 文档后再改稿（currentMarkdown 不能为空）" });
            return;
        }
        if (string.IsNullOrWhiteSpace(req.Message))
        {
            await WriteSseAsync("error", new { message = "请填写改稿指令（message 不能为空）" });
            return;
        }

        var templateKey = string.IsNullOrWhiteSpace(req.TemplateKey)
            ? CcasPrdPrompts.TemplateKeys.EngineeringMain
            : req.TemplateKey.Trim();
        var currentMarkdown = req.CurrentMarkdown.Trim();
        var instruction = req.Message.Trim();

        var systemPrompt = CcasPrdRevisePrompts.BuildSystemPrompt(templateKey);

        var referenceInfo = await BuildReferenceContextAsync(req.ReferenceEntryIds, req.ReferenceStoreIds, userId);
        if (!string.IsNullOrEmpty(referenceInfo.AppendedContent))
        {
            systemPrompt += referenceInfo.AppendedContent;
        }

        var requestedEntryCount = req.ReferenceEntryIds?.Count ?? 0;
        var requestedStoreCount = req.ReferenceStoreIds?.Count ?? 0;
        if (requestedEntryCount + requestedStoreCount > 0)
        {
            await WriteSseAsync("reference", new
            {
                requested = requestedEntryCount + requestedStoreCount,
                requestedEntries = requestedEntryCount,
                requestedStores = requestedStoreCount,
                included = referenceInfo.IncludedCount,
                totalChars = referenceInfo.TotalChars,
                budget = ReferenceTotalBudget,
                skipped = referenceInfo.Skipped,
            });
        }

        var historyTuples = (req.History ?? new List<QaHistoryItem>())
            .Where(h => !string.IsNullOrWhiteSpace(h.Content))
            .Select(h => ((h.Role ?? "user").Trim().ToLowerInvariant(), h.Content))
            .ToList();

        var userPrompt = CcasPrdRevisePrompts.BuildUserPrompt(
            currentMarkdown,
            instruction,
            req.OriginalInput,
            historyTuples);

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
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                ["temperature"] = 0.25,
                ["max_tokens"] = 8192,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
        };

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: req.SessionId,
            UserId: userId,
            ViewRole: null,
            DocumentChars: currentMarkdown.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"[CCAS_PRD_REVISE:{templateKey}]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.CcasAgent.Prd.Chat));

        await WriteSseAsync("phase", new { phase = "preparing", message = "准备改稿…" });

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
                    await WriteSseAsync("phase", new { phase = "revising", message = "AI 正在改稿…" });
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
                    _logger.LogError("CcasAgent PRD 改稿网关错误 user={UserId}: {Error}", userId, err);
                    try { await WriteSseAsync("error", new { message = $"LLM 网关错误: {err}" }); }
                    catch { }
                    return;
                }
            }

            try
            {
                await WriteSseAsync("done", new
                {
                    elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                });
            }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CcasAgent PRD 改稿失败 user={UserId}", userId);
            try { await WriteSseAsync("error", new { message = "PRD 改稿失败：" + ex.Message }); } catch { }
        }
    }

    // ──────────────────────────────────────────────
    // 子能力 2：设备素材库
    // ──────────────────────────────────────────────

    private const long MaxEquipmentUploadBytes = 10 * 1024 * 1024;
    private static readonly HashSet<string> AllowedEquipmentUploadMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
    };

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
    /// 上传本地设备图片并入库。风格固定为 user-upload，供流程图按设备名匹配。
    /// </summary>
    [HttpPost("equipment/upload")]
    [RequestSizeLimit(MaxEquipmentUploadBytes)]
    public async Task<IActionResult> UploadEquipment(
        [FromForm] IFormFile file,
        [FromForm] string equipmentType,
        [FromForm] string? note,
        CancellationToken ct)
    {
        var userId = GetUserId();
        var equipType = (equipmentType ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(equipType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "equipmentType 不能为空"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择图片文件"));
        if (file.Length > MaxEquipmentUploadBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片大小不能超过 10MB"));

        var mimeType = (file.ContentType ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(mimeType) || !AllowedEquipmentUploadMimeTypes.Contains(mimeType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"不支持的图片类型：{mimeType}"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图片内容为空"));

        StoredAsset stored;
        try
        {
            stored = await _assetStorage.SaveAsync(
                bytes,
                mimeType,
                CancellationToken.None,
                domain: AppDomainPaths.DomainCcasAgent,
                type: AppDomainPaths.TypeImg);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CcasAgent equipment 上传落盘失败 user={UserId}", userId);
            return StatusCode(StatusCodes.Status502BadGateway,
                ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "图片上传失败，请稍后重试"));
        }

        var width = 0;
        var height = 0;
        try
        {
            using var image = Image.Load<Rgba32>(bytes);
            width = image.Width;
            height = image.Height;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "CcasAgent equipment 上传图片尺寸解析失败，继续入库");
        }

        var noteText = (note ?? string.Empty).Trim();
        var asset = new CcasEquipmentAsset
        {
            OwnerUserId = userId,
            EquipmentType = equipType,
            StyleKey = "user-upload",
            Prompt = "[用户上传]",
            OriginalUserInput = string.IsNullOrWhiteSpace(noteText) ? null : noteText,
            Url = stored.Url,
            OriginalUrl = stored.Url,
            Mime = mimeType,
            Width = width,
            Height = height,
            SizeBytes = stored.SizeBytes,
        };
        await _db.CcasEquipmentAssets.InsertOneAsync(asset, cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { asset }));
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
    // 子能力 4：智能客服（基于知识库的严格 RAG 问答）
    // ──────────────────────────────────────────────

    public class QaChatRequest
    {
        /// <summary>用户当前提问</summary>
        public string Message { get; set; } = string.Empty;

        /// <summary>历史对话（最近若干轮，由前端维护）。最多取 20 条。</summary>
        public List<QaHistoryItem>? History { get; set; }

        /// <summary>引用的知识库条目 ID 列表（同 PRD 子能力，复用 BuildReferenceContextAsync）</summary>
        public List<string>? ReferenceEntryIds { get; set; }

        /// <summary>整库引用的知识库空间 ID 列表，会展开为空间内所有非文件夹条目。</summary>
        public List<string>? ReferenceStoreIds { get; set; }

        /// <summary>
        /// 联网检索开关：
        /// - false（默认）：严格 RAG，只依赖知识库；知识库没有就明说不杜撰。
        /// - true：放宽到「知识库优先 + 模型公开知识补充」；非知识库内容会标注「（来自模型通用知识）」。
        /// 注：当前未接入实时爬虫，开关只切换 system prompt 约束级别，对用户透明。
        /// </summary>
        public bool WebSearch { get; set; } = false;

        /// <summary>会话 ID（仅用于日志关联，不强制持久化）</summary>
        public string? SessionId { get; set; }
    }

    public class QaHistoryItem
    {
        /// <summary>"user" / "assistant"</summary>
        public string Role { get; set; } = "user";
        public string Content { get; set; } = string.Empty;
    }

    /// <summary>
    /// 智能客服 SSE 流式问答。事件协议：
    ///   - phase   { phase, message }
    ///   - model   { model, platform }
    ///   - reference { requested, included, totalChars, budget, skipped[], items[] }
    ///   - typing  { text }                  // 正文增量
    ///   - done    { elapsedMs, webSearch }
    ///   - error   { message }
    /// </summary>
    [HttpPost("qa/stream")]
    [Produces("text/event-stream")]
    public async Task QaStream([FromBody] QaChatRequest req, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        if (req == null || string.IsNullOrWhiteSpace(req.Message))
        {
            await WriteSseAsync("error", new { message = "请输入问题（message 不能为空）" });
            return;
        }

        var question = req.Message.Trim();
        var webSearchOn = req.WebSearch;

        // 拼接 system prompt：严格 RAG / 放宽 + 知识库参考块
        var systemPrompt = CcasQaPrompts.BuildSystemPrompt(webSearchOn);

        var referenceInfo = await BuildReferenceContextAsync(req.ReferenceEntryIds, req.ReferenceStoreIds, userId, "QA");
        if (!string.IsNullOrEmpty(referenceInfo.AppendedContent))
        {
            systemPrompt += referenceInfo.AppendedContent;
        }

        // reference 事件 — 始终发，让前端知道实际命中
        await WriteSseAsync("reference", new
        {
            requested = (req.ReferenceEntryIds?.Count ?? 0) + (req.ReferenceStoreIds?.Count ?? 0),
            requestedEntries = req.ReferenceEntryIds?.Count ?? 0,
            requestedStores = req.ReferenceStoreIds?.Count ?? 0,
            included = referenceInfo.IncludedCount,
            totalChars = referenceInfo.TotalChars,
            budget = ReferenceTotalBudget,
            skipped = referenceInfo.Skipped,
            items = referenceInfo.IncludedItems,
        });

        // 拼接 user message：历史上下文（折叠成 markdown 段落）+ 当前问题
        var userPromptSb = new StringBuilder();
        var historyTuples = (req.History ?? new List<QaHistoryItem>())
            .Where(h => !string.IsNullOrWhiteSpace(h.Content))
            .Select(h => ((h.Role ?? "user").Trim().ToLowerInvariant(), h.Content))
            .ToList();
        var historyBlock = CcasQaPrompts.BuildHistoryContext(historyTuples);
        if (!string.IsNullOrWhiteSpace(historyBlock))
        {
            userPromptSb.AppendLine(historyBlock);
            userPromptSb.AppendLine();
        }
        userPromptSb.AppendLine("## 当前问题");
        userPromptSb.AppendLine(question);
        if (referenceInfo.IncludedCount == 0 && !webSearchOn)
        {
            // 没挂任何知识库 + 严格模式：在 user 消息里再点一次，避免 LLM 偷懒往外扩
            userPromptSb.AppendLine();
            userPromptSb.AppendLine("（注：本次对话未挂载任何知识库参考资料，请按系统提示直接说明无法回答。）");
        }

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.CcasAgent.Qa.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = false,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPromptSb.ToString() },
                },
                // RAG 场景温度低一点，减少创作性发散
                ["temperature"] = 0.2,
                ["max_tokens"] = 4096,
            },
        };

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: req.SessionId,
            UserId: userId,
            ViewRole: null,
            DocumentChars: question.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"[CCAS_QA:web={webSearchOn}:refs={referenceInfo.IncludedCount}]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.CcasAgent.Qa.Chat));

        await WriteSseAsync("phase", new
        {
            phase = "preparing",
            message = referenceInfo.IncludedCount > 0
                ? $"检索到 {referenceInfo.IncludedCount} 条知识库参考，正在生成…"
                : (webSearchOn ? "未挂载知识库；将以模型公开知识回答…" : "未挂载知识库；将明确告知无法回答…"),
        });

        var sentModel = false;
        var startedAt = DateTime.UtcNow;

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    await WriteSseAsync("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName,
                    });
                    await WriteSseAsync("phase", new { phase = "answering", message = "AI 正在回答…" });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseAsync("typing", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                    _logger.LogError("CcasAgent QA 网关错误 user={UserId}: {Error}", userId, err);
                    try { await WriteSseAsync("error", new { message = $"LLM 网关错误: {err}" }); }
                    catch { }
                    return;
                }
            }

            try
            {
                await WriteSseAsync("done", new
                {
                    elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                    webSearch = webSearchOn,
                });
            }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CcasAgent QA 失败 user={UserId}", userId);
            try { await WriteSseAsync("error", new { message = "智能客服失败：" + ex.Message }); } catch { }
        }
    }

    // ──────────────────────────────────────────────
    // SQL 助手：把陈智版 / 米多版 schema 内化为 system prompt，SSE 流式应答
    // ──────────────────────────────────────────────

    public class SqlAiRequest
    {
        /// <summary>方言：chenzhi-mssql / miduo-mysql / miduo-mssql；未传 = AI 在回复里先确认</summary>
        public string? Dialect { get; set; }

        /// <summary>关联模式（仅陈智版）：bottle-pack / bottle-pack-box / bottle-pack-box-stack / unspecified</summary>
        public string? AssociationMode { get; set; }

        /// <summary>用户问题（必填）</summary>
        public string Question { get; set; } = string.Empty;

        /// <summary>会话 ID（仅用于日志关联）</summary>
        public string? SessionId { get; set; }
    }

    /// <summary>
    /// SQL 助手 SSE 流式问答。事件协议：
    ///   - phase   { phase, message }
    ///   - model   { model, platform }
    ///   - typing  { text }
    ///   - done    { elapsedMs, dialect, associationMode }
    ///   - error   { message }
    /// </summary>
    [HttpPost("sql-ai/stream")]
    [Produces("text/event-stream")]
    public async Task SqlAiStream([FromBody] SqlAiRequest req, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        if (req == null || string.IsNullOrWhiteSpace(req.Question))
        {
            await WriteSseAsync("error", new { message = "请输入问题（question 不能为空）" });
            return;
        }

        var question = req.Question.Trim();
        var dialect = req.Dialect;
        var associationMode = req.AssociationMode;

        var systemPrompt = CcasSqlAiPrompts.BuildSystemPrompt(dialect, associationMode);

        var dialectLabel = (dialect != null && CcasSqlAiPrompts.DialectLabels.TryGetValue(dialect, out var dl))
            ? dl : "未指定";
        var modeLabel = (associationMode != null && CcasSqlAiPrompts.AssociationLabels.TryGetValue(associationMode, out var ml))
            ? ml : "未指定";

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.CcasAgent.SqlAi.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = false,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = question },
                },
                // SQL 生成温度低一点，减少创造性发散
                ["temperature"] = 0.2,
                ["max_tokens"] = 3072,
            },
        };

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: req.SessionId,
            UserId: userId,
            ViewRole: null,
            DocumentChars: question.Length,
            DocumentHash: null,
            SystemPromptRedacted: CcasSqlAiPrompts.BuildRedactedTag(dialect, associationMode),
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.CcasAgent.SqlAi.Chat));

        await WriteSseAsync("phase", new
        {
            phase = "preparing",
            message = $"准备中（数据库：{dialectLabel}，关联模式：{modeLabel}）…",
        });

        var sentModel = false;
        var startedAt = DateTime.UtcNow;

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    await WriteSseAsync("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName,
                    });
                    await WriteSseAsync("phase", new { phase = "answering", message = "AI 正在生成 SQL…" });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseAsync("typing", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                    _logger.LogError("CcasAgent SqlAi 网关错误 user={UserId}: {Error}", userId, err);
                    try { await WriteSseAsync("error", new { message = $"LLM 网关错误: {err}" }); }
                    catch { }
                    return;
                }
            }

            try
            {
                await WriteSseAsync("done", new
                {
                    elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                    dialect,
                    associationMode,
                });
            }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CcasAgent SqlAi 失败 user={UserId}", userId);
            try { await WriteSseAsync("error", new { message = "SQL 助手失败：" + ex.Message }); } catch { }
        }
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

    /// <summary>
    /// 知识库参考资料注入结果（提取出来便于上层做 SSE 通知 + 落库 / 日志）。
    /// IncludedItems：注入成功的条目摘要清单（前端引用列表用），按注入顺序排序，与 [N] 角标对应。
    /// </summary>
    private sealed record ReferenceContext(
        string AppendedContent,
        int IncludedCount,
        int TotalChars,
        List<string> Skipped,
        List<ReferenceItem> IncludedItems);

    /// <summary>注入成功的单条参考资料摘要，给前端做引用脚注用。</summary>
    private sealed record ReferenceItem(int Index, string EntryId, string StoreId, string Title, int Chars);

    /// <summary>
    /// 按用户传入的 entryIds，从「文档空间」(document_store) 拉取内容拼装为 system prompt 末尾追加段。
    /// 权限校验：只引用「自己创建的空间」或「公开空间（IsPublic=true）」中的条目。
    /// 预算控制：单条 ≤ 8K 字符截断；总和 ≤ 24K 字符按选中顺序裁剪。
    /// 内容来源：优先 ParsedPrd.RawContent，回退 Attachment.ExtractedText。
    /// purposeNote：用于注入段落标题，避免 PRD/QA 共用 prompt 时语境混乱。
    /// </summary>
    private sealed record ReferenceEntryCandidate(DocumentEntry Entry, bool FromStoreSelection);

    /// <summary>
    /// 按用户传入的 entryIds / storeIds，从「文档空间」(document_store) 拉取内容拼装为 system prompt 末尾追加段。
    /// 权限校验：只引用「自己创建的空间」或「公开空间（IsPublic=true）」中的条目。
    /// 预算控制：单条 ≤ 40K 字符截断；总和 ≤ 120K 字符按选中顺序裁剪。
    /// 内容来源：优先 ParsedPrd.RawContent，回退 Attachment.ExtractedText。
    /// purposeNote：用于注入段落标题，避免 PRD/QA 共用 prompt 时语境混乱。
    /// </summary>
    private async Task<ReferenceContext> BuildReferenceContextAsync(
        List<string>? entryIds,
        List<string>? storeIds,
        string userId,
        string purposeNote = "PRD")
    {
        var ids = NormalizeIds(entryIds, ReferenceMaxExplicitEntries);
        var selectedStoreIds = NormalizeIds(storeIds, ReferenceMaxStores);
        if (ids.Count == 0 && selectedStoreIds.Count == 0)
        {
            return new ReferenceContext(string.Empty, 0, 0, new List<string>(), new List<ReferenceItem>());
        }

        var skipped = new List<string>();
        var storeById = new Dictionary<string, DocumentStore>(StringComparer.Ordinal);
        if (selectedStoreIds.Count > 0)
        {
            var selectedStores = await _db.DocumentStores
                .Find(s => selectedStoreIds.Contains(s.Id))
                .ToListAsync(CancellationToken.None);
            storeById = selectedStores.ToDictionary(s => s.Id, s => s, StringComparer.Ordinal);
            foreach (var storeId in selectedStoreIds)
            {
                if (!storeById.TryGetValue(storeId, out var store))
                {
                    skipped.Add($"知识库 {storeId}（不存在或已删除）");
                    continue;
                }
                if (!CanReadReferenceStore(store, userId))
                {
                    skipped.Add($"{store.Name}（无访问权限）");
                }
            }
        }

        var candidates = new List<ReferenceEntryCandidate>();
        if (ids.Count > 0)
        {
            var explicitEntries = await _db.DocumentEntries
                .Find(e => ids.Contains(e.Id))
                .ToListAsync(CancellationToken.None);
            var orderMap = ids.Select((id, idx) => new { id, idx }).ToDictionary(x => x.id, x => x.idx);
            candidates.AddRange(explicitEntries
                .OrderBy(e => orderMap.TryGetValue(e.Id, out var i) ? i : int.MaxValue)
                .Select(e => new ReferenceEntryCandidate(e, FromStoreSelection: false)));
        }

        var readableStoreIds = selectedStoreIds
            .Where(id => storeById.TryGetValue(id, out var store) && CanReadReferenceStore(store, userId))
            .ToList();
        if (readableStoreIds.Count > 0)
        {
            var storeEntries = await _db.DocumentEntries
                .Find(e => readableStoreIds.Contains(e.StoreId) && !e.IsFolder)
                .ToListAsync(CancellationToken.None);
            var storeOrder = readableStoreIds.Select((id, idx) => new { id, idx }).ToDictionary(x => x.id, x => x.idx);
            candidates.AddRange(storeEntries
                .OrderBy(e => storeOrder.TryGetValue(e.StoreId, out var i) ? i : int.MaxValue)
                .ThenBy(e => GetPinnedOrder(storeById.GetValueOrDefault(e.StoreId), e.Id))
                .ThenByDescending(e => e.UpdatedAt)
                .Select(e => new ReferenceEntryCandidate(e, FromStoreSelection: true)));
        }

        var dedupedCandidates = new List<ReferenceEntryCandidate>();
        var seenEntryIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var candidate in candidates)
        {
            if (seenEntryIds.Add(candidate.Entry.Id))
            {
                dedupedCandidates.Add(candidate);
            }
        }

        if (dedupedCandidates.Count == 0)
        {
            return new ReferenceContext(string.Empty, 0, 0, skipped, new List<ReferenceItem>());
        }

        var candidateStoreIds = dedupedCandidates.Select(c => c.Entry.StoreId).Distinct().Where(id => !storeById.ContainsKey(id)).ToList();
        if (candidateStoreIds.Count > 0)
        {
            var stores = await _db.DocumentStores
                .Find(s => candidateStoreIds.Contains(s.Id))
                .ToListAsync(CancellationToken.None);
            foreach (var store in stores)
            {
                storeById[store.Id] = store;
            }
        }

        var documentIds = dedupedCandidates
            .Select(c => c.Entry.DocumentId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var attachmentIds = dedupedCandidates
            .Select(c => c.Entry.AttachmentId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var docById = documentIds.Count == 0
            ? new Dictionary<string, ParsedPrd>(StringComparer.Ordinal)
            : (await _db.Documents.Find(d => documentIds.Contains(d.Id)).ToListAsync(CancellationToken.None))
                .ToDictionary(d => d.Id, d => d, StringComparer.Ordinal);
        var attachmentById = attachmentIds.Count == 0
            ? new Dictionary<string, Attachment>(StringComparer.Ordinal)
            : (await _db.Attachments.Find(a => attachmentIds.Contains(a.AttachmentId)).ToListAsync(CancellationToken.None))
                .ToDictionary(a => a.AttachmentId, a => a, StringComparer.Ordinal);

        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine();
        sb.AppendLine("## 领域参考资料（来自知识库）");
        sb.AppendLine();
        sb.AppendLine(purposeNote == "QA"
            ? "以下材料是用户从内部知识库挑选的参考资料，**本次问答只能基于这些材料回答**。回答中请用 `[1]` `[2]` 这样的角标标注来源（角标对应下方的 `参考 #N`）。"
            : "以下材料来自米多内部知识库，作为本次 PRD 生成的事实依据。生成时优先采纳这里的术语、规则、流程定义；与用户输入冲突时按用户输入为准并在文档中标注。");
        sb.AppendLine();

        var includedCount = 0;
        var totalChars = 0;
        var includedItems = new List<ReferenceItem>();

        for (var idx = 0; idx < dedupedCandidates.Count; idx++)
        {
            var entry = dedupedCandidates[idx].Entry;
            if (totalChars >= ReferenceTotalBudget)
            {
                skipped.Add($"后续 {dedupedCandidates.Count - idx} 条（已达上下文预算 {ReferenceTotalBudget} 字符，跳过）");
                break;
            }

            if (!storeById.TryGetValue(entry.StoreId, out var store) || !CanReadReferenceStore(store, userId))
            {
                skipped.Add($"{entry.Title}（无访问权限）");
                continue;
            }
            if (entry.IsFolder)
            {
                skipped.Add($"{entry.Title}（是文件夹，无正文）");
                continue;
            }

            string? content = null;
            if (!string.IsNullOrEmpty(entry.DocumentId) && docById.TryGetValue(entry.DocumentId, out var doc))
            {
                content = doc.RawContent;
            }
            if (string.IsNullOrEmpty(content) && !string.IsNullOrEmpty(entry.AttachmentId)
                && attachmentById.TryGetValue(entry.AttachmentId, out var att))
            {
                content = att.ExtractedText;
            }

            if (string.IsNullOrWhiteSpace(content))
            {
                skipped.Add($"{entry.Title}（无可读正文）");
                continue;
            }

            var truncated = false;
            if (content.Length > ReferenceEntryMaxChars)
            {
                content = content[..ReferenceEntryMaxChars];
                truncated = true;
            }

            var remaining = ReferenceTotalBudget - totalChars;
            if (content.Length > remaining)
            {
                content = content[..Math.Max(0, remaining)];
                truncated = true;
            }

            if (string.IsNullOrEmpty(content))
            {
                skipped.Add($"{entry.Title}（预算已耗尽）");
                continue;
            }

            sb.AppendLine($"### 参考 #{includedCount + 1}：{entry.Title}");
            if (!string.IsNullOrWhiteSpace(entry.Summary))
            {
                sb.AppendLine($"> {entry.Summary.Trim()}");
            }
            sb.AppendLine();
            sb.AppendLine(content);
            if (truncated)
            {
                sb.AppendLine();
                sb.AppendLine("（…该条已截断）");
            }
            sb.AppendLine();

            includedCount++;
            totalChars += content.Length;
            includedItems.Add(new ReferenceItem(
                Index: includedCount,
                EntryId: entry.Id,
                StoreId: entry.StoreId,
                Title: entry.Title ?? string.Empty,
                Chars: content.Length));
        }

        if (includedCount == 0)
        {
            return new ReferenceContext(string.Empty, 0, 0, skipped, new List<ReferenceItem>());
        }

        sb.AppendLine();
        sb.AppendLine($"_（共注入 {includedCount} 条参考资料，约 {totalChars} 字符）_");
        return new ReferenceContext(sb.ToString(), includedCount, totalChars, skipped, includedItems);
    }

    private static List<string> NormalizeIds(List<string>? ids, int max)
        => (ids ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct(StringComparer.Ordinal)
            .Take(max)
            .ToList();

    private static bool CanReadReferenceStore(DocumentStore store, string userId)
        => store.OwnerId == userId || store.IsPublic;

    private static int GetPinnedOrder(DocumentStore? store, string entryId)
    {
        if (store?.PinnedEntryIds == null || store.PinnedEntryIds.Count == 0) return int.MaxValue;
        var idx = store.PinnedEntryIds.IndexOf(entryId);
        return idx < 0 ? int.MaxValue : idx;
    }

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
