using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
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

    private static IEnumerable<string> SplitSseLine(string line)
    {
        var raw = (line ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(raw)) yield break;

        // 兼容“一个字符串里拼了多个 data: ...”
        var parts = Regex.Split(raw, @"(?=data:\s)", RegexOptions.Compiled)
            .Select(x => x.Trim())
            .Where(x => !string.IsNullOrEmpty(x))
            .ToArray();

        if (parts.Length >= 2)
        {
            foreach (var p in parts) yield return p;
            yield break;
        }

        yield return raw;
    }

    private static string ExtractAnswerPreview(List<string>? rawSse)
    {
        if (rawSse == null || rawSse.Count == 0) return string.Empty;

        const int maxChars = 1800;
        var sb = new StringBuilder();

        foreach (var line in rawSse)
        {
            foreach (var seg in SplitSseLine(line))
            {
                if (!seg.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
                var payload = seg["data:".Length..].Trim();
                if (string.IsNullOrEmpty(payload) || payload == "[DONE]") continue;

                try
                {
                    using var doc = JsonDocument.Parse(payload);
                    var root = doc.RootElement;

                    // OpenAI: choices[0].delta.content
                    if (root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0)
                    {
                        var c0 = choices[0];
                        if (c0.ValueKind == JsonValueKind.Object && c0.TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object)
                        {
                            if (delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
                            {
                                var t = content.GetString();
                                if (!string.IsNullOrEmpty(t))
                                {
                                    sb.Append(t);
                                    if (sb.Length >= maxChars) return TruncatePreview(sb.ToString(), maxChars);
                                }
                                continue;
                            }
                        }
                    }

                    // Claude: content_block_delta.delta.text 或 delta.text
                    if (root.TryGetProperty("content_block_delta", out var cbd) && cbd.ValueKind == JsonValueKind.Object)
                    {
                        if (cbd.TryGetProperty("delta", out var cbdDelta) && cbdDelta.ValueKind == JsonValueKind.Object)
                        {
                            if (cbdDelta.TryGetProperty("text", out var cbdText) && cbdText.ValueKind == JsonValueKind.String)
                            {
                                var t = cbdText.GetString();
                                if (!string.IsNullOrEmpty(t))
                                {
                                    sb.Append(t);
                                    if (sb.Length >= maxChars) return TruncatePreview(sb.ToString(), maxChars);
                                }
                                continue;
                            }
                        }
                    }
                    if (root.TryGetProperty("delta", out var delta2) && delta2.ValueKind == JsonValueKind.Object)
                    {
                        if (delta2.TryGetProperty("text", out var dt) && dt.ValueKind == JsonValueKind.String)
                        {
                            var t = dt.GetString();
                            if (!string.IsNullOrEmpty(t))
                            {
                                sb.Append(t);
                                if (sb.Length >= maxChars) return TruncatePreview(sb.ToString(), maxChars);
                            }
                            continue;
                        }
                    }

                    // 兜底：自定义 SSE {content:"..."}
                    if (root.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String)
                    {
                        var t = c.GetString();
                        if (!string.IsNullOrEmpty(t))
                        {
                            sb.Append(t);
                            if (sb.Length >= maxChars) return TruncatePreview(sb.ToString(), maxChars);
                        }
                    }
                }
                catch
                {
                    // ignore bad json
                }
            }
        }

        return sb.ToString().Trim();
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

                // 用于列表中的“问题/回答”预览（仅用于 UI 展示；不作为 PRD 正文落盘）
                x.RequestBodyRedacted,
                x.RawSse
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

            questionPreview = ExtractQuestionPreview(x.RequestBodyRedacted),
            answerPreview = ExtractAnswerPreview(x.RawSse)
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
}

