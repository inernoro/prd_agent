using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.LlmGw.Logs;
using PrdAgent.LlmGw.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 任务诊断时间线（GET /gw/logs/runs/{runId}）的守卫。
///
/// 三件容易在后续改动中静默失守的事，逐条钉死：
///   1. 任务键必须同时认 RunId 与 LogicalRequestId（判据别太窄——视频分镜的
///      LogicalRequestId 是 "{runId}_scene_{i}"，用户手上可能是任意一个）。
///   2. 查询过滤器不许带任何 operation 条件——status / download 正是要看的步骤，
///      一旦被 view=logical 的业务过滤吃掉，时间线就只剩提交那一条。
///   3. 重试计数按逻辑请求分组——多分镜各提交一次不是重试，同一逻辑请求提交两次才是。
///
/// 全部脱库：BuildQueryFilter 渲染成 BsonDocument 直接断言，Build 是纯函数。
/// </summary>
public sealed class RunTimelineTests
{
    private static BsonDocument Render(FilterDefinition<BsonDocument> filter)
        => filter.Render(new RenderArgs<BsonDocument>(
            BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(),
            BsonSerializer.SerializerRegistry));

    private static LlmLogListItem Step(
        string id,
        string operation,
        string startedAt,
        long durationMs,
        string status = "succeeded",
        string? logicalRequestId = null,
        int? statusCode = 200,
        string model = "video-model",
        string? error = null)
        => new()
        {
            Id = id,
            RequestId = id,
            Operation = operation,
            StartedAt = startedAt,
            EndedAt = DateTime.Parse(startedAt, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal)
                .AddMilliseconds(durationMs)
                .ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
            DurationMs = durationMs,
            Status = status,
            StatusCode = statusCode,
            Model = model,
            Provider = "openrouter",
            LogicalRequestId = logicalRequestId,
            Error = error,
        };

    // ── 判据宽度：任务键两个字段都要认 ──

    [Fact]
    public void TaskKeyFilter_MatchesBothRunIdAndLogicalRequestId()
    {
        var rendered = Render(RunTimeline.BuildTaskKeyFilter("run-1"));
        var clauses = rendered["$or"].AsBsonArray.Select(x => x.AsBsonDocument).ToList();

        Assert.Equal(2, clauses.Count);
        Assert.Contains(clauses, c => c.Contains("RunId") && c["RunId"].AsString == "run-1");
        Assert.Contains(clauses, c => c.Contains("LogicalRequestId") && c["LogicalRequestId"].AsString == "run-1");
    }

    [Fact]
    public void TaskKeyFilter_TrimsSurroundingWhitespaceSoPastedIdsStillMatch()
    {
        var rendered = Render(RunTimeline.BuildTaskKeyFilter("  run-1\n"));
        var clauses = rendered["$or"].AsBsonArray.Select(x => x.AsBsonDocument).ToList();

        Assert.All(clauses, c => Assert.Equal("run-1", c.Values.First().AsString));
    }

    [Fact]
    public void NormalizeTaskKey_RejectsBlankSoEndpointCanAnswer400()
    {
        Assert.Null(RunTimeline.NormalizeTaskKey(null));
        Assert.Null(RunTimeline.NormalizeTaskKey("   "));
        Assert.Equal("run-1", RunTimeline.NormalizeTaskKey(" run-1 "));
    }

    // ── 过滤器不许吃掉轮询与下载步骤 ──

    [Fact]
    public void QueryFilter_CarriesTimeWindowAndTaskKeyOnlyWithoutOperationNarrowing()
    {
        var from = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var to = new DateTime(2026, 4, 1, 0, 0, 0, DateTimeKind.Utc);
        var rendered = Render(RunTimeline.BuildQueryFilter("run-1", from, to));

        // 驱动会把 $and 的同名条件压平，所以直接看压平后的文档。
        var startedAt = rendered["StartedAt"].AsBsonDocument;
        Assert.Equal(from, startedAt["$gte"].ToUniversalTime());
        Assert.Equal(to, startedAt["$lt"].ToUniversalTime());
        Assert.Equal(2, rendered["$or"].AsBsonArray.Count);

        // 整棵过滤树里不许出现 Operation / IsHealthProbe / HttpMethod 这类会砍掉
        // status(状态查询) / download(结果下载) 步骤的条件。
        var json = rendered.ToJson();
        Assert.DoesNotContain("Operation", json);
        Assert.DoesNotContain("IsHealthProbe", json);
        Assert.DoesNotContain("HttpMethod", json);
    }

    [Fact]
    public void Build_KeepsPollingAndDownloadStepsInOrderWithCounts()
    {
        // 故意乱序传入，验证内部按 StartedAt 升序重排。
        var items = new List<LlmLogListItem>
        {
            Step("s3", "download", "2026-03-01T10:00:40.000Z", 800),
            Step("s1", "submit", "2026-03-01T10:00:00.000Z", 1200),
            Step("s2", "status", "2026-03-01T10:00:20.000Z", 300),
        };

        var timeline = RunTimeline.Build("run-1", items);

        Assert.Equal(new[] { "submit", "status", "download" }, timeline.Steps.Select(s => s.Operation).ToArray());
        Assert.Equal(new[] { 1, 2, 3 }, timeline.Steps.Select(s => s.Order).ToArray());
        Assert.Equal(3, timeline.StepCount);
        Assert.Contains(timeline.OperationCounts, c => c.Operation == "status" && c.Count == 1);
        Assert.Contains(timeline.OperationCounts, c => c.Operation == "download" && c.Count == 1);
        Assert.Equal("succeeded", timeline.Status);

        // 总耗时是墙钟跨度（首步开始到末步结束 = 40.8s），不是各步之和（2.3s）。
        Assert.Equal(40800, timeline.TotalDurationMs);
        Assert.Equal(2300, timeline.UpstreamDurationMs);

        // 空档 = 上一步结束到本步开始，把「轮询之间干等了多久」显出来。
        Assert.Null(timeline.Steps[0].GapMsFromPrevious);
        Assert.Equal(18800, timeline.Steps[1].GapMsFromPrevious);
        Assert.Equal(19700, timeline.Steps[2].GapMsFromPrevious);
    }

