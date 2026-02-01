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
                x.AnswerText
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
    /// 生成可重放的 curl 命令（用于 Vision API 多图请求）
    /// 通过 SHA256 从 COS 获取图片数据，构建完整请求
    /// </summary>
    [HttpGet("{id}/replay-curl")]
    public async Task<IActionResult> ReplayCurl(string id)
    {
        var log = await _db.LlmRequestLogs.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (log == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "日志不存在"));

        // 只支持 vision-multi-image 类型
        if (log.RequestType != "visionImageGen")
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_TYPE", "仅支持 Vision API 多图请求的 curl 重放"));
        }

        try
        {
            // 解析存储的请求体
            if (string.IsNullOrWhiteSpace(log.RequestBodyRedacted))
            {
                return BadRequest(ApiResponse<object>.Fail("NO_REQUEST_BODY", "请求体为空"));
            }

            using var doc = JsonDocument.Parse(log.RequestBodyRedacted);
            var root = doc.RootElement;

            if (!root.TryGetProperty("model", out var modelEl))
            {
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "请求体缺少 model 字段"));
            }
            var model = modelEl.GetString() ?? string.Empty;

            // 新格式：messages[].content[] (贴近真实 Vision API 格式)
            // 旧格式：image_refs[] + prompt (扁平格式，兼容历史日志)
            var contentItems = new List<object>();
            var imageErrors = new List<string>();
            string? prompt = null;

            if (root.TryGetProperty("messages", out var messagesEl) && messagesEl.ValueKind == JsonValueKind.Array)
            {
                // 新格式：从 messages[0].content[] 中提取
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
                            // 从 image_url.sha256 获取 SHA256，重新加载图片
                            if (!imgUrlEl.TryGetProperty("sha256", out var sha256El))
                            {
                                imageErrors.Add("图片缺少 sha256");
                                continue;
                            }

                            var sha256 = sha256El.GetString()?.Trim().ToLowerInvariant();
                            if (string.IsNullOrWhiteSpace(sha256) || sha256.Length != 64)
                            {
                                imageErrors.Add($"无效的 sha256: {sha256}");
                                continue;
                            }

                            // 从 COS 加载图片
                            var found = await _assetStorage.TryReadByShaAsync(
                                sha256,
                                HttpContext.RequestAborted,
                                domain: AppDomainPaths.DomainVisualAgent,
                                type: AppDomainPaths.TypeImg);

                            if (found == null)
                            {
                                imageErrors.Add($"无法从 COS 加载图片: {sha256}");
                                continue;
                            }

                            var base64 = Convert.ToBase64String(found.Value.bytes);
                            var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? "image/png" : found.Value.mime;
                            var dataUrl = $"data:{mime};base64,{base64}";

                            contentItems.Add(new
                            {
                                type = "image_url",
                                image_url = new { url = dataUrl }
                            });
                        }
                    }
                }
            }
            else if (root.TryGetProperty("image_refs", out var imageRefsEl) && root.TryGetProperty("prompt", out var promptEl))
            {
                // 旧格式：兼容历史日志
                prompt = promptEl.GetString() ?? string.Empty;
                contentItems.Add(new { type = "text", text = prompt });

                foreach (var imgRef in imageRefsEl.EnumerateArray())
                {
                    if (!imgRef.TryGetProperty("sha256", out var sha256El))
                    {
                        imageErrors.Add("缺少 sha256");
                        continue;
                    }

                    var sha256 = sha256El.GetString()?.Trim().ToLowerInvariant();
                    if (string.IsNullOrWhiteSpace(sha256) || sha256.Length != 64)
                    {
                        imageErrors.Add($"无效的 sha256: {sha256}");
                        continue;
                    }

                    var mime = "image/png";
                    if (imgRef.TryGetProperty("mime", out var mimeEl))
                    {
                        mime = mimeEl.GetString() ?? "image/png";
                    }

                    var found = await _assetStorage.TryReadByShaAsync(
                        sha256,
                        HttpContext.RequestAborted,
                        domain: AppDomainPaths.DomainVisualAgent,
                        type: AppDomainPaths.TypeImg);

                    if (found == null)
                    {
                        imageErrors.Add($"无法从 COS 加载图片: {sha256}");
                        continue;
                    }

                    var base64 = Convert.ToBase64String(found.Value.bytes);
                    var dataUrl = $"data:{mime};base64,{base64}";

                    contentItems.Add(new
                    {
                        type = "image_url",
                        image_url = new { url = dataUrl }
                    });
                }
            }
            else
            {
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "请求体格式不符合 Vision API 格式"));
            }

            // 构建完整请求体
            var fullRequest = new
            {
                model = model,
                max_tokens = 4096,
                messages = new[]
                {
                    new
                    {
                        role = "user",
                        content = contentItems
                    }
                }
            };

            var requestJson = JsonSerializer.Serialize(fullRequest, new JsonSerializerOptions
            {
                WriteIndented = false
            });

            // 构建 curl 命令
            var endpoint = $"{log.ApiBase?.TrimEnd('/')}/{log.Path?.TrimStart('/')}";
            var curlCommand = $"curl -X POST \"{endpoint}\" \\\n" +
                              $"  -H \"Content-Type: application/json\" \\\n" +
                              $"  -H \"Authorization: Bearer YOUR_API_KEY\" \\\n" +
                              $"  -d '{requestJson}'";

            return Ok(ApiResponse<object>.Ok(new
            {
                curl = curlCommand,
                endpoint = endpoint,
                model = model,
                imageCount = contentItems.Count - 1, // 减去 text 项
                imageErrors = imageErrors.Count > 0 ? imageErrors : null,
                requestBodyLength = requestJson.Length,
                warning = imageErrors.Count > 0 ? "部分图片加载失败，curl 可能不完整" : null
            }));
        }
        catch (JsonException ex)
        {
            return BadRequest(ApiResponse<object>.Fail("JSON_PARSE_ERROR", $"解析请求体失败: {ex.Message}"));
        }
    }

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

