using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// OpenDesign 事件（status / text_delta / thinking / done / error）→ MAP 执行器分片的唯一翻译处。
///
/// 经 CDS 会话与直连设计执行服务两条传输面收到的是同一种事件形状（map-design-executor-v1 第五节
/// 特意沿用了 CDS 会话事件），所以翻译只能有一份：抄两份的话，某天给一边加了阶段、另一边照旧，
/// 用户会在两条路径上看到两种说法（判据与接线纪律 形状 3；design.platform.design-runtime.md 第八节）。
/// 传输面各自保留的只有「怎么拿到事件」与「done 之后怎么收尾」。
/// </summary>
internal sealed class OpenDesignEventTranslator
{
    private const int MaxIssueCodes = 16;
    private const int MaxIssueCodeLength = 64;
    private const int MaxRepairAttempts = 1_000;
    private const int MaxBrowserQualityAttempts = 3;
    private const int MaxBrowserQualityIssuesPerAttempt = 16;
    private const int MaxMeasurementValues = 8;
    private const int MaxMeasurementValueLength = 120;
    private const int MaxTargetLength = 160;
    private const string BrowserQualityFailureSchema = "map-browser-quality-failure-evidence-v1";
    private static readonly HashSet<string> BrowserIssueCodes = new(StringComparer.Ordinal)
    {
        "horizontal_overflow",
        "main_content_clipped",
        "primary_cta_clipped",
        "empty_link",
        "broken_fragment_target",
        "mobile_navigation_unusable",
        "table_unreadable",
        "key_text_contrast_low",
    };
    private static readonly HashSet<string> BrowserMeasurementKeys = new(StringComparer.Ordinal)
    {
        "documentWidth", "viewportWidth", "present", "visible", "left", "right", "href",
        "linkCount", "visibleLinkCount", "hasVisibleToggle", "tableWidth", "scrollable",
        "minCellWidth", "ratio", "minimum", "fontSize", "fontWeight",
    };
    internal const string Status = "status";
    internal const string TextDelta = "text_delta";
    internal const string Thinking = "thinking";
    internal const string Done = "done";
    internal const string Error = "error";

    private readonly OpenDesignStageProgress _stageProgress;

    internal OpenDesignEventTranslator(bool editing, int startProgress)
    {
        _stageProgress = new OpenDesignStageProgress(editing, startProgress);
    }

    /// <summary>当前已写出的进度（只增不减），排队提示等非阶段事件沿用它。</summary>
    internal int Progress => _stageProgress.Progress;

    /// <summary>
    /// 把一条进度类事件翻成分片；done / error / 认不出的类型返回 null，由调用方按传输面收尾。
    /// </summary>
    internal DesignArtifactExecutorChunk? ToChunk(string type, string payloadJson)
    {
        switch (type)
        {
            case Status:
                var update = _stageProgress.Observe(
                    ReadPayloadString(payloadJson, "reason"),
                    ReadPayloadInt(payloadJson, "elapsedSeconds"),
                    ReadPayloadInt(payloadJson, "attempt"));
                return update == null
                    ? null
                    : new DesignArtifactExecutorChunk(
                        "phase",
                        update.Phase,
                        Progress: update.Progress,
                        PhaseCode: update.PhaseCode);
            case TextDelta:
            case Thinking:
                // 原始 text_delta 的来源在不同传输面不稳定，可能包含工具参数、
                // 工作区路径或模型隐式推理。普通用户流只认 status 白名单映射出的
                // 稳定阶段码和成果语言；这两类原始事件直接丢弃，也不记入管理员日志。
                return null;
            default:
                return null;
        }
    }

    /// <summary>远端 error 事件 → 交给用户的那条异常（文案由 <see cref="OpenDesignFailureMessage"/> 唯一渲染）。</summary>
    internal static InvalidOperationException RemoteFailure(string payloadJson) =>
        OpenDesignFailureMessage.Failure(
            OpenDesignFailureStage.RemoteRun,
            ReadPayloadString(payloadJson, "message"),
            ReadPayloadStableToken(payloadJson, "code"),
            ReadFailureDetails(payloadJson));

