using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - LLM 请求日志
/// </summary>
[ApiController]
[Route("api/v1/admin/llm-logs")]
[Authorize(Roles = "ADMIN")]
public class AdminLlmLogsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AdminLlmLogsController(MongoDbContext db)
    {
        _db = db;
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
        // 下拉枚举：为了稳定性，status 使用固定枚举；provider/model 使用 distinct
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

        var statuses = new[] { "running", "succeeded", "failed", "cancelled" };

        return Ok(ApiResponse<object>.Ok(new { providers, models, statuses }));
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
        [FromQuery] string? status = null)
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
        if (!string.IsNullOrWhiteSpace(status)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Status, status);

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
                x.GroupId,
                x.SessionId,
                x.ViewRole,
                x.RequestType,
                x.RequestPurpose,
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
            x.GroupId,
            x.SessionId,
            x.ViewRole,
            x.RequestType,
            x.RequestPurpose,
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
    /// 按模型聚合的近 N 天统计（用于模型管理页展示“请求次数/平均耗时/首字延迟/token”等）
    /// 说明：LLMRequestLogs 默认 TTL 为 7 天，因此该接口也主要用于近 7 天。
    /// </summary>
    [HttpGet("model-stats")]
    public async Task<IActionResult> ModelStats(
        [FromQuery] int days = 7,
        [FromQuery] string? provider = null,
        [FromQuery] string? model = null,
        [FromQuery] string? status = null)
    {
        days = Math.Clamp(days, 1, 30);
        var from = DateTime.UtcNow.AddDays(-days);

        var filter = Builders<LlmRequestLog>.Filter.Gte(x => x.StartedAt, from);
        if (!string.IsNullOrWhiteSpace(provider)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Provider, provider);
        if (!string.IsNullOrWhiteSpace(model)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Model, model);
        if (!string.IsNullOrWhiteSpace(status)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Status, status);

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
                { "durationMs", "$DurationMs" },
                { "inputTokens", "$InputTokens" },
                { "outputTokens", "$OutputTokens" },
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
                { "_id", new BsonDocument { { "provider", "$provider" }, { "model", "$model" } } },
                { "requestCount", new BsonDocument("$sum", 1) },
                { "avgDurationMs", new BsonDocument("$avg", "$durationMs") },
                { "avgTtfbMs", new BsonDocument("$avg", "$ttfbMs") },
                { "totalInputTokens", new BsonDocument("$sum", new BsonDocument("$ifNull", new BsonArray { "$inputTokens", 0 })) },
                { "totalOutputTokens", new BsonDocument("$sum", new BsonDocument("$ifNull", new BsonArray { "$outputTokens", 0 })) },
            }),
            new BsonDocument("$project", new BsonDocument
            {
                { "_id", 0 },
                { "provider", "$_id.provider" },
                { "model", "$_id.model" },
                { "requestCount", 1 },
                // round to int for UI friendliness
                { "avgDurationMs", new BsonDocument("$round", new BsonArray { "$avgDurationMs", 0 }) },
                { "avgTtfbMs", new BsonDocument("$round", new BsonArray { "$avgTtfbMs", 0 }) },
                { "totalInputTokens", 1 },
                { "totalOutputTokens", 1 },
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
            d.TryGetValue("requestCount", out var rc);
            d.TryGetValue("avgDurationMs", out var avgDur);
            d.TryGetValue("avgTtfbMs", out var avgTtfb);
            d.TryGetValue("totalInputTokens", out var tin);
            d.TryGetValue("totalOutputTokens", out var tout);

            return new
            {
                provider = (ToDotNet(p) ?? string.Empty)?.ToString(),
                model = (ToDotNet(m) ?? string.Empty)?.ToString(),
                requestCount = ToDotNet(rc),
                avgDurationMs = ToDotNet(avgDur),
                avgTtfbMs = ToDotNet(avgTtfb),
                totalInputTokens = ToDotNet(tin),
                totalOutputTokens = ToDotNet(tout),
            };
        }).ToList();

        // 返回 object：与现有 List/Meta 保持一致
        return Ok(ApiResponse<object>.Ok(new { days, items = safeItems }));
    }
}

