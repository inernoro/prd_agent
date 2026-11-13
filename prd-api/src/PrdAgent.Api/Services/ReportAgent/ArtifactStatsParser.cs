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
            {
                if (artifact.MimeType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true)
                    stats.CollectionWarnings.Add("工作流 JSON 产物缺少可读取正文，未取得该来源统计。");
                continue;
            }

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
                    else
                        stats.CollectionWarnings.Add("工作流 JSON 产物缺少有效的来源结构，不能按无活动处理。");
                }
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
            {
                stats.CollectionWarnings.Add("工作流 JSON 产物无法解析，未取得完整来源统计；不能按无活动处理。");
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
            var memberStats = new MemberCollectedStats
            {
                UserId = member.UserId,
                CollectionWarnings = new List<string>(teamStats.CollectionWarnings)
            };

            foreach (var source in teamStats.Sources)
            {
                // 查找该成员在此平台上的身份标识
                if (!member.IdentityMappings.TryGetValue(source.SourceType, out var identity))
                {
                    memberStats.Sources.Add(new SourceStats
                    {
                        SourceType = source.SourceType,
                        CollectedAt = source.CollectedAt,
                        CollectionWarnings = source.CollectionWarnings.Concat(new[]
                        {
                            "团队来源未配置该成员的身份映射，未将团队总量归入个人。"
                        }).ToList()
                    });
                    continue;
                }

                // 过滤属于该成员的明细
                var memberDetails = source.Details
                    .Where(d => string.Equals(d.Assignee, identity, StringComparison.OrdinalIgnoreCase))
                    .ToList();

                if (memberDetails.Count == 0)
                {
                    if (source.CollectionWarnings.Count > 0)
                        memberStats.Sources.Add(new SourceStats
                        {
                            SourceType = source.SourceType,
                            CollectedAt = source.CollectedAt,
                            CollectionWarnings = new List<string>(source.CollectionWarnings)
                        });
                    continue;
                }

                // 只重算可核查的成员明细；团队总数不能按人数或明细比例分摊。
                var warnings = new List<string>(source.CollectionWarnings);
                var memberSummary = RecalculateSummary(source, memberDetails, warnings);

                memberStats.Sources.Add(new SourceStats
                {
                    SourceType = source.SourceType,
                    CollectedAt = source.CollectedAt,
                    Summary = memberSummary,
                    Details = memberDetails,
                    CollectionWarnings = warnings
                });
            }

            result.Add(memberStats);
        }

        return result;
    }

    #region Private helpers

    private static List<JsonElement> ParseJsonEntries(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        return root.ValueKind == JsonValueKind.Array
            ? root.EnumerateArray().Select(e => e.Clone()).ToList()
            : new List<JsonElement> { root.Clone() };
    }

    private static SourceStats? ConvertToSourceStats(JsonElement entry)
    {
        if (entry.ValueKind != JsonValueKind.Object)
            return null;

        if (!entry.TryGetProperty("source", out var sourceProp))
            return null;

        var sourceType = sourceProp.ValueKind == JsonValueKind.String ? sourceProp.GetString() : null;
        if (string.IsNullOrEmpty(sourceType))
            return null;

        var stats = new SourceStats { SourceType = sourceType };
        if (entry.TryGetProperty("collectionWarnings", out var collectionWarnings) && collectionWarnings.ValueKind == JsonValueKind.Array)
            stats.CollectionWarnings = collectionWarnings.EnumerateArray()
                .Where(v => v.ValueKind == JsonValueKind.String)
                .Select(v => v.GetString()!).Where(v => !string.IsNullOrWhiteSpace(v)).ToList();

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
                    Id = ReadIdentifier(item, "id"),
                    Title = ReadString(item, "title") ?? "",
                    Type = ReadString(item, "type"),
                    Status = ReadString(item, "status"),
                    Assignee = ReadString(item, "assignee"),
                    WorkItemId = ReadString(item, "workItemId"),
                    SourceUrl = ReadString(item, "sourceUrl") ?? ReadString(item, "url"),
                    Revision = ReadString(item, "revision"),
                    EvidenceKind = ReadString(item, "evidenceKind"),
                    Scope = ReadString(item, "scope"),
                    Environment = ReadString(item, "environment"),
                    BlockReason = ReadString(item, "blockReason"),
                    NextStep = ReadString(item, "nextStep"),
                    TimeBasis = ReadString(item, "timeBasis")
                };

                var timestamp = ReadString(item, "timestamp") ?? ReadString(item, "closedAt");
                if (HasExplicitTimeZone(timestamp) && DateTimeOffset.TryParse(timestamp, out var occurred))
                    detail.Timestamp = occurred.UtcDateTime;
                else if (timestamp != null)
                    stats.CollectionWarnings.Add("部分来源明细缺少明确时区的事实时间，不按服务器时区推定发生日期。");

                stats.Details.Add(detail);
            }
        }

        return stats;
    }

    private static bool HasExplicitTimeZone(string? value)
    {
        var timeIndex = value?.IndexOf('T') ?? -1;
        return timeIndex >= 0 && (value!.EndsWith("Z", StringComparison.OrdinalIgnoreCase)
            || value.LastIndexOf('+') > timeIndex || value.LastIndexOf('-') > timeIndex);
    }

    private static string? ReadString(JsonElement item, string property)
        => item.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;

    private static string? ReadIdentifier(JsonElement item, string property)
        => item.TryGetProperty(property, out var value)
            ? value.ValueKind == JsonValueKind.String ? value.GetString()
                : value.ValueKind == JsonValueKind.Number ? value.GetRawText() : null
            : null;

    /// <summary>只认具有稳定身份、类型及所需状态的明细，不分摊团队汇总。</summary>
    private static Dictionary<string, int> RecalculateSummary(
        SourceStats source, List<StatsDetail> memberDetails, List<string> warnings)
    {
        var result = new Dictionary<string, int>();
        foreach (var (metric, total) in source.Summary)
        {
            Func<StatsDetail, bool>? predicate = metric switch
            {
                "commits" => d => d.Type == "commit",
                "prs_merged" => d => (d.Type is "pull_request" or "pr") && (d.Status == "merged" || d.EvidenceKind == "merged"),
                "prs_open" => d => (d.Type is "pull_request" or "pr") && d.Status == "open",
                "bugs_fixed" => d => d.Type == "bug" && d.Status is "fixed" or "resolved",
                "stories_done" => d => d.Type == "story" && d.Status is "done" or "completed",
                "tasks_done" => d => d.Type == "task" && d.Status is "done" or "completed",
                "articles_published" => d => d.Type == "article_published",
                "docs_updated" => d => d.Type == "article_updated",
                _ => null
            };
            if (predicate == null || source.Details.Any(d => string.IsNullOrWhiteSpace(d.Type)) ||
                source.Details.Where(predicate).Any(d => DetailIdentity(d) == null) ||
                source.Details.Where(predicate).Select(DetailIdentity).Distinct().Count() != total)
            {
                warnings.Add($"成员指标 {metric} 未分配：团队汇总缺少完整、可核查的明细口径，不能按比例推算。");
                continue;
            }
            result[metric] = memberDetails.Where(predicate).Select(DetailIdentity).Distinct().Count();
        }
        return result;
    }

    private static string? DetailIdentity(StatsDetail detail)
        => detail.Type == "commit" ? detail.Revision ?? detail.Id
            : detail.WorkItemId ?? detail.SourceUrl ?? detail.Id;

    #endregion
}