    internal static OpenDesignRemoteFailureDetails? ReadFailureDetails(string payloadJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(payloadJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("details", out var details)
                || details.ValueKind != JsonValueKind.Object)
                return null;

            var issueCodes = new List<string>();
            if (details.TryGetProperty("issueCodes", out var issueCodeValues)
                && issueCodeValues.ValueKind == JsonValueKind.Array)
            {
                foreach (var value in issueCodeValues.EnumerateArray())
                {
                    if (issueCodes.Count >= MaxIssueCodes) break;
                    if (value.ValueKind != JsonValueKind.String) continue;
                    var issueCode = value.GetString();
                    if (!IsStableToken(issueCode) || issueCodes.Contains(issueCode!, StringComparer.Ordinal)) continue;
                    issueCodes.Add(issueCode!);
                }
            }

            int? repairAttempts = null;
            if (details.TryGetProperty("repairAttempts", out var attemptsValue)
                && attemptsValue.ValueKind == JsonValueKind.Number
                && attemptsValue.TryGetInt32(out var attempts)
                && attempts is >= 0 and <= MaxRepairAttempts)
                repairAttempts = attempts;

            bool? repairBudgetExhausted = null;
            if (details.TryGetProperty("repairBudgetExhausted", out var budgetValue)
                && budgetValue.ValueKind is JsonValueKind.True or JsonValueKind.False)
                repairBudgetExhausted = budgetValue.GetBoolean();

            var browserQualityEvidence = details.TryGetProperty("browserQualityEvidence", out var evidenceValue)
                ? ReadBrowserQualityEvidence(evidenceValue)
                : null;

            return issueCodes.Count > 0 || repairAttempts.HasValue || repairBudgetExhausted.HasValue || browserQualityEvidence != null
                ? new OpenDesignRemoteFailureDetails(issueCodes, repairAttempts, repairBudgetExhausted, browserQualityEvidence)
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static DesignArtifactBrowserQualityFailureEvidence? ReadBrowserQualityEvidence(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object
            || ReadBoundedText(value, "schemaVersion", 80) != BrowserQualityFailureSchema
            || ReadVersionField(value, "ruleVersion") is not { } ruleVersion
            || ReadVersionField(value, "heuristicVersion") is not { } heuristicVersion
            || !TryReadSafeInt(value, "repairAttempts", MaxRepairAttempts, out var repairAttempts)
            || !value.TryGetProperty("repairBudgetExhausted", out var exhaustedValue)
            || exhaustedValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !value.TryGetProperty("attempts", out var attemptsValue)
            || attemptsValue.ValueKind != JsonValueKind.Array
            || attemptsValue.GetArrayLength() is < 1 or > MaxBrowserQualityAttempts)
            return null;

        var attempts = new List<DesignArtifactBrowserQualityFailureAttempt>();
        foreach (var attemptValue in attemptsValue.EnumerateArray())
        {
            var attempt = ReadBrowserQualityAttempt(attemptValue);
            if (attempt == null) return null;
            attempts.Add(attempt);
        }
        return new DesignArtifactBrowserQualityFailureEvidence
        {
            SchemaVersion = BrowserQualityFailureSchema,
            RuleVersion = ruleVersion,
            HeuristicVersion = heuristicVersion,
            RepairAttempts = repairAttempts,
            RepairBudgetExhausted = exhaustedValue.GetBoolean(),
            Attempts = attempts,
        };
    }

    private static DesignArtifactBrowserQualityFailureAttempt? ReadBrowserQualityAttempt(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object
            || !TryReadSafeInt(value, "repairAttempt", MaxRepairAttempts, out var repairAttempt)
            || !value.TryGetProperty("hardPassed", out var hardPassedValue)
            || hardPassedValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !value.TryGetProperty("score", out var scoreValue)
            || scoreValue.ValueKind != JsonValueKind.Number
            || !scoreValue.TryGetDouble(out var score)
            || !double.IsFinite(score)
            || score is < 0 or > 100
            || !value.TryGetProperty("issues", out var issuesValue)
            || issuesValue.ValueKind != JsonValueKind.Array
            || issuesValue.GetArrayLength() > MaxBrowserQualityIssuesPerAttempt)
            return null;