    // ── 重试计数按逻辑请求分组 ──

    [Fact]
    public void Build_CountsRepeatedSubmitOfSameLogicalRequestAsRetry()
    {
        var items = new List<LlmLogListItem>
        {
            Step("a1", "submit", "2026-03-01T10:00:00.000Z", 500, status: "failed", statusCode: 500, logicalRequestId: "run-1", error: "上游 500"),
            Step("a2", "submit", "2026-03-01T10:00:10.000Z", 500, logicalRequestId: "run-1"),
        };

        var timeline = RunTimeline.Build("run-1", items);

        Assert.False(timeline.Steps[0].IsRetry);
        Assert.True(timeline.Steps[1].IsRetry);
        Assert.Equal(1, timeline.RetryCount);
        Assert.Equal(1, timeline.FailedStepCount);
        Assert.Equal("上游 500", timeline.FirstError);
        // 末步成功 = 整体已恢复，不该报 failed 吓人，但失败痕迹仍在 FailedStepCount。
        Assert.Equal("recovered", timeline.Status);
    }

    [Fact]
    public void Build_DoesNotCountPerSceneSubmitsAsRetries()
    {
        // 视频多分镜：每个分镜一个 LogicalRequestId，各提交一次，不是重试。
        var items = new List<LlmLogListItem>
        {
            Step("b1", "submit", "2026-03-01T10:00:00.000Z", 500, logicalRequestId: "run-1_scene_0"),
            Step("b2", "submit", "2026-03-01T10:00:05.000Z", 500, logicalRequestId: "run-1_scene_1"),
            Step("b3", "submit", "2026-03-01T10:00:10.000Z", 500, logicalRequestId: "run-1_scene_2"),
        };

        var timeline = RunTimeline.Build("run-1", items);

        Assert.Equal(0, timeline.RetryCount);
        Assert.All(timeline.Steps, s => Assert.False(s.IsRetry));
    }

    [Fact]
    public void Build_DoesNotTreatPollingRepetitionAsRetry()
    {
        // 轮询天然重复几十次，那是等待不是重试，不该混进重试计数。
        var items = Enumerable.Range(0, 5)
            .Select(i => Step($"p{i}", "status", $"2026-03-01T10:0{i}:00.000Z", 200, logicalRequestId: "run-1"))
            .ToList();

        var timeline = RunTimeline.Build("run-1", items);

        Assert.Equal(0, timeline.RetryCount);
        Assert.Contains(timeline.OperationCounts, c => c.Operation == "status" && c.Count == 5);
    }

    // ── 卡点定位 ──

    [Fact]
    public void Build_PointsAtLastStepWhenTaskEndedInFailure()
    {
        var items = new List<LlmLogListItem>
        {
            Step("c1", "submit", "2026-03-01T10:00:00.000Z", 500, logicalRequestId: "run-1"),
            Step("c2", "status", "2026-03-01T10:00:10.000Z", 200, logicalRequestId: "run-1"),
            Step("c3", "status", "2026-03-01T10:00:20.000Z", 200, status: "failed", statusCode: 504, logicalRequestId: "run-1", error: "上游超时"),
        };

        var timeline = RunTimeline.Build("run-1", items);

        Assert.Equal("failed", timeline.Status);
        Assert.Equal(3, timeline.StuckStepOrder);
        Assert.Equal("status", timeline.StuckStepOperation);
        Assert.Equal("上游超时", timeline.FirstError);
    }

    [Fact]
    public void Build_PointsAtRunningStepWhileTaskStillInFlight()
    {
        var items = new List<LlmLogListItem>
        {
            Step("d1", "submit", "2026-03-01T10:00:00.000Z", 500, logicalRequestId: "run-1"),
            Step("d2", "status", "2026-03-01T10:00:10.000Z", 0, status: "running", statusCode: null, logicalRequestId: "run-1"),
        };

        var timeline = RunTimeline.Build("run-1", items);

        Assert.Equal("running", timeline.Status);
        Assert.Equal(2, timeline.StuckStepOrder);
    }

    [Fact]
    public void Build_TreatsHttpErrorCodeAsFailureEvenWhenStatusTextLooksFine()
    {
        // 判据别太窄：有的历史文档 Status 字段没落 failed，只有 4xx/5xx 状态码。
        var items = new List<LlmLogListItem>
        {
            Step("e1", "invoke", "2026-03-01T10:00:00.000Z", 500, status: "completed", statusCode: 429, logicalRequestId: "run-1"),
        };

        var timeline = RunTimeline.Build("run-1", items);

        Assert.Equal(1, timeline.FailedStepCount);
        Assert.Equal("failed", timeline.Status);
    }

    [Fact]
    public void Build_ReturnsEmptyShapeWhenNothingMatched()
    {
        var timeline = RunTimeline.Build("run-missing", new List<LlmLogListItem>());

        Assert.Equal("empty", timeline.Status);
        Assert.Equal(0, timeline.StepCount);
        Assert.Empty(timeline.Steps);
        Assert.Null(timeline.TotalDurationMs);
        Assert.Null(timeline.StuckStepOrder);
        Assert.Equal("run-missing", timeline.TaskKey);
    }
}
