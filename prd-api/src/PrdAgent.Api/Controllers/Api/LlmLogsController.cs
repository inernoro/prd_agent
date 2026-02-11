using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - LLM 请求日志
/// </summary>
[ApiController]
[Route("api/logs/llm")]
[Authorize]
[AdminController("logs", AdminPermissionCatalog.LogsRead)]
public class LlmLogsController : ControllerBase
{
    private sealed class MetaUser
    {
        public string UserId { get; init; } = string.Empty;
        public string? Username { get; init; }
    }

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;

    public LlmLogsController(MongoDbContext db, IAssetStorage assetStorage)
    {
        _db = db;
        _assetStorage = assetStorage;
    }

    private static string TruncatePreview(string? s, int maxChars)
    {
        var raw = (s ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        if (raw.Length <= maxChars) return raw;
        return raw[..maxChars] + "…";
    }

    private static string ExtractQuestionPreview(string? requestBodyRedacted)
    {
        var raw = (requestBodyRedacted ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(raw)) return string.Empty;

        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return string.Empty;

            if (!root.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array)
                return string.Empty;

            // 优先取最后一个 user 消息作为“问题”
            for (var i = messages.GetArrayLength() - 1; i >= 0; i--)
            {
                var msg = messages[i];
                if (msg.ValueKind != JsonValueKind.Object) continue;
                if (!msg.TryGetProperty("role", out var roleEl)) continue;
                var role = roleEl.GetString() ?? string.Empty;
                if (!role.Equals("user", StringComparison.OrdinalIgnoreCase)) continue;

                if (!msg.TryGetProperty("content", out var contentEl)) continue;
                var content = ExtractContentText(contentEl);
                return TruncatePreview(content, 260);
            }

            // 退化：取最后一条消息（不管 role）
            if (messages.GetArrayLength() > 0)
            {
                var last = messages[messages.GetArrayLength() - 1];
                if (last.ValueKind == JsonValueKind.Object && last.TryGetProperty("content", out var contentEl))
                {
                    var content = ExtractContentText(contentEl);
                    return TruncatePreview(content, 260);
                }
            }
        }
        catch
        {
            // ignore
        }

        return string.Empty;
    }

    private static string ExtractContentText(JsonElement contentEl)
    {
        // OpenAI: content: "..."
        if (contentEl.ValueKind == JsonValueKind.String) return contentEl.GetString() ?? string.Empty;

        // OpenAI Vision: content: [{type:"text", text:"..."}, ...]
        if (contentEl.ValueKind == JsonValueKind.Array)
        {
            var sb = new StringBuilder();
            foreach (var part in contentEl.EnumerateArray())
            {
                if (part.ValueKind != JsonValueKind.Object) continue;
                if (part.TryGetProperty("type", out var typeEl))
                {
                    var t = typeEl.GetString() ?? string.Empty;
                    if (t.Equals("text", StringComparison.OrdinalIgnoreCase) && part.TryGetProperty("text", out var textEl) && textEl.ValueKind == JsonValueKind.String)
                    {
                        if (sb.Length > 0) sb.Append('\n');
                        sb.Append(textEl.GetString());
                    }
                }
            }
            return sb.ToString();
        }

        return string.Empty;
    }

    private static string ExtractAnswerPreviewText(string? answerText)
    {
        return TruncatePreview(answerText, 1800);
    }

