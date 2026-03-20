using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 团队周报汇总服务 — AI 聚合团队成员周报为管理摘要
/// </summary>
public class TeamSummaryService
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<TeamSummaryService> _logger;

    private const string GatewaySystemPrompt = """
        你是严谨的企业团队周报分析助手。
        你会接收“团队成员周报原始内容”和“团队汇总Prompt”。
        请严格遵守输入中给出的 Prompt 与输出约束，只输出最终 JSON。
        """;

    public TeamSummaryService(MongoDbContext db, ILlmGateway gateway, ILogger<TeamSummaryService> logger)
    {
        _db = db;
        _gateway = gateway;
        _logger = logger;
    }

    /// <summary>
    /// 生成团队周报汇总
    /// </summary>
    public async Task<TeamSummary> GenerateAsync(
        string teamId, int weekYear, int weekNumber,
        string generatedByUserId, string? generatedByName)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == teamId).FirstOrDefaultAsync(CancellationToken.None);
        if (team == null) throw new InvalidOperationException($"团队 {teamId} 不存在");

        var members = await _db.ReportTeamMembers.Find(m => m.TeamId == teamId).ToListAsync(CancellationToken.None);

        // 获取该周已提交/已审阅的周报
        var submittedStatuses = new[] { WeeklyReportStatus.Submitted, WeeklyReportStatus.Reviewed };
        var reports = await _db.WeeklyReports.Find(
            r => r.TeamId == teamId
                 && r.WeekYear == weekYear
                 && r.WeekNumber == weekNumber
                 && submittedStatuses.Contains(r.Status)
        ).ToListAsync(CancellationToken.None);

        if (reports.Count == 0)
            throw new InvalidOperationException("没有已提交的周报可用于汇总");

        // 构建 UserPrompt
        var customPrompt = NormalizeCustomPrompt(team.TeamSummaryPrompt);
        var effectivePrompt = customPrompt ?? ReportAgentPromptDefaults.TeamSummarySystemDefaultPrompt;

        var userPrompt = BuildUserPrompt(reports, weekYear, weekNumber, effectivePrompt);

        // 调用 LLM（CancellationToken.None — 服务器权威性）
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ReportAgent.Aggregate.Summary,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = GatewaySystemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = 4096
            },
            Context = new GatewayRequestContext { UserId = generatedByUserId }
        };

        var response = await _gateway.SendAsync(request, CancellationToken.None);

        var sections = new List<TeamSummarySection>();

        if (response.Success && !string.IsNullOrWhiteSpace(response.Content))
        {
            sections = ParseSections(response.Content);
        }

        // 回退：空段落
        if (sections.Count == 0)
        {
            _logger.LogWarning("AI 团队汇总解析失败，使用空结构。Response: {Content}",
                response.Content?[..Math.Min(200, response.Content?.Length ?? 0)]);
            sections = DefaultSections();
        }

        // 计算周期
        var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        var sunday = monday.AddDays(6).AddHours(23).AddMinutes(59).AddSeconds(59);

        var summary = new TeamSummary
        {
            TeamId = teamId,
            TeamName = team.Name ?? "",
            WeekYear = weekYear,
            WeekNumber = weekNumber,
            PeriodStart = monday,
            PeriodEnd = sunday,
            Sections = sections,
            SourceReportIds = reports.Select(r => r.Id).ToList(),
            MemberCount = members.Count,
            SubmittedCount = reports.Count,
            GeneratedBy = generatedByUserId,
            GeneratedByName = generatedByName
        };

        // Upsert（TeamId + WeekYear + WeekNumber 唯一）
        var filter = Builders<TeamSummary>.Filter.Eq(x => x.TeamId, teamId)
                   & Builders<TeamSummary>.Filter.Eq(x => x.WeekYear, weekYear)
                   & Builders<TeamSummary>.Filter.Eq(x => x.WeekNumber, weekNumber);

        var existing = await _db.ReportTeamSummaries.Find(filter).FirstOrDefaultAsync(CancellationToken.None);

        if (existing != null)
        {
            summary.Id = existing.Id;
            summary.UpdatedAt = DateTime.UtcNow;
            await _db.ReportTeamSummaries.ReplaceOneAsync(filter, summary, cancellationToken: CancellationToken.None);
        }
        else
        {
            try
            {
                await _db.ReportTeamSummaries.InsertOneAsync(summary, cancellationToken: CancellationToken.None);
            }
            catch (MongoDB.Driver.MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 并发创建，更新已有记录
                existing = await _db.ReportTeamSummaries.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
                if (existing != null)
                {
                    summary.Id = existing.Id;
                    await _db.ReportTeamSummaries.ReplaceOneAsync(filter, summary, cancellationToken: CancellationToken.None);
                }
            }
        }

        return summary;
    }

    private static string BuildUserPrompt(List<WeeklyReport> reports, int weekYear, int weekNumber, string effectivePrompt)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"## 团队周报汇总 — {weekYear} 年第 {weekNumber} 周");
        sb.AppendLine($"共 {reports.Count} 位成员提交了周报。");
        sb.AppendLine();
        sb.AppendLine("## 团队汇总 Prompt");
        sb.AppendLine(effectivePrompt);
        sb.AppendLine();

        foreach (var report in reports)
        {
            sb.AppendLine($"### 成员: {report.UserName ?? report.UserId}");
            foreach (var section in report.Sections)
            {
                sb.AppendLine($"#### {section.TemplateSection?.Title ?? "未命名板块"}");
                foreach (var item in section.Items)
                {
                    sb.AppendLine($"- {item.Content}");
                }
            }
            sb.AppendLine();
        }

        sb.AppendLine("请将以上内容汇总为团队管理摘要。");
        sb.AppendLine("输出约束：必须输出合法 JSON，结构为 {\"sections\":[{\"title\":\"...\",\"items\":[\"...\"]}]}。");
        sb.AppendLine("sections 必须包含且仅包含 5 个标题：本周亮点、关键指标、进行中任务、风险与阻塞、下周重点。");
        return sb.ToString();
    }

    private static string? NormalizeCustomPrompt(string? prompt)
    {
        var trimmed = (prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
            return null;
        if (trimmed.Length > ReportAgentPromptDefaults.MaxCustomPromptLength)
            return trimmed[..ReportAgentPromptDefaults.MaxCustomPromptLength];
        return trimmed;
    }

    private List<TeamSummarySection> ParseSections(string content)
    {
        try
        {
            var json = ExtractJson(content);
            if (string.IsNullOrEmpty(json)) return new();

            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (root.TryGetProperty("sections", out var sectionsArr) && sectionsArr.ValueKind == JsonValueKind.Array)
            {
                var result = new List<TeamSummarySection>();
                foreach (var sec in sectionsArr.EnumerateArray())
                {
                    var title = sec.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "";
                    var items = new List<string>();
                    if (sec.TryGetProperty("items", out var itemsArr) && itemsArr.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in itemsArr.EnumerateArray())
                        {
                            var val = item.GetString();
                            if (!string.IsNullOrWhiteSpace(val))
                                items.Add(val);
                        }
                    }
                    result.Add(new TeamSummarySection { Title = title, Items = items });
                }
                return result;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "解析团队汇总 JSON 失败");
        }
        return new();
    }

    private static List<TeamSummarySection> DefaultSections() => new()
    {
        new() { Title = "本周亮点", Items = new() },
        new() { Title = "关键指标", Items = new() },
        new() { Title = "进行中任务", Items = new() },
        new() { Title = "风险与阻塞", Items = new() },
        new() { Title = "下周重点", Items = new() },
    };

    private static string? ExtractJson(string content)
    {
        content = content.Trim();
        if (content.StartsWith('{')) return content;

        var jsonStart = content.IndexOf("```json", StringComparison.OrdinalIgnoreCase);
        if (jsonStart >= 0)
        {
            var start = content.IndexOf('\n', jsonStart) + 1;
            var end = content.IndexOf("```", start, StringComparison.Ordinal);
            if (end > start) return content[start..end].Trim();
        }

        var firstBrace = content.IndexOf('{');
        var lastBrace = content.LastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace)
            return content[firstBrace..(lastBrace + 1)];

        return null;
    }
}
