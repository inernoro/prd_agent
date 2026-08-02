using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Logs;

/// <summary>
/// 任务诊断时间线：把一次业务任务（一个 RunId）在网关留下的全部上游调用按时间排成一条链。
///
/// 为什么单独成类而不是塞进 Program.cs：
///   - Program.cs 是 top-level 程序，里面的静态本地函数外部不可见，测试拿不到，等于没有守卫。
///   - 这里的两块判据（任务键怎么匹配、步骤怎么聚合）都是纯函数，抽出来后可以脱库直测，
///     红绿闭环能真的跑起来（.claude/rules/predicate-and-wiring-discipline.md 形状 4）。
///
/// 任务键（taskKey）同时匹配 RunId 与 LogicalRequestId：
///   视频分镜的 LogicalRequestId 是 "{runId}_scene_{idx}"，而 RunId 恒等于 runId。
///   用户手上可能是任意一个，两个字段都认才不会「同语义不同写法判据翻转」（形状 1）。
/// </summary>
public static class RunTimeline
{
    /// <summary>单条时间线返回的步骤上限：视频分镜轮询能刷出上千条，一次全端出去前端会被拖垮。</summary>
    public const int MaxSteps = 500;

    /// <summary>业务操作：一次逻辑请求本该只有一条，多出来的就是重试。</summary>
    private static readonly HashSet<string> BusinessOperations = new(StringComparer.Ordinal) { "invoke", "submit" };

