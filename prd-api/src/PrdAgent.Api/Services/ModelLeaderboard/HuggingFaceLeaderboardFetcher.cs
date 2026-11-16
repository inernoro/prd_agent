using System.Globalization;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ModelLeaderboard;

public interface IModelLeaderboardFetcher
{
    Task<ArenaLeaderboardFetcher.ParseResult> FetchAsync(string board, CancellationToken ct);
}

/// <summary>读取 Arena 官方数据集；分页完整后才发布，并按模型名关联同一天的分项。</summary>
public sealed class HuggingFaceLeaderboardFetcher(
    HttpClient http,
    Func<HuggingFaceLeaderboardFetcher.ResponseEvidence, Task>? audit = null,
    IModelLeaderboardFetcher? fallback = null) : IModelLeaderboardFetcher
{
    public const string Dataset = "lmarena-ai/leaderboard-dataset";
    public const string DatasetUrl = "https://huggingface.co/datasets/" + Dataset;
    private const int PageSize = 100;
    private const int MaximumRows = 50000;
    private const int MaximumResponseBytes = 2 * 1024 * 1024;

    private static readonly IReadOnlyDictionary<string, string> Configs = new Dictionary<string, string>
    {
        ["agent"] = "agent", ["code"] = "webdev", ["text"] = "text_style_control",
        ["vision"] = "vision_style_control", ["search"] = "search_style_control",
        ["document"] = "document_style_control", ["text-to-image"] = "text_to_image",
        ["image-edit"] = "image_edit", ["text-to-video"] = "text_to_video",
        ["image-to-video"] = "image_to_video", ["video-edit"] = "video_edit",
    };

    public sealed record ResponseEvidence(string Url, DateTime StartedAt, DateTime EndedAt,
        int? StatusCode, string? ContentType, long Bytes, string? Sha256, string Outcome,
        string? ErrorType, string Summary, string AuditId);

    public sealed class AuditException(Exception inner) : Exception("榜单响应审计未能保存，本次不发布新快照。", inner) { }

    private sealed class ValidationException(string message, string diagnostic) : InvalidOperationException(message)
    {
        public string Diagnostic { get; } = diagnostic;
    }

    private sealed class CaptureContext
    {
        public string Config { get; set; } = "";
        public ConcurrentDictionary<string, ResponseEvidence> Responses { get; } = new();
    }

    public static string BuildUrl(string config, int offset) =>
        $"https://datasets-server.huggingface.co/rows?dataset={Uri.EscapeDataString(Dataset)}" +
        $"&config={Uri.EscapeDataString(config)}&split=latest&offset={offset}&length={PageSize}";

    public async Task<ArenaLeaderboardFetcher.ParseResult> FetchAsync(string board, CancellationToken ct)
    {
        try { return await FetchOfficialAsync(board, ct); }
        catch (Exception ex) when (fallback is not null && !ct.IsCancellationRequested
            && ex is HttpRequestException or TimeoutException or TaskCanceledException)
        {
            return await fallback.FetchAsync(board, ct);
        }
    }

    private async Task<ArenaLeaderboardFetcher.ParseResult> FetchOfficialAsync(string board, CancellationToken ct)
    {
        var context = new CaptureContext();
        try
        {
            var result = await AssembleAsync(board, context, ct);
            await CompleteAuditAsync(context, null);
            return result;
        }
        catch (AuditException) { throw; }
        catch (Exception ex)
        {
            await CompleteAuditAsync(context, ex);
            throw;
        }
    }

    private async Task<ArenaLeaderboardFetcher.ParseResult> AssembleAsync(string board, CaptureContext context, CancellationToken ct)
    {
        if (!Configs.TryGetValue(board, out var config))
            throw new ArgumentException("未知榜单。", nameof(board));
        var rows = await ReadRowsAsync(config, context, ct);
        var date = PublishedAt(rows);
        var entries = new List<ModelLeaderboardEntry>();
        foreach (var row in rows)
        {
            var entry = new ModelLeaderboardEntry
            {
                Name = Text(row, "model_name"), Rank = checked((int)Integer(row, "rank")),
                Organization = OptionalText(row, "organization"), License = OptionalText(row, "license"),
            };
            if (entry.Rank < 1) throw new InvalidOperationException("官方数据集名次无效。");
            if (board == "agent")
            {
                entry.NetImprovement = Metric(row);
                entry.Sessions = Integer(row, "session_count");
                entry.CostPerTask = OptionalNumber(row, "cost_per_task_p50");
                if (OptionalNumber(row, "output_tokens_per_task_p50") is { } tokens)
                    entry.OutputTokens = (tokens / 1000).ToString("0.#", CultureInfo.InvariantCulture) + "K";
            }
            else
            {
                entry.Score = Number(row, "rating");
                var lower = Number(row, "rating_lower");
                var upper = Number(row, "rating_upper");
                if (lower > entry.Score || upper < entry.Score)
                    throw new InvalidOperationException("官方数据集分数置信区间无效。");
                entry.ScoreMarginDown = entry.Score - lower;
                entry.ScoreMarginUp = upper - entry.Score;
                entry.Votes = Integer(row, "vote_count");
            }
            entries.Add(entry);
        }

        if (board == "agent")
        {
            var signals = new (string Config, Action<ModelLeaderboardEntry, ModelLeaderboardMetric> Set)[]
            {
                ("agent_task_outcome_explicit", (e, m) => e.ConfirmedSuccess = m),
                ("agent_praise_complaint", (e, m) => e.PraiseVsComplaint = m),
                ("agent_steerability", (e, m) => e.Steerability = m),
                ("agent_bash_reliability", (e, m) => e.BashReliability = m),
                // 官方 IPS 分数以改善为正；网页向下表示幻觉减少，沿用产品的有符号显示。
                ("agent_tool_hallucination", (e, m) => e.ToolHallucination = new() { Value = -m.Value, Margin = m.Margin }),
            };
            foreach (var signal in signals)
            {
                var signalRows = await ReadRowsAsync(signal.Config, context, ct);
                if (PublishedAt(signalRows) != date)
                    throw new ValidationException("官方榜单与分项发布日期不同，本次保留旧快照。",
                        JsonSerializer.Serialize(new { kind = "publication_mismatch", aggregateDate = date, signalDate = PublishedAt(signalRows) }));
                var byName = signalRows.ToDictionary(r => Text(r, "model_name"), StringComparer.Ordinal);
                foreach (var entry in entries)
                {
                    if (!byName.TryGetValue(entry.Name, out var signalRow))
                        throw new ValidationException("官方榜单缺少模型分项，本次保留旧快照。",
                            JsonSerializer.Serialize(new { kind = "missing_model_association", model = SafeError(entry.Name) }));
                    signal.Set(entry, Metric(signalRow));
                }
            }
        }

        var result = new ArenaLeaderboardFetcher.ParseResult(
            board == "agent" ? BoardKind.Agent : BoardKind.Score,
            entries.OrderBy(e => e.Rank).ToList(), null, null, SourceUrl: DatasetUrl + "/viewer/" + config + "/latest", PublishedAt: date);
        ArenaLeaderboardFetcher.EnsureUsable(DatasetUrl, board, result);
        return result;
    }

    private async Task<List<JsonElement>> ReadRowsAsync(string config, CaptureContext context, CancellationToken ct)
    {
        context.Config = config;
        var first = await ReadPageAsync(config, 0, null, context, ct);
        var all = first.Rows;
        // 每批最多四页，既避免 1 万多行的文本分类串行拖慢，也限制免费 API 的并发。
        for (var offset = PageSize; offset < first.Total; offset += PageSize * 4)
        {
            var offsets = Enumerable.Range(0, 4).Select(i => offset + i * PageSize).Where(i => i < first.Total);
            var pages = await Task.WhenAll(offsets.Select(i => ReadPageAsync(config, i, first.Total, context, ct)));
            foreach (var page in pages) all.AddRange(page.Rows);
        }
        if (all.Count != first.Total) throw new InvalidOperationException("官方数据集分页不完整。");
        var overall = all.Where(r => Text(r, "category") == "overall").ToList();
        // Agent 分项必须按唯一模型名关联。分数榜的公开名称可能相同：实抓 webdev 的
        // GPT-5.3-Codex (Codex Harness) 有两个不同分数/名次，不能擅自删掉其中一行。
        var identities = overall.Select(r => config.StartsWith("agent", StringComparison.Ordinal)
            ? Text(r, "model_name") : Text(r, "model_name") + "::" + Integer(r, "rank")).ToArray();
        if (identities.Distinct(StringComparer.Ordinal).Count() != overall.Count)
            throw new InvalidOperationException("官方数据集出现重复模型，本次保留旧快照。");
        return overall;
    }

    private async Task<(List<JsonElement> Rows, int Total)> ReadPageAsync(
        string config, int offset, int? expectedTotal, CaptureContext context, CancellationToken ct)
    {
        var url = BuildUrl(config, offset);
        var started = DateTime.UtcNow;
        HttpResponseMessage? response = null;
        using var buffer = new MemoryStream();
        string outcome = "failed", summary = "未收到响应。";
        string? errorType = null;
        string? failure = null;
        try
        {
            response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            summary = "已收到响应，正文尚未完整读取。";
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var chunk = new byte[8192];
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                if (buffer.Length + read > MaximumResponseBytes)
                    throw new InvalidOperationException("官方数据集单页超过读取上限。");
                buffer.Write(chunk, 0, read);
            }
            summary = Summarize(buffer.ToArray());
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(buffer.ToArray());
            var root = document.RootElement;
            if (root.GetProperty("partial").GetBoolean())
                throw new InvalidOperationException("官方数据集仅返回部分结果。");
            var total = root.GetProperty("num_rows_total").GetInt32();
            if (total < 1 || total > MaximumRows || expectedTotal.HasValue && total != expectedTotal.Value)
                throw new InvalidOperationException("官方数据集分页总数无效或抓取期间发生变化。");
            var rows = root.GetProperty("rows").EnumerateArray().ToArray();
            if (rows.Length != Math.Min(PageSize, total - offset))
                throw new InvalidOperationException("官方数据集分页缺行。");
            var result = new List<JsonElement>();
            for (var i = 0; i < rows.Length; i++)
            {
                if (rows[i].GetProperty("row_idx").GetInt32() != offset + i
                    || rows[i].GetProperty("truncated_cells").GetArrayLength() != 0)
                    throw new InvalidOperationException("官方数据集分页错位或字段被截断。");
                result.Add(rows[i].GetProperty("row").Clone());
            }
            outcome = "received";
            return (result, total);
        }
        catch (Exception ex)
        {
            errorType = ex.GetType().Name;
            failure = SafeError(ex.Message);
            if (ex is JsonException or KeyNotFoundException or FormatException or OverflowException)
                throw new InvalidOperationException("官方数据集响应格式无效，本次保留旧快照。", ex);
            throw;
        }
        finally
        {
            try
            {
                var evidence = new ResponseEvidence(url, started, DateTime.UtcNow, (int?)response?.StatusCode,
                    response?.Content.Headers.ContentType?.MediaType, buffer.Length,
                    buffer.Length == 0 ? null : Convert.ToHexString(SHA256.HashData(buffer.ToArray())),
                    outcome, errorType, failure is null ? summary : JsonSerializer.Serialize(new { response = summary, localFailure = failure }),
                    Guid.NewGuid().ToString("N"));
                context.Responses[evidence.AuditId] = evidence;
                await EmitAsync(evidence);
            }
            finally { response?.Dispose(); }
        }
    }

    private async Task EmitAsync(ResponseEvidence evidence)
    {
        if (audit is null) return;
        try { await audit(evidence); }
        catch (Exception ex) { throw new AuditException(ex); }
    }

    private async Task CompleteAuditAsync(CaptureContext context, Exception? error)
    {
        foreach (var evidence in context.Responses.Values.Where(e => e.Outcome == "received"))
        {
            var completed = evidence with
            {
                Outcome = error is null ? "success" : "semantic_failed",
                ErrorType = error?.GetType().Name,
                Summary = JsonSerializer.Serialize(new
                {
                    response = evidence.Summary, validation = error is null ? "accepted" : "rejected",
                    validatedAt = DateTime.UtcNow, config = context.Config,
                    reason = error is null ? null : SafeError(error.Message),
                    fieldDiagnostic = (error as ValidationException)?.Diagnostic,
                }),
            };
            await EmitAsync(completed);
        }
    }

    // 只保存公开数据的有限白名单，响应中的额外字段（包括凭据）不会进入审计。
    private static string Summarize(byte[] body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            return JsonSerializer.Serialize(new
            {
                format = "json", total = root.TryGetProperty("num_rows_total", out var total) ? total.Clone() : (JsonElement?)null,
                partial = root.TryGetProperty("partial", out var partial) ? partial.Clone() : (JsonElement?)null,
                fields = root.TryGetProperty("features", out var features)
                    ? features.EnumerateArray().Take(30).Select(f => f.GetProperty("name").GetString())
                        .Select(name => name?[..Math.Min(name.Length, 80)]).ToArray() : null,
                hasError = root.TryGetProperty("error", out _),
                publishedDates = root.TryGetProperty("rows", out var datedRows)
                    ? datedRows.EnumerateArray().Select(item => DateEvidence(item.GetProperty("row"))).Distinct().Take(5).ToArray() : null,
                error = root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String
                    ? SafeError(error.GetString()!) : null,
                // 仅公开榜单的数值与发布日期，能复核值和单位；忽略额外字段及任意正文。
                sampleRows = root.TryGetProperty("rows", out var rows)
                    ? rows.EnumerateArray().Take(3).Select(item => item.GetProperty("row").EnumerateObject()
                        .Where(p => new[] { "rank", "score", "score_ci_lower", "score_ci_upper", "rating",
                            "rating_lower", "rating_upper", "vote_count", "session_count" }.Contains(p.Name)
                            && p.Value.ValueKind == JsonValueKind.Number)
                        .ToDictionary(p => p.Name, p => p.Value.Clone())).ToArray() : null,
            });
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        { return "响应无法按榜单 JSON 结构读取；正文已省略。"; }
    }

    private static string SafeError(string error)
    {
        error = error[..Math.Min(error.Length, 8192)];
        var safe = Regex.Replace(error, @"(?i)(bearer\s+|(?:token|key|secret|password|cookie)\s*[:=]\s*)\S+", "$1[redacted]");
        safe = Regex.Replace(safe, @"\b(?:hf_|ghp_|sk-)[A-Za-z0-9_-]+", "[redacted]");
        return safe[..Math.Min(safe.Length, 512)];
    }

    private static string DateEvidence(JsonElement row)
    {
        if (!row.TryGetProperty("leaderboard_publish_date", out var value)) return "[missing]";
        if (value.ValueKind != JsonValueKind.String) return "[" + value.ValueKind + "]";
        var text = value.GetString()!;
        return DateTime.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
            ? text : $"[invalid_date:length={text.Length}]";
    }

    private static DateTime PublishedAt(List<JsonElement> rows)
    {
        var dates = rows.Select(r => Text(r, "leaderboard_publish_date")).Distinct().ToArray();
        if (dates.Length != 1 || !DateTime.TryParseExact(dates[0], "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date)
            || date > DateTime.UtcNow.Date)
            throw new ValidationException("官方数据集发布日期缺失、不一致或在未来。",
                JsonSerializer.Serialize(new { kind = "invalid_publication", dates = rows.Select(DateEvidence).Distinct().Take(5) }));
        return date;
    }

    private static ModelLeaderboardMetric Metric(JsonElement row)
    {
        var value = Number(row, "score");
        var lower = Number(row, "score_ci_lower");
        var upper = Number(row, "score_ci_upper");
        if (lower > value || upper < value) throw new ValidationException("官方数据集指标区间无效。",
            JsonSerializer.Serialize(new { kind = "invalid_interval", field = "score", value, lower, upper }));
        return new() { Value = value * 100, Margin = (upper - lower) * 50 };
    }

    private static string Text(JsonElement row, string field) =>
        row.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(value.GetString()) ? value.GetString()!
        : throw FieldFailure(row, field, "invalid_text");

    private static double Number(JsonElement row, string field) =>
        row.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
        && value.TryGetDouble(out var number) && double.IsFinite(number)
            ? number : throw FieldFailure(row, field, "invalid_number");

    private static double? OptionalNumber(JsonElement row, string field) =>
        !row.TryGetProperty(field, out var value) || value.ValueKind == JsonValueKind.Null ? null : Number(row, field);

    private static string? OptionalText(JsonElement row, string field) =>
        !row.TryGetProperty(field, out var value) || value.ValueKind == JsonValueKind.Null
        || value.ValueKind == JsonValueKind.String && string.IsNullOrWhiteSpace(value.GetString()) ? null : Text(row, field);

    private static long Integer(JsonElement row, string field)
    {
        var number = Number(row, field);
        if (number < 0 || number >= long.MaxValue || number != Math.Truncate(number))
            throw FieldFailure(row, field, "invalid_nonnegative_integer");
        return (long)number;
    }

    private static ValidationException FieldFailure(JsonElement row, string field, string constraint)
    {
        var exists = row.TryGetProperty(field, out var value);
        var text = exists && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        var state = !exists ? "missing" : value.ValueKind == JsonValueKind.Null ? "null"
            : text is { Length: 0 } ? "empty" : text is not null && string.IsNullOrWhiteSpace(text) ? "whitespace"
            : value.ValueKind != JsonValueKind.Number && constraint != "invalid_text" ? "type_mismatch" : constraint;
        var rawNumber = exists && value.ValueKind == JsonValueKind.Number ? value.GetRawText() : null;
        return new ValidationException($"官方数据集字段 {field} 校验失败。", JsonSerializer.Serialize(new
        {
            field, state, actualKind = exists ? value.ValueKind.ToString() : "missing", length = text?.Length,
            number = rawNumber?[..Math.Min(rawNumber.Length, 64)], publishedAt = DateEvidence(row),
        }));
    }
}
