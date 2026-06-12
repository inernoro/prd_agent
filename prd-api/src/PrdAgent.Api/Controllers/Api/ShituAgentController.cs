using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.ShituAgent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 识途 Agent（shitu-agent）—— 新人文化与制度问答，内嵌分类知识库。
/// </summary>
[ApiController]
[Route("api/shitu-agent")]
[Authorize]
[AdminController("shitu-agent", AdminPermissionCatalog.ShituAgentUse, WritePermission = AdminPermissionCatalog.ShituAgentManage)]
public class ShituAgentController : ControllerBase
{
    private const string AppKey = "shitu-agent";
    private const string AuthorName = "魏喜胜";

    private const int ReferenceEntryMaxChars = 40000;
    private const int ReferenceTotalBudget = 120000;
    private const int ReferenceMaxExplicitEntries = 200;
    private const int ReferenceMaxStores = 50;

    private static readonly IReadOnlyList<ShituTabDef> TabDefs = new List<ShituTabDef>
    {
        new(ShituQaPrompts.CategoryKeys.Culture, "企业文化", "价值观、使命愿景与行为准则",
            new[] { "公司的核心价值观是什么？", "新人入职需要了解哪些文化习惯？" }),
        new(ShituQaPrompts.CategoryKeys.Incident, "事故教训", "历史事故复盘与规避措施",
            new[] { "历史上发生过哪些典型事故？根因是什么？", "同类问题有哪些规避措施？" }),
        new(ShituQaPrompts.CategoryKeys.Policy, "规章制度", "考勤、请假、报销与合规制度",
            new[] { "请假流程怎么走？", "迟到早退如何处理？" }),
        new(ShituQaPrompts.CategoryKeys.Award, "奖赏表彰", "评优标准与获奖案例",
            new[] { "年度优秀团队有哪些评选标准？", "最近有哪些表彰案例？" }),
    };

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<ShituAgentController> _logger;

    public ShituAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<ShituAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private bool HasManagePermission()
    {
        var perms = User.FindAll("permissions").Select(c => c.Value).ToList();
        return perms.Contains(AdminPermissionCatalog.Super)
               || perms.Contains(AdminPermissionCatalog.ShituAgentManage);
    }