        var issues = new List<DesignArtifactBrowserQualityFailureIssue>();
        foreach (var issueValue in issuesValue.EnumerateArray())
        {
            var issue = ReadBrowserQualityIssue(issueValue);
            if (issue == null) return null;
            issues.Add(issue);
        }
        return new DesignArtifactBrowserQualityFailureAttempt
        {
            RepairAttempt = repairAttempt,
            HardPassed = hardPassedValue.GetBoolean(),
            Score = score,
            Issues = issues,
        };
    }

    private static DesignArtifactBrowserQualityFailureIssue? ReadBrowserQualityIssue(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return null;
        var viewport = ReadBoundedText(value, "viewport", 16);
        if (ReadStableField(value, "issueCode") is not { } issueCode
            || !BrowserIssueCodes.Contains(issueCode)
            || viewport is not ("desktop" or "mobile")
            || ReadBoundedText(value, "target", MaxTargetLength) is not { } target
            || !value.TryGetProperty("actual", out var actualValue)
            || actualValue.ValueKind != JsonValueKind.Object)
            return null;

        var actual = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var property in actualValue.EnumerateObject())
        {
            if (actual.Count >= MaxMeasurementValues
                || !BrowserMeasurementKeys.Contains(property.Name)
                || !TryReadMeasurementValue(property.Value, out var measurement))
                return null;
            actual[property.Name] = measurement;
        }
        var element = value.TryGetProperty("elementSummary", out var elementValue)
            ? ReadElementSummary(elementValue)
            : null;
        if (value.TryGetProperty("elementSummary", out _) && element == null) return null;
        return new DesignArtifactBrowserQualityFailureIssue
        {
            IssueCode = issueCode,
            Viewport = viewport,
            Actual = actual,
            Target = target,
            ElementSummary = element,
        };
    }

    private static DesignArtifactBrowserElementSummary? ReadElementSummary(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object || ReadBoundedText(value, "tag", 40) is not { } tag) return null;
        return new DesignArtifactBrowserElementSummary
        {
            Tag = tag,
            Id = ReadOptionalBoundedText(value, "id", 80),
            Role = ReadOptionalBoundedText(value, "role", 80),
            Label = ReadOptionalBoundedText(value, "label", 160),
        };
    }

    private static bool TryReadMeasurementValue(JsonElement value, out object? result)
    {
        result = value.ValueKind switch
        {
            JsonValueKind.String when value.GetString() is { Length: <= MaxMeasurementValueLength } text
                                      && !text.Any(char.IsControl) => text,
            JsonValueKind.Number when value.TryGetDouble(out var number) && double.IsFinite(number) => number,
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Null => null,
            _ => null,
        };
        return value.ValueKind == JsonValueKind.Null || result != null;
    }

    private static bool TryReadSafeInt(JsonElement value, string field, int max, out int result)
    {
        result = 0;
        return value.TryGetProperty(field, out var property)
               && property.ValueKind == JsonValueKind.Number
               && property.TryGetInt32(out result)
               && result is >= 0
               && result <= max;
    }

    private static string? ReadStableField(JsonElement value, string field)
    {
        var text = ReadBoundedText(value, field, MaxIssueCodeLength);
        return IsStableToken(text) ? text : null;
    }

    private static string? ReadVersionField(JsonElement value, string field)
    {
        var text = ReadBoundedText(value, field, MaxIssueCodeLength);
        return !string.IsNullOrEmpty(text)
               && text[0] is >= 'a' and <= 'z'
               && text.All(character => character is >= 'a' and <= 'z'
                                        || character is >= '0' and <= '9'
                                        || character is '-' or '_')
            ? text
            : null;
    }

    private static string? ReadBoundedText(JsonElement value, string field, int maxLength)
    {
        if (!value.TryGetProperty(field, out var property) || property.ValueKind != JsonValueKind.String) return null;
        var text = property.GetString();
        return !string.IsNullOrWhiteSpace(text) && text.Length <= maxLength && !text.Any(char.IsControl) ? text : null;
    }

    private static string? ReadOptionalBoundedText(JsonElement value, string field, int maxLength) =>
        value.TryGetProperty(field, out _) ? ReadBoundedText(value, field, maxLength) : null;

    internal static string? ReadPayloadStableToken(string payloadJson, string field)
    {
        var value = ReadPayloadString(payloadJson, field);
        return IsStableToken(value) ? value : null;
    }

    private static bool IsStableToken(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > MaxIssueCodeLength || value[0] is < 'a' or > 'z')
            return false;
        return value.All(character => character is >= 'a' and <= 'z'
                                      || character is >= '0' and <= '9'
                                      || character == '_');
    }

    internal static int? ReadPayloadInt(string payloadJson, string field)
    {
        try
        {
            using var doc = JsonDocument.Parse(payloadJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty(field, out var value)
                   && value.ValueKind == JsonValueKind.Number
                   && value.TryGetInt32(out var number)
                ? number
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static string? ReadPayloadString(string payloadJson, string field)
    {
        try
        {
            using var doc = JsonDocument.Parse(payloadJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty(field, out var value)
                   && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
