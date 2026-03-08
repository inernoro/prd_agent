using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 工作流 Artifact → TeamCollectedStats 解析器（v2.0）。
/// 解析 FinalArtifacts 中的 JSON 数据，提取各数据源统计信息，并支持按成员身份拆分。
/// </summary>
public class ArtifactStatsParser
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true
    };

    /// <summary>
    /// 解析工作流产出的 Artifacts → 统一统计结构。
    /// 支持两种格式：
    /// 1. 数组格式 [{ source, summary, details }]（DataMerger 输出）
    /// 2. 单对象格式 { source, summary, details }
    /// </summary>
    public static TeamCollectedStats Parse(List<ExecutionArtifact> artifacts)
    {
        var stats = new TeamCollectedStats();

        foreach (var artifact in artifacts)
        {
            if (string.IsNullOrWhiteSpace(artifact.InlineContent))
                continue;

            // 只处理 JSON 类型的 artifact
            if (artifact.MimeType != null &&
                !artifact.MimeType.Contains("json", StringComparison.OrdinalIgnoreCase))
                continue;

            try
            {
                var rawEntries = ParseJsonEntries(artifact.InlineContent);
                foreach (var entry in rawEntries)
                {
                    var sourceStats = ConvertToSourceStats(entry);
                    if (sourceStats != null)
                        stats.Sources.Add(sourceStats);
                }
            }
            catch (JsonException)
            {
                // 无效 JSON，跳过
            }
        }

        return stats;
    }

    /// <summary>
    /// 按成员身份映射拆分团队统计 → 每个成员的个人统计。
    /// </summary>
    public static List<MemberCollectedStats> SplitByMember(
        TeamCollectedStats teamStats,
        List<ReportTeamMember> members)
    {
        var result = new List<MemberCollectedStats>();

        foreach (var member in members)
        {
            var memberStats = new MemberCollectedStats { UserId = member.UserId };

            foreach (var source in teamStats.Sources)
            {
                // 查找该成员在此平台上的身份标识
                if (!member.IdentityMappings.TryGetValue(source.SourceType, out var identity))
                    continue;

                // 过滤属于该成员的明细
                var memberDetails = source.Details
                    .Where(d => string.Equals(d.Assignee, identity, StringComparison.OrdinalIgnoreCase))
                    .ToList();

                if (memberDetails.Count == 0)
                    continue;

                // 基于明细重新计算 summary（按类型计数）
                var memberSummary = RecalculateSummary(source.Summary, source.Details, memberDetails);

                memberStats.Sources.Add(new SourceStats
                {
                    SourceType = source.SourceType,
                    CollectedAt = source.CollectedAt,
                    Summary = memberSummary,
                    Details = memberDetails
                });
            }

            result.Add(memberStats);
        }

        return result;
    }

    #region Private helpers

    private static List<JsonElement> ParseJsonEntries(string json)
    {
        var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        return root.ValueKind == JsonValueKind.Array
            ? root.EnumerateArray().ToList()
            : new List<JsonElement> { root };
    }

    private static SourceStats? ConvertToSourceStats(JsonElement entry)
    {
        if (entry.ValueKind != JsonValueKind.Object)
            return null;

        if (!entry.TryGetProperty("source", out var sourceProp))
            return null;

        var sourceType = sourceProp.GetString();
        if (string.IsNullOrEmpty(sourceType))
            return null;

        var stats = new SourceStats { SourceType = sourceType };

        // 解析 collectedAt
        if (entry.TryGetProperty("collectedAt", out var collectedAt) &&
            DateTime.TryParse(collectedAt.GetString(), out var dt))
        {
            stats.CollectedAt = dt;
        }

        // 解析 summary
        if (entry.TryGetProperty("summary", out var summary) && summary.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in summary.EnumerateObject())
            {
                if (prop.Value.TryGetInt32(out var intVal))
                    stats.Summary[prop.Name] = intVal;
            }
        }

        // 解析 details
        if (entry.TryGetProperty("details", out var details) && details.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in details.EnumerateArray())
            {
                var detail = new StatsDetail
                {
                    Id = item.TryGetProperty("id", out var id) ? id.GetString() : null,
                    Title = item.TryGetProperty("title", out var title) ? title.GetString() ?? "" : "",
                    Type = item.TryGetProperty("type", out var type) ? type.GetString() : null,
                    Status = item.TryGetProperty("status", out var status) ? status.GetString() : null,
                    Assignee = item.TryGetProperty("assignee", out var assignee) ? assignee.GetString() : null,
                };

                if (item.TryGetProperty("closedAt", out var closedAt) &&
                    DateTime.TryParse(closedAt.GetString(), out var closedDt))
                    detail.Timestamp = closedDt;
                else if (item.TryGetProperty("timestamp", out var ts) &&
                         DateTime.TryParse(ts.GetString(), out var tsDt))
                    detail.Timestamp = tsDt;

                stats.Details.Add(detail);
            }
        }

        return stats;
    }

    /// <summary>
    /// 基于成员的明细重新按比例计算 summary。
    /// 策略：按 detail 数量占总 detail 数量的比例来分配 summary 中的计数。
    /// </summary>
    private static Dictionary<string, int> RecalculateSummary(
        Dictionary<string, int> totalSummary,
        List<StatsDetail> totalDetails,
        List<StatsDetail> memberDetails)
    {
        if (totalDetails.Count == 0)
            return new Dictionary<string, int>(totalSummary);

        var ratio = (double)memberDetails.Count / totalDetails.Count;
        var result = new Dictionary<string, int>();

        foreach (var kv in totalSummary)
        {
            result[kv.Key] = (int)Math.Round(kv.Value * ratio);
        }

        return result;
    }

    #endregion
}