    /// <summary>启动元数据：四个固定 Tab + 各分类知识库 storeId</summary>
    [HttpGet("meta")]
    public async Task<IActionResult> GetMeta()
    {
        var userId = GetUserId();
        var tabs = new List<object>();
        foreach (var def in TabDefs)
        {
            var store = await EnsureCategoryStoreAsync(def.Key, userId);
            tabs.Add(new
            {
                key = def.Key,
                label = def.Label,
                description = def.Description,
                storeId = store.Id,
                storeName = store.Name,
                exampleQuestions = def.ExampleQuestions,
            });
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            tabs,
            canManageKnowledge = HasManagePermission(),
            authorName = AuthorName,
        }));
    }

    /// <summary>解析单个分类知识库（find-or-create）</summary>
    [HttpGet("stores/{categoryKey}")]
    public async Task<IActionResult> GetCategoryStore(string categoryKey)
    {
        var def = TabDefs.FirstOrDefault(t => t.Key == categoryKey.Trim().ToLowerInvariant());
        if (def == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未知的识途分类"));

        var userId = GetUserId();
        var store = await EnsureCategoryStoreAsync(def.Key, userId);
        return Ok(ApiResponse<object>.Ok(new
        {
            storeId = store.Id,
            storeName = store.Name,
            canWrite = HasManagePermission(),
            categoryKey = def.Key,
            label = def.Label,
        }));
    }

    public class QaChatRequest
    {
        /// <summary>分类 key：culture / incident / policy / award</summary>
        public string CategoryKey { get; set; } = ShituQaPrompts.CategoryKeys.Culture;

        public string Message { get; set; } = string.Empty;
        public List<QaHistoryItem>? History { get; set; }
        public List<string>? ReferenceEntryIds { get; set; }
        public List<string>? ReferenceStoreIds { get; set; }
        public string? SessionId { get; set; }
    }

    public class QaHistoryItem
    {
        public string Role { get; set; } = "user";
        public string Content { get; set; } = string.Empty;
    }

    [HttpPost("qa/stream")]
    [Produces("text/event-stream")]
    public async Task QaStream([FromBody] QaChatRequest req)
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

        var categoryKey = string.IsNullOrWhiteSpace(req.CategoryKey)
            ? ShituQaPrompts.CategoryKeys.Culture
            : req.CategoryKey.Trim().ToLowerInvariant();

        if (TabDefs.All(t => t.Key != categoryKey))
        {
            await WriteSseAsync("error", new { message = "未知的识途分类" });
            return;
        }

        var question = req.Message.Trim();
        var primaryStore = await EnsureCategoryStoreAsync(categoryKey, userId);

        var storeIds = new List<string> { primaryStore.Id };
        if (req.ReferenceStoreIds != null)
        {
            foreach (var sid in req.ReferenceStoreIds.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()))
            {
                if (!storeIds.Contains(sid, StringComparer.Ordinal))
                    storeIds.Add(sid);
            }
        }

        var systemPrompt = ShituQaPrompts.BuildSystemPrompt(categoryKey);
        var referenceInfo = await BuildReferenceContextAsync(req.ReferenceEntryIds, storeIds, userId);
        if (!string.IsNullOrEmpty(referenceInfo.AppendedContent))
            systemPrompt += referenceInfo.AppendedContent;

        await WriteSseAsync("reference", new
        {
            requested = (req.ReferenceEntryIds?.Count ?? 0) + storeIds.Count,
            requestedEntries = req.ReferenceEntryIds?.Count ?? 0,
            requestedStores = storeIds.Count,
            included = referenceInfo.IncludedCount,
            totalChars = referenceInfo.TotalChars,
            budget = ReferenceTotalBudget,
            skipped = referenceInfo.Skipped,
            items = referenceInfo.IncludedItems,
        });

        var userPromptSb = new StringBuilder();
        var historyTuples = (req.History ?? new List<QaHistoryItem>())
            .Where(h => !string.IsNullOrWhiteSpace(h.Content))
            .Select(h => ((h.Role ?? "user").Trim().ToLowerInvariant(), h.Content))
            .ToList();
        var historyBlock = ShituQaPrompts.BuildHistoryContext(historyTuples);
        if (!string.IsNullOrWhiteSpace(historyBlock))
        {
            userPromptSb.AppendLine(historyBlock);
            userPromptSb.AppendLine();
        }
        userPromptSb.AppendLine("## 当前问题");
        userPromptSb.AppendLine(question);
        if (referenceInfo.IncludedCount == 0)
        {
            userPromptSb.AppendLine();
            userPromptSb.AppendLine("（注：本次对话未挂载任何知识库参考资料，请按系统提示直接说明无法回答，并建议管理员补充知识库内容。）");
        }

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ShituAgent.Qa.Chat,
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
            SystemPromptRedacted: $"[SHITU_QA:{categoryKey}:refs={referenceInfo.IncludedCount}]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.ShituAgent.Qa.Chat));

        await WriteSseAsync("phase", new
        {
            phase = "preparing",
            message = referenceInfo.IncludedCount > 0
                ? $"检索到 {referenceInfo.IncludedCount} 条知识库参考，正在生成…"
                : "知识库暂无内容；将明确告知无法回答…",
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
                    _logger.LogError("ShituAgent QA 网关错误 user={UserId}: {Error}", userId, err);
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
                    categoryKey,
                });
            }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ShituAgent QA 失败 user={UserId}", userId);
            try { await WriteSseAsync("error", new { message = "识途问答失败：" + ex.Message }); } catch { }
        }
    }

    private async Task<DocumentStore> EnsureCategoryStoreAsync(string categoryKey, string userId)
    {
        var store = await _db.DocumentStores
            .Find(s => s.ShituCategoryRef == categoryKey)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (store != null) return store;

        var def = TabDefs.First(t => t.Key == categoryKey);
        store = new DocumentStore
        {
            Name = $"识途 · {def.Label}",
            Description = def.Description,
            OwnerId = userId,
            AppKey = AppKey,
            ShituCategoryRef = categoryKey,
            IsPublic = false,
        };
        await _db.DocumentStores.InsertOneAsync(store, cancellationToken: CancellationToken.None);
        return store;
    }

    private sealed record ShituTabDef(string Key, string Label, string Description, string[] ExampleQuestions);

    private sealed record ReferenceItem(int Index, string EntryId, string StoreId, string Title, int Chars);
    private sealed record ReferenceContext(
        string AppendedContent,
        int IncludedCount,
        int TotalChars,
        List<string> Skipped,
        List<ReferenceItem> IncludedItems);
    private sealed record ReferenceEntryCandidate(DocumentEntry Entry, bool FromStoreSelection);

    private async Task<ReferenceContext> BuildReferenceContextAsync(
        List<string>? entryIds,
        List<string>? storeIds,
        string userId)
    {
        var ids = NormalizeIds(entryIds, ReferenceMaxExplicitEntries);
        var selectedStoreIds = NormalizeIds(storeIds, ReferenceMaxStores);
        if (ids.Count == 0 && selectedStoreIds.Count == 0)
            return new ReferenceContext(string.Empty, 0, 0, new List<string>(), new List<ReferenceItem>());

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
                    skipped.Add($"{store.Name}（无访问权限）");
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
                .ThenByDescending(e => e.UpdatedAt)
                .Select(e => new ReferenceEntryCandidate(e, FromStoreSelection: true)));
        }

        var deduped = new List<ReferenceEntryCandidate>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in candidates)
        {
            if (seen.Add(c.Entry.Id)) deduped.Add(c);
        }

        if (deduped.Count == 0)
            return new ReferenceContext(string.Empty, 0, 0, skipped, new List<ReferenceItem>());

        var candidateStoreIds = deduped.Select(c => c.Entry.StoreId).Distinct()
            .Where(id => !storeById.ContainsKey(id)).ToList();
        if (candidateStoreIds.Count > 0)
        {
            var extraStores = await _db.DocumentStores
                .Find(s => candidateStoreIds.Contains(s.Id))
                .ToListAsync(CancellationToken.None);
            foreach (var s in extraStores) storeById[s.Id] = s;
        }

        var docIds = deduped.Where(c => !string.IsNullOrEmpty(c.Entry.DocumentId)).Select(c => c.Entry.DocumentId!).Distinct().ToList();
        var attIds = deduped.Where(c => !string.IsNullOrEmpty(c.Entry.AttachmentId)).Select(c => c.Entry.AttachmentId!).Distinct().ToList();
        var docById = docIds.Count == 0
            ? new Dictionary<string, ParsedPrd>(StringComparer.Ordinal)
            : (await _db.Documents.Find(d => docIds.Contains(d.Id)).ToListAsync(CancellationToken.None))
                .ToDictionary(d => d.Id, d => d, StringComparer.Ordinal);
        var attachmentById = attIds.Count == 0
            ? new Dictionary<string, Attachment>(StringComparer.Ordinal)
            : (await _db.Attachments.Find(a => attIds.Contains(a.AttachmentId)).ToListAsync(CancellationToken.None))
                .ToDictionary(a => a.AttachmentId, a => a, StringComparer.Ordinal);

        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine("## 领域参考资料（严格 RAG 上下文）");
        sb.AppendLine();

        var includedCount = 0;
        var totalChars = 0;
        var includedItems = new List<ReferenceItem>();

        foreach (var candidate in deduped)
        {
            var entry = candidate.Entry;
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
                content = doc.RawContent;
            if (string.IsNullOrEmpty(content) && !string.IsNullOrEmpty(entry.AttachmentId)
                && attachmentById.TryGetValue(entry.AttachmentId, out var att))
                content = att.ExtractedText;

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
                sb.AppendLine($"> {entry.Summary.Trim()}");
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
            includedItems.Add(new ReferenceItem(includedCount, entry.Id, entry.StoreId, entry.Title ?? string.Empty, content.Length));
        }

        if (includedCount == 0)
            return new ReferenceContext(string.Empty, 0, 0, skipped, new List<ReferenceItem>());

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

    private bool CanReadReferenceStore(DocumentStore store, string userId)
    {
        if (store.OwnerId == userId) return true;
        if (!string.IsNullOrEmpty(store.ShituCategoryRef)) return true;
        return store.IsPublic;
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
}