    [HttpGet("meta")]
    public async Task<IActionResult> Meta()
    {
        // 下拉枚举：为了稳定性，status 使用固定枚举；provider/model/requestPurposes 使用 distinct
        var providers = (await _db.LlmRequestLogs
                .Distinct(x => x.Provider, Builders<LlmRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var models = (await _db.LlmRequestLogs
                .Distinct(x => x.Model, Builders<LlmRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        // 聚合获取所有 RequestPurpose 及其存储的 DisplayName
        // 优先使用日志中存储的 displayName（自包含），其次使用注册表，最后使用原始值
        var requestPurposeAggregation = await _db.LlmRequestLogs
            .Aggregate()
            .Match(Builders<LlmRequestLog>.Filter.Ne(x => x.RequestPurpose, null))
            .Group(x => x.RequestPurpose, g => new
            {
                Value = g.Key,
                StoredDisplayName = g.First().RequestPurposeDisplayName
            })
            .ToListAsync();

        var requestPurposes = requestPurposeAggregation
            .Where(x => !string.IsNullOrWhiteSpace(x.Value))
            .Select(x => new
            {
                value = x.Value,
                // 优先级：存储的 DisplayName > 注册表查询 > 原始值
                displayName = !string.IsNullOrWhiteSpace(x.StoredDisplayName)
                    ? x.StoredDisplayName
                    : AppCallerRegistrationService.FindByAppCode(x.Value!)?.DisplayName ?? x.Value
            })
            .OrderBy(x => x.displayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var statuses = new[] { "running", "succeeded", "failed", "cancelled" };

        var userIds = (await _db.LlmRequestLogs
                .Distinct(x => x.UserId, Builders<LlmRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var users = await _db.Users.Find(u => userIds.Contains(u.UserId))
            .Project(u => new MetaUser { UserId = u.UserId, Username = u.Username })
            .ToListAsync();

        var metaUsers = users.ToList();

        var knownUserIds = new HashSet<string>(metaUsers.Select(x => x.UserId), StringComparer.OrdinalIgnoreCase);
        foreach (var userId in userIds)
        {
            if (!knownUserIds.Contains(userId))
            {
                metaUsers.Add(new MetaUser { UserId = userId });
            }
        }

        metaUsers = metaUsers
            .OrderBy(x => x.Username ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ThenBy(x => x.UserId, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { providers, models, requestPurposes, statuses, users = metaUsers }));
    }

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null,
        [FromQuery] string? provider = null,
        [FromQuery] string? model = null,
        [FromQuery] string? requestId = null,
        [FromQuery] string? groupId = null,
        [FromQuery] string? sessionId = null,
        [FromQuery] string? userId = null,
        [FromQuery] string? status = null,
        [FromQuery] string? requestPurpose = null)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 200);

        var filter = Builders<LlmRequestLog>.Filter.Empty;
        if (from.HasValue) filter &= Builders<LlmRequestLog>.Filter.Gte(x => x.StartedAt, from.Value);
        if (to.HasValue) filter &= Builders<LlmRequestLog>.Filter.Lte(x => x.StartedAt, to.Value);
        if (!string.IsNullOrWhiteSpace(provider)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Provider, provider);
        if (!string.IsNullOrWhiteSpace(model)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Model, model);
        if (!string.IsNullOrWhiteSpace(requestId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.RequestId, requestId);
        if (!string.IsNullOrWhiteSpace(groupId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.GroupId, groupId);
        if (!string.IsNullOrWhiteSpace(sessionId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.SessionId, sessionId);
        if (!string.IsNullOrWhiteSpace(userId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.UserId, userId);
        if (!string.IsNullOrWhiteSpace(status)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Status, status);
        if (!string.IsNullOrWhiteSpace(requestPurpose)) filter &= Builders<LlmRequestLog>.Filter.Regex(x => x.RequestPurpose, new BsonRegularExpression($"^{Regex.Escape(requestPurpose)}", "i"));

        var total = await _db.LlmRequestLogs.CountDocumentsAsync(filter);
        var rawItems = await _db.LlmRequestLogs.Find(filter)
            .SortByDescending(x => x.StartedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .Project(x => new
            {
                x.Id,
                x.RequestId,
                x.Provider,
                x.Model,
                x.ApiBase,
                x.Path,
                x.HttpMethod,
                x.PlatformId,
                x.PlatformName,
                x.ModelResolutionType,
                x.ModelGroupId,
                x.ModelGroupName,
                x.GroupId,
                x.SessionId,
                x.UserId,
                x.ViewRole,
                x.RequestType,
                x.RequestPurpose,
                x.RequestPurposeDisplayName,
                x.Status,
                x.StartedAt,
                x.FirstByteAt,
                x.EndedAt,
                x.DurationMs,
                x.StatusCode,
                x.InputTokens,
                x.OutputTokens,
                x.CacheCreationInputTokens,
                x.CacheReadInputTokens,
                x.Error,
                x.QuestionText,
                x.AnswerText,
                x.IsFallback,
                x.ExpectedModel
            })
            .ToListAsync();

        var items = rawItems.Select(x => new
        {
            x.Id,
            x.RequestId,
            x.Provider,
            x.Model,
            x.ApiBase,
            x.Path,
            x.HttpMethod,
            x.PlatformId,
            x.PlatformName,
            x.ModelResolutionType,
            x.ModelGroupId,
            x.ModelGroupName,
            x.GroupId,
            x.SessionId,
            x.UserId,
            x.ViewRole,
            x.RequestType,
            x.RequestPurpose,
            x.RequestPurposeDisplayName,
            x.Status,
            x.StartedAt,
            x.FirstByteAt,
            x.EndedAt,
            x.DurationMs,
            x.StatusCode,
            x.InputTokens,
            x.OutputTokens,
            x.CacheCreationInputTokens,
            x.CacheReadInputTokens,
            x.Error,
            x.IsFallback,
            x.ExpectedModel,

            questionPreview = TruncatePreview(x.QuestionText, 260),
            answerPreview = ExtractAnswerPreviewText(x.AnswerText)
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Detail(string id)
    {
        var log = await _db.LlmRequestLogs.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (log == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "日志不存在"));

        return Ok(ApiResponse<LlmRequestLog>.Ok(log));
    }

    /// <summary>
    /// 生成可重放的 curl 命令（通用：恢复截断的文本 + 从 COS 恢复 base64 图片）。
    /// 支持三种图片引用格式：
    ///   1. [BASE64_IMAGE:sha256:mime] — 新格式（LogWriter 写入时自动提取）
    ///   2. image_url.sha256 属性 — 旧格式（visionImageGen 路径）
    ///   3. image_refs[] + prompt — 旧扁平格式（兼容历史日志）
    /// 同时恢复被截断的 systemPromptText / questionText。
    /// </summary>
    [HttpGet("{id}/replay-curl")]
    public async Task<IActionResult> ReplayCurl(string id)
    {
        var log = await _db.LlmRequestLogs.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (log == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "日志不存在"));

        try
        {
            if (string.IsNullOrWhiteSpace(log.RequestBodyRedacted))
                return BadRequest(ApiResponse<object>.Fail("NO_REQUEST_BODY", "请求体为空"));

            // 先在原始 JSON 字符串上恢复 COS 引用（图片 + 长文本）
            var restoreErrors = new List<string>();
            var imageCount = 0;
            var textCount = 0;
            var bodyJson = log.RequestBodyRedacted!;

            // 恢复 [TEXT_COS:sha256:charcount] → 原始文本（从 COS 取回）
            var textCosPattern = new Regex(@"\[TEXT_COS:([0-9a-f]{64}):(\d+)\]");
            var textMatches = textCosPattern.Matches(bodyJson);
            if (textMatches.Count > 0)
            {
                var sb = new StringBuilder(bodyJson);
                for (var i = textMatches.Count - 1; i >= 0; i--)
                {
                    var m = textMatches[i];
                    var sha256 = m.Groups[1].Value;

                    var found = await _assetStorage.TryReadByShaAsync(
                        sha256, HttpContext.RequestAborted,
                        domain: AppDomainPaths.DomainLogs,
                        type: AppDomainPaths.TypeLog);

                    if (found == null)
                    {
                        restoreErrors.Add($"COS 未找到文本: {sha256[..12]}...");
                        continue;
                    }

                    textCount++;
                    var text = Encoding.UTF8.GetString(found.Value.bytes);
                    sb.Remove(m.Index, m.Length);
                    sb.Insert(m.Index, text);
                }
                bodyJson = sb.ToString();
            }

            // 恢复 [BASE64_IMAGE:sha256:mime] → data:mime;base64,...（从 COS 取回原图）
            var base64RefPattern = new Regex(@"\[BASE64_IMAGE:([0-9a-f]{64}):([^\]]+)\]");
            var refMatches = base64RefPattern.Matches(bodyJson);
            if (refMatches.Count > 0)
            {
                var sb = new StringBuilder(bodyJson);
                // 倒序替换避免偏移
                for (var i = refMatches.Count - 1; i >= 0; i--)
                {
                    var m = refMatches[i];
                    var sha256 = m.Groups[1].Value;
                    var mime = m.Groups[2].Value;

                    var found = await _assetStorage.TryReadByShaAsync(
                        sha256, HttpContext.RequestAborted,
                        domain: AppDomainPaths.DomainVisualAgent,
                        type: AppDomainPaths.TypeImg);

                    if (found == null)
                    {
                        restoreErrors.Add($"COS 未找到图片: {sha256[..12]}...");
                        continue;
                    }

                    imageCount++;
                    var b64 = Convert.ToBase64String(found.Value.bytes);
                    var actualMime = string.IsNullOrWhiteSpace(found.Value.mime) ? mime : found.Value.mime;
                    var dataUrl = $"data:{actualMime};base64,{b64}";
                    sb.Remove(m.Index, m.Length);
                    sb.Insert(m.Index, dataUrl);
                }
                bodyJson = sb.ToString();
            }

            // 恢复被截断的文本字段（systemPrompt / questionText）
            bodyJson = RestoreTruncatedTextFields(bodyJson, log.SystemPromptText, log.QuestionText);

            // 兼容旧 visionImageGen 格式：image_url.sha256 属性 + image_refs[]
            using var doc = JsonDocument.Parse(bodyJson);
            var root = doc.RootElement;
            var hasOldSha256Refs = false;

            if (root.TryGetProperty("messages", out var msgsEl) && msgsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var msg in msgsEl.EnumerateArray())
                {
                    if (!msg.TryGetProperty("content", out var cEl) || cEl.ValueKind != JsonValueKind.Array) continue;
                    foreach (var item in cEl.EnumerateArray())
                    {
                        if (item.TryGetProperty("type", out var t) && t.GetString() == "image_url"
                            && item.TryGetProperty("image_url", out var iu) && iu.TryGetProperty("sha256", out _))
                        {
                            hasOldSha256Refs = true;
                            break;
                        }
                    }
                    if (hasOldSha256Refs) break;
                }
            }
            var hasOldImageRefs = root.TryGetProperty("image_refs", out _);

            if (hasOldSha256Refs || hasOldImageRefs)
            {
                // 走旧逻辑：完全重建请求体
                return await ReplayCurlLegacy(log, root, restoreErrors);
            }

            // 通用路径：使用（已恢复图片引用的）bodyJson 构建 curl
            var endpoint = JoinBaseAndPath(log.ApiBase, log.Path) ?? "https://api.example.com/v1/chat/completions";
            var apiKeyPlaceholder = "YOUR_API_KEY";
            try
            {
                var host = new Uri(endpoint).Host;
                if (!string.IsNullOrEmpty(host)) apiKeyPlaceholder = $"{{{{{host}}}}}";
            }
            catch { }

            // 决定认证头
            var providerLower = (log.Provider ?? "").ToLowerInvariant();
            var isAnthropicLike = providerLower.Contains("claude") || providerLower.Contains("anthropic");
            var authHeader = isAnthropicLike
                ? $"-H 'x-api-key: {apiKeyPlaceholder}'"
                : $"-H 'Authorization: Bearer {apiKeyPlaceholder}'";

            var method = string.IsNullOrWhiteSpace(log.HttpMethod) ? "POST" : log.HttpMethod.Trim().ToUpperInvariant();

            // 美化 JSON
            string prettyBody;
            try
            {
                using var prettyDoc = JsonDocument.Parse(bodyJson);
                prettyBody = JsonSerializer.Serialize(prettyDoc, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            }
            catch { prettyBody = bodyJson; }

            var curl = $"curl -X {method} '{endpoint}' \\\n" +
                       $"  -H 'Content-Type: application/json' \\\n" +
                       $"  {authHeader} \\\n" +
                       $"  --data-raw '{EscapeSingleQuotesForShell(prettyBody)}'";

            return Ok(ApiResponse<object>.Ok(new
            {
                curl,
                endpoint,
                imageCount,
                textCount,
                restoreErrors = restoreErrors.Count > 0 ? restoreErrors : null,
                requestBodyLength = prettyBody.Length,
                warning = restoreErrors.Count > 0 ? "部分内容恢复失败，curl 可能不完整" : null
            }));
        }
        catch (JsonException ex)
        {
            return BadRequest(ApiResponse<object>.Fail("JSON_PARSE_ERROR", $"解析请求体失败: {ex.Message}"));
        }
    }

    /// <summary>旧 visionImageGen 格式：sha256 属性 / image_refs[]</summary>
    private async Task<IActionResult> ReplayCurlLegacy(
        LlmRequestLog log, JsonElement root, List<string> restoreErrors)
    {
        var model = root.TryGetProperty("model", out var mEl) ? mEl.GetString() ?? "" : "";
        var contentItems = new List<object>();
        string? prompt = null;

        if (root.TryGetProperty("messages", out var messagesEl) && messagesEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var msg in messagesEl.EnumerateArray())
            {
                if (!msg.TryGetProperty("content", out var contentEl) || contentEl.ValueKind != JsonValueKind.Array)
                    continue;
                foreach (var item in contentEl.EnumerateArray())
                {
                    if (!item.TryGetProperty("type", out var typeEl)) continue;
                    var itemType = typeEl.GetString();
                    if (itemType == "text" && item.TryGetProperty("text", out var textEl))
                    {
                        prompt = textEl.GetString();
                        contentItems.Add(new { type = "text", text = prompt });
                    }
                    else if (itemType == "image_url" && item.TryGetProperty("image_url", out var imgUrlEl))
                    {
                        var sha256 = imgUrlEl.TryGetProperty("sha256", out var s) ? s.GetString()?.Trim().ToLowerInvariant() : null;
                        if (string.IsNullOrWhiteSpace(sha256) || sha256.Length != 64)
                        {
                            restoreErrors.Add($"无效的 sha256: {sha256}");
                            continue;
                        }
                        var found = await _assetStorage.TryReadByShaAsync(sha256, HttpContext.RequestAborted,
                            domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                        if (found == null) { restoreErrors.Add($"COS 未找到图片: {sha256[..12]}..."); continue; }
                        var b64 = Convert.ToBase64String(found.Value.bytes);
                        var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? "image/png" : found.Value.mime;
                        contentItems.Add(new { type = "image_url", image_url = new { url = $"data:{mime};base64,{b64}" } });
                    }
                }
            }
        }
        else if (root.TryGetProperty("image_refs", out var imageRefsEl) && root.TryGetProperty("prompt", out var promptEl))
        {
            prompt = promptEl.GetString() ?? string.Empty;
            contentItems.Add(new { type = "text", text = prompt });
            foreach (var imgRef in imageRefsEl.EnumerateArray())
            {
                var sha256 = imgRef.TryGetProperty("sha256", out var s) ? s.GetString()?.Trim().ToLowerInvariant() : null;
                if (string.IsNullOrWhiteSpace(sha256) || sha256.Length != 64) { restoreErrors.Add($"无效的 sha256: {sha256}"); continue; }
                var mime = imgRef.TryGetProperty("mime", out var mimeEl) ? mimeEl.GetString() ?? "image/png" : "image/png";
                var found = await _assetStorage.TryReadByShaAsync(sha256, HttpContext.RequestAborted,
                    domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
                if (found == null) { restoreErrors.Add($"COS 未找到图片: {sha256[..12]}..."); continue; }
                var b64 = Convert.ToBase64String(found.Value.bytes);
                contentItems.Add(new { type = "image_url", image_url = new { url = $"data:{mime};base64,{b64}" } });
            }
        }

        var fullReq = new { model, max_tokens = 4096, messages = new[] { new { role = "user", content = contentItems } } };
        var reqJson = JsonSerializer.Serialize(fullReq, new JsonSerializerOptions { WriteIndented = false });

        var endpoint = JoinBaseAndPath(log.ApiBase, log.Path) ?? "https://api.example.com/v1/chat/completions";
        var apiKeyPlaceholder = "YOUR_API_KEY";
        try { var host = new Uri(endpoint).Host; if (!string.IsNullOrEmpty(host)) apiKeyPlaceholder = $"{{{{{host}}}}}"; } catch { }

        var curl = $"curl -X POST '{endpoint}' \\\n" +
                   $"  -H 'Content-Type: application/json' \\\n" +
                   $"  -H 'Authorization: Bearer {apiKeyPlaceholder}' \\\n" +
                   $"  --data-raw '{EscapeSingleQuotesForShell(reqJson)}'";

        return Ok(ApiResponse<object>.Ok(new
        {
            curl, endpoint, model,
            imageCount = contentItems.Count - (string.IsNullOrWhiteSpace(prompt) ? 0 : 1),
            restoreErrors = restoreErrors.Count > 0 ? restoreErrors : null,
            requestBodyLength = reqJson.Length,
            warning = restoreErrors.Count > 0 ? "部分内容恢复失败，curl 可能不完整" : null
        }));
    }

    /// <summary>恢复 requestBody 中被截断的文本（系统提示词、用户消息）</summary>
    private static string RestoreTruncatedTextFields(string bodyJson, string? systemPromptText, string? questionText)
    {
        if (string.IsNullOrWhiteSpace(bodyJson)) return bodyJson;

        try
        {
            var node = System.Text.Json.Nodes.JsonNode.Parse(bodyJson);
            if (node is not System.Text.Json.Nodes.JsonObject obj) return bodyJson;

            var messages = obj["messages"] as System.Text.Json.Nodes.JsonArray;
            if (messages == null) return bodyJson;

            foreach (var msg in messages)
            {
                if (msg is not System.Text.Json.Nodes.JsonObject msgObj) continue;
                var role = msgObj["role"]?.GetValue<string>();

                // 恢复 system 消息的 content
                if (role == "system" && !string.IsNullOrWhiteSpace(systemPromptText))
                {
                    var content = msgObj["content"];
                    if (content is System.Text.Json.Nodes.JsonValue v && IsTruncatedOrRedacted(v.GetValue<string>()))
                    {
                        msgObj["content"] = systemPromptText;
                    }
                }

                // 恢复最后一个 user 消息的文本
                if (role == "user" && !string.IsNullOrWhiteSpace(questionText))
                {
                    var content = msgObj["content"];
                    if (content is System.Text.Json.Nodes.JsonValue uv && IsTruncatedOrRedacted(uv.GetValue<string>()))
                    {
                        msgObj["content"] = questionText;
                    }
                    else if (content is System.Text.Json.Nodes.JsonArray arr)
                    {
                        foreach (var part in arr)
                        {
                            if (part is not System.Text.Json.Nodes.JsonObject po) continue;
                            if (po["type"]?.GetValue<string>() != "text") continue;
                            var txt = po["text"]?.GetValue<string>();
                            if (IsTruncatedOrRedacted(txt)) po["text"] = questionText;
                        }
                    }
                }
            }

            // 恢复顶层 system / system_prompt
            foreach (var key in new[] { "system", "system_prompt", "systemPrompt" })
            {
                if (obj[key] is System.Text.Json.Nodes.JsonValue sv && !string.IsNullOrWhiteSpace(systemPromptText)
                    && IsTruncatedOrRedacted(sv.GetValue<string>()))
                {
                    obj[key] = systemPromptText;
                }
            }

            return obj.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        }
        catch
        {
            return bodyJson;
        }
    }

    private static bool IsTruncatedOrRedacted(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return false;
        s = s.Trim();
        if (s.StartsWith('[') && s.EndsWith(']') && (s.Contains("REDACTED") || s.Contains("PROMPT"))) return true;
        return System.Text.RegularExpressions.Regex.IsMatch(s, @"\.\.\.\[\d+ chars trimmed\]$");
    }

    private static string JoinBaseAndPath(string? apiBase, string? path)
    {
        var b = (apiBase ?? "").TrimEnd('/');
        var p = (path ?? "").TrimStart('/');
        if (string.IsNullOrWhiteSpace(b)) return string.IsNullOrWhiteSpace(p) ? "" : p;
        return string.IsNullOrWhiteSpace(p) ? b : $"{b}/{p}";
    }

    private static string EscapeSingleQuotesForShell(string s)
        => s.Replace("'", "'\\''");

    /// <summary>
    /// 按模型聚合的近 N 天统计（用于模型管理页展示"请求次数/平均耗时/首字延迟/token"等）
    /// 说明：LLMRequestLogs 默认 TTL 为 7 天，因此该接口也主要用于近 7 天。
    /// </summary>
    [HttpGet("model-stats")]
    public async Task<IActionResult> ModelStats(
        [FromQuery] int days = 7,
        [FromQuery] string? provider = null,
        [FromQuery] string? model = null,
        [FromQuery] string? status = null,
        [FromQuery] string? platformId = null,
        [FromQuery] string? requestPurpose = null)
    {
        days = Math.Clamp(days, 1, 30);
        var from = DateTime.UtcNow.AddDays(-days);

        var filter = Builders<LlmRequestLog>.Filter.Gte(x => x.StartedAt, from);
        if (!string.IsNullOrWhiteSpace(provider)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Provider, provider);
        if (!string.IsNullOrWhiteSpace(model)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Model, model);
        if (!string.IsNullOrWhiteSpace(status)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Status, status);
        if (!string.IsNullOrWhiteSpace(platformId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.PlatformId, platformId);
        if (!string.IsNullOrWhiteSpace(requestPurpose)) filter &= Builders<LlmRequestLog>.Filter.Regex(x => x.RequestPurpose, new BsonRegularExpression($"^{Regex.Escape(requestPurpose)}", "i"));

        // 用聚合管道避免把大量日志拉回内存
        var matchDoc = filter.Render(new RenderArgs<LlmRequestLog>(
            _db.LlmRequestLogs.DocumentSerializer,
            _db.LlmRequestLogs.Settings.SerializerRegistry));

        var pipeline = new[]
        {
            new BsonDocument("$match", matchDoc),
            new BsonDocument("$project", new BsonDocument
            {
                { "provider", "$Provider" },
                { "model", "$Model" },
                { "platformId", "$PlatformId" },
                { "durationMs", "$DurationMs" },
                { "inputTokens", "$InputTokens" },
                { "outputTokens", "$OutputTokens" },
                { "status", "$Status" },
                // 首字延迟：FirstByteAt - StartedAt（单位 ms）；若缺失则为 null
                { "ttfbMs", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$and", new BsonArray
                        {
                            new BsonDocument("$ne", new BsonArray { "$FirstByteAt", BsonNull.Value }),
                            new BsonDocument("$ne", new BsonArray { "$StartedAt", BsonNull.Value }),
                        }),
                        new BsonDocument("$subtract", new BsonArray { "$FirstByteAt", "$StartedAt" }),
                        BsonNull.Value
                    })
                }
            }),
            new BsonDocument("$group", new BsonDocument
            {
                { "_id", new BsonDocument { { "provider", "$provider" }, { "model", "$model" }, { "platformId", "$platformId" } } },
                { "requestCount", new BsonDocument("$sum", 1) },
                { "avgDurationMs", new BsonDocument("$avg", "$durationMs") },
                { "avgTtfbMs", new BsonDocument("$avg", "$ttfbMs") },
                { "totalInputTokens", new BsonDocument("$sum", new BsonDocument("$ifNull", new BsonArray { "$inputTokens", 0 })) },
                { "totalOutputTokens", new BsonDocument("$sum", new BsonDocument("$ifNull", new BsonArray { "$outputTokens", 0 })) },
                // 成功/失败计数（用于成功率计算）
                { "successCount", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$status", "succeeded" }),
                        1,
                        0
                    }))
                },
                { "failCount", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$status", "failed" }),
                        1,
                        0
                    }))
                },
            }),
            new BsonDocument("$project", new BsonDocument
            {
                { "_id", 0 },
                { "provider", "$_id.provider" },
                { "model", "$_id.model" },
                { "platformId", "$_id.platformId" },
                { "requestCount", 1 },
                // round to int for UI friendliness
                { "avgDurationMs", new BsonDocument("$round", new BsonArray { "$avgDurationMs", 0 }) },
                { "avgTtfbMs", new BsonDocument("$round", new BsonArray { "$avgTtfbMs", 0 }) },
                { "totalInputTokens", 1 },
                { "totalOutputTokens", 1 },
                { "successCount", 1 },
                { "failCount", 1 },
            }),
            new BsonDocument("$sort", new BsonDocument("requestCount", -1)),
        };

        var items = await _db.LlmRequestLogs.Aggregate<BsonDocument>(pipeline).ToListAsync();

        // 重要：不要直接返回 BsonDocument/BsonValue 给 System.Text.Json。
        // 否则它会反射访问 BsonValue.AsBoolean/AsString 等属性，遇到非匹配类型时会抛 InvalidCastException。
        // 这里将聚合结果映射为“纯 .NET 基础类型”的对象数组，确保稳定序列化。
        static object? ToDotNet(BsonValue v)
        {
            if (v == null || v.IsBsonNull) return null;
            return BsonTypeMapper.MapToDotNetValue(v);
        }

        var safeItems = items.Select(d =>
        {
            d.TryGetValue("provider", out var p);
            d.TryGetValue("model", out var m);
            d.TryGetValue("platformId", out var pid);
            d.TryGetValue("requestCount", out var rc);
            d.TryGetValue("avgDurationMs", out var avgDur);
            d.TryGetValue("avgTtfbMs", out var avgTtfb);
            d.TryGetValue("totalInputTokens", out var tin);
            d.TryGetValue("totalOutputTokens", out var tout);
            d.TryGetValue("successCount", out var sc);
            d.TryGetValue("failCount", out var fc);

            return new
            {
                provider = (ToDotNet(p) ?? string.Empty)?.ToString(),
                model = (ToDotNet(m) ?? string.Empty)?.ToString(),
                platformId = (ToDotNet(pid) ?? string.Empty)?.ToString(),
                requestCount = ToDotNet(rc),
                avgDurationMs = ToDotNet(avgDur),
                avgTtfbMs = ToDotNet(avgTtfb),
                totalInputTokens = ToDotNet(tin),
                totalOutputTokens = ToDotNet(tout),
                successCount = ToDotNet(sc),
                failCount = ToDotNet(fc),
            };
        }).ToList();

        // 返回 object：与现有 List/Meta 保持一致
        return Ok(ApiResponse<object>.Ok(new { days, items = safeItems }));
    }

    /// <summary>
    /// 批量获取多个 (appCallerCode, platformId, modelId) 组合的统计数据
    /// 用于模型池页面按应用+模型组合展示调用统计
    /// </summary>
    [HttpPost("model-stats/batch")]
    public async Task<IActionResult> BatchModelStats([FromBody] BatchModelStatsRequest request)
    {
        var days = Math.Clamp(request.Days, 1, 30);
        var from = DateTime.UtcNow.AddDays(-days);

        var results = new Dictionary<string, object?>();

        foreach (var item in request.Items ?? new List<BatchModelStatsItem>())
        {
            if (string.IsNullOrWhiteSpace(item.PlatformId) || string.IsNullOrWhiteSpace(item.ModelId))
                continue;

            var key = $"{item.AppCallerCode ?? ""}:{item.PlatformId}:{item.ModelId}".ToLowerInvariant();
            
            // 避免重复计算
            if (results.ContainsKey(key))
                continue;

            var filter = Builders<LlmRequestLog>.Filter.And(
                Builders<LlmRequestLog>.Filter.Gte(x => x.StartedAt, from),
                Builders<LlmRequestLog>.Filter.Eq(x => x.PlatformId, item.PlatformId),
                Builders<LlmRequestLog>.Filter.Eq(x => x.Model, item.ModelId)
            );

            // 如果指定了 appCallerCode，则按前缀匹配 RequestPurpose
            if (!string.IsNullOrWhiteSpace(item.AppCallerCode))
            {
                filter = Builders<LlmRequestLog>.Filter.And(
                    filter,
                    Builders<LlmRequestLog>.Filter.Regex(x => x.RequestPurpose, 
                        new MongoDB.Bson.BsonRegularExpression($"^{System.Text.RegularExpressions.Regex.Escape(item.AppCallerCode)}"))
                );
            }

            var logs = await _db.LlmRequestLogs.Find(filter).ToListAsync();

            if (logs.Count == 0)
            {
                results[key] = null;
                continue;
            }

            var requestCount = logs.Count;
            var avgDurationMs = logs.Where(l => l.DurationMs.HasValue).Select(l => l.DurationMs!.Value).DefaultIfEmpty(0).Average();
            var avgTtfbMs = logs.Where(l => l.FirstByteAt.HasValue)
                .Select(l => (l.FirstByteAt!.Value - l.StartedAt).TotalMilliseconds)
                .DefaultIfEmpty(0).Average();
            var totalInputTokens = logs.Sum(l => l.InputTokens ?? 0);
            var totalOutputTokens = logs.Sum(l => l.OutputTokens ?? 0);
            var successCount = logs.Count(l => l.Status == "succeeded");
            var failCount = logs.Count(l => l.Status == "failed");

            results[key] = new
            {
                requestCount,
                avgDurationMs = avgDurationMs > 0 ? (int)Math.Round(avgDurationMs) : (int?)null,
                avgTtfbMs = avgTtfbMs > 0 ? (int)Math.Round(avgTtfbMs) : (int?)null,
                totalInputTokens = totalInputTokens > 0 ? totalInputTokens : (long?)null,
                totalOutputTokens = totalOutputTokens > 0 ? totalOutputTokens : (long?)null,
                successCount = successCount > 0 ? successCount : (int?)null,
                failCount = failCount > 0 ? failCount : (int?)null,
            };
        }

        return Ok(ApiResponse<object>.Ok(new { days, items = results }));
    }
}

public class BatchModelStatsRequest
{
    public int Days { get; set; } = 7;
    public List<BatchModelStatsItem>? Items { get; set; }
}

public class BatchModelStatsItem
{
    public string? AppCallerCode { get; set; }
    public string PlatformId { get; set; } = string.Empty;
    public string ModelId { get; set; } = string.Empty;
}