    /// <summary>归一化任务键：去空白。空白/空串返回 null，调用方据此判 400。</summary>
    public static string? NormalizeTaskKey(string? raw)
    {
        var trimmed = raw?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    /// <summary>
    /// 任务键过滤器：RunId 或 LogicalRequestId 命中即算这条任务的一步。
    /// 注意本过滤器不带任何 operation 条件——时间线要的恰恰是 status/download 这些
    /// 被 view=logical 吃掉的步骤，谁想「只看业务请求」谁自己叠。
    /// </summary>
    public static FilterDefinition<BsonDocument> BuildTaskKeyFilter(string taskKey)
    {
        var key = NormalizeTaskKey(taskKey)
            ?? throw new ArgumentException("任务键不能为空", nameof(taskKey));
        var fb = Builders<BsonDocument>.Filter;
        return fb.Or(fb.Eq("RunId", key), fb.Eq("LogicalRequestId", key));
    }

    /// <summary>
    /// 时间线查询的完整过滤器（时间窗 + 任务键），是端点唯一的过滤器来源。
    /// 端点只在外层套 TenantAccess.FilterTeamScope 做租户/团队隔离，不再自己拼条件——
    /// 这样「有没有多加 operation 过滤把 status/download 吃掉」这件事可以被测试直接验证。
    /// </summary>
    public static FilterDefinition<BsonDocument> BuildQueryFilter(string taskKey, DateTime fromUtc, DateTime toUtc)
    {
        var fb = Builders<BsonDocument>.Filter;
        return fb.And(
            fb.Gte("StartedAt", fromUtc),
            fb.Lt("StartedAt", toUtc),
            BuildTaskKeyFilter(taskKey));
    }

    /// <summary>
    /// 把同一任务的日志条目聚合成时间线。入参不要求已排序，内部按 StartedAt 升序重排。
    /// </summary>
    public static RunTimelineData Build(string taskKey, IReadOnlyList<LlmLogListItem> items)
    {
        var key = NormalizeTaskKey(taskKey) ?? string.Empty;
        var ordered = items
            .Select(x => new { Item = x, Started = ParseUtc(x.StartedAt) })
            .OrderBy(x => x.Started ?? DateTime.MaxValue)
            .ThenBy(x => x.Item.Id, StringComparer.Ordinal)
            .ToList();

        var steps = new List<RunTimelineStep>(ordered.Count);
        DateTime? previousEnd = null;
        var order = 0;
        // 每个逻辑请求的业务尝试计数：第 2 次起算重试（视频多分镜各有独立 LogicalRequestId，不会误报）。
        var businessAttempts = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var entry in ordered)
        {
            var it = entry.Item;
            var started = entry.Started;
            var ended = ParseUtc(it.EndedAt) ?? (started is not null && it.DurationMs is not null
                ? started.Value.AddMilliseconds(it.DurationMs.Value)
                : null);
            var operation = string.IsNullOrWhiteSpace(it.Operation) ? "invoke" : it.Operation!.Trim().ToLowerInvariant();

            var isRetry = false;
            if (BusinessOperations.Contains(operation))
            {
                var logicalKey = string.IsNullOrWhiteSpace(it.LogicalRequestId) ? key : it.LogicalRequestId!.Trim();
                businessAttempts.TryGetValue(logicalKey, out var seen);
                businessAttempts[logicalKey] = seen + 1;
                isRetry = seen > 0;
            }

            long? gapMs = null;
            if (started is not null && previousEnd is not null)
            {
                var gap = (long)Math.Round((started.Value - previousEnd.Value).TotalMilliseconds);
                gapMs = gap > 0 ? gap : 0;
            }

            steps.Add(new RunTimelineStep
            {
                Order = ++order,
                LogId = it.Id,
                RequestId = it.RequestId,
                LogicalRequestId = it.LogicalRequestId,
                Operation = operation,
                RequestType = it.RequestType,
                StartedAt = it.StartedAt,
                EndedAt = ended.ToIsoOrNull(),
                DurationMs = it.DurationMs,
                GapMsFromPrevious = gapMs,
                Status = it.Status,
                StatusCode = it.StatusCode,
                Model = it.Model,
                Provider = it.PlatformName ?? it.Provider,
                Error = it.Error,
                IsRetry = isRetry,
            });

            if (ended is not null && (previousEnd is null || ended > previousEnd)) previousEnd = ended;
            else if (ended is null && started is not null && (previousEnd is null || started > previousEnd)) previousEnd = started;
        }

        var startTimes = ordered.Select(x => x.Started).Where(x => x is not null).Select(x => x!.Value).ToList();
        var endTimes = steps.Select(s => ParseUtc(s.EndedAt) ?? ParseUtc(s.StartedAt))
            .Where(x => x is not null).Select(x => x!.Value).ToList();
        DateTime? first = startTimes.Count > 0 ? startTimes.Min() : null;
        DateTime? last = endTimes.Count > 0 ? endTimes.Max() : null;

        var operationCounts = steps
            .GroupBy(s => s.Operation, StringComparer.Ordinal)
            .OrderByDescending(g => g.Count())
            .ThenBy(g => g.Key, StringComparer.Ordinal)
            .Select(g => new RunTimelineOperationCount { Operation = g.Key, Count = g.Count() })
            .ToList();

        var failedSteps = steps.Where(IsFailed).ToList();
        var runningSteps = steps.Where(s => string.Equals(s.Status, "running", StringComparison.OrdinalIgnoreCase)).ToList();
        var lastStep = steps.Count > 0 ? steps[^1] : null;

        string status;
        if (steps.Count == 0) status = "empty";
        else if (runningSteps.Count > 0) status = "running";
        else if (lastStep is not null && IsFailed(lastStep)) status = "failed";
        else if (failedSteps.Count > 0) status = "recovered";
        else status = "succeeded";

        // 卡点：整条链没有干净跑完时，指向最后一步——客服要的「卡在哪一步」就是它。
        var stuckStep = status is "running" or "failed"
            ? (runningSteps.Count > 0 ? runningSteps[^1] : lastStep)
            : null;

        return new RunTimelineData
        {
            TaskKey = key,
            Status = status,
            StepCount = steps.Count,
            StartedAt = first.ToIsoOrNull(),
            EndedAt = last.ToIsoOrNull(),
            TotalDurationMs = first is not null && last is not null && last >= first
                ? (long)Math.Round((last.Value - first.Value).TotalMilliseconds)
                : null,
            UpstreamDurationMs = steps.Sum(s => s.DurationMs ?? 0),
            RetryCount = steps.Count(s => s.IsRetry),
            FailedStepCount = failedSteps.Count,
            OperationCounts = operationCounts,
            Models = steps.Select(s => s.Model).Where(m => !string.IsNullOrWhiteSpace(m))
                .Select(m => m!).Distinct(StringComparer.Ordinal).OrderBy(m => m, StringComparer.Ordinal).ToList(),
            AppCallerCode = ordered.Select(x => x.Item.AppCallerCode).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)),
            SessionId = ordered.Select(x => x.Item.SessionId).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)),
            StuckStepOrder = stuckStep?.Order,
            StuckStepOperation = stuckStep?.Operation,
            FirstError = failedSteps.Select(s => s.Error).FirstOrDefault(e => !string.IsNullOrWhiteSpace(e)),
            Steps = steps,
        };
    }

    private static bool IsFailed(RunTimelineStep step)
        => string.Equals(step.Status, "failed", StringComparison.OrdinalIgnoreCase)
           || (step.StatusCode is int code && code >= 400);

    private static DateTime? ParseUtc(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return DateTime.TryParse(
            value,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal,
            out var parsed)
            ? DateTime.SpecifyKind(parsed, DateTimeKind.Utc)
            : null;
    }

    private static string? ToIsoOrNull(this DateTime? value)
        => value?.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);
}
