using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 周报 AI 生成引擎 — 采集数据 → 构建 Prompt → LLM → 解析 → 保存草稿
/// </summary>
public class ReportGenerationService
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly MapActivityCollector _collector;
    private readonly ILogger<ReportGenerationService> _logger;
    private readonly IWorkflowExecutionService _workflowExecService;
    private readonly PersonalSourceService _personalSourceService;
    private readonly IMarkdownParser _markdownParser;

    private const string GatewaySystemPrompt = """
        你是一位专业的周报撰写助手。
        严格遵守用户输入中的模板结构与写作要求。
        输出必须是合法 JSON，不要包含 markdown 代码块标记。
        """;

    /// <summary>Markdown 导入场景的 source 标签（与 Controller 中的 ReportAiSourceKey.MarkdownImport 同值）</summary>
    private const string MarkdownImportSourceKey = "markdown-import";

    private const string GatewayImportSystemPrompt = """
        你是一位专业的周报内容结构化助手。
        任务：将用户上传的 Markdown 周报严格映射到指定模板章节。
        硬规则：
        1. 只使用上传 Markdown 中出现的内容，禁止编造新信息。
        2. 不改写任何指标数值，不夸大工作量。
        3. 所有条目的 source 字段必须固定为 "markdown-import"。
        4. 对 inputType=issue-list 的板块，issueCategoryKey / issueStatusKey 必须留 null，由用户在界面中手动选择。
        5. 输出必须是合法 JSON，不要包含 markdown 代码块标记，不输出任何解释文字。
        """;

    public ReportGenerationService(
        MongoDbContext db,
        ILlmGateway gateway,
        MapActivityCollector collector,
        ILogger<ReportGenerationService> logger,
        IWorkflowExecutionService workflowExecService,
        PersonalSourceService personalSourceService,
        IMarkdownParser markdownParser)
    {
        _db = db;
        _gateway = gateway;
        _collector = collector;
        _logger = logger;
        _workflowExecService = workflowExecService;
        _personalSourceService = personalSourceService;
        _markdownParser = markdownParser;
    }

    /// <summary>
    /// 为指定用户的指定周期生成周报草稿
    /// </summary>
    public async Task<WeeklyReport> GenerateAsync(
        string userId, string teamId, string templateId,
        int weekYear, int weekNumber, CancellationToken ct)
    {
        // 1. 加载模板
        var template = await _db.ReportTemplates.Find(t => t.Id == templateId).FirstOrDefaultAsync(ct);
        if (template == null)
            throw new InvalidOperationException($"模板 {templateId} 不存在");

        // 2. 计算周期
        var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        var sunday = monday.AddDays(6).AddHours(23).AddMinutes(59).AddSeconds(59);

        // 2.1 读取“我的数据源”与“AI 生成周报 Prompt”偏好
        var sourcePrefs = await LoadGenerationSourcePrefsAsync(userId, ct);
        var promptPrefs = await LoadGenerationPromptPrefsAsync(userId, ct);

        // 3. 采集数据（使用 CancellationToken.None，服务器权威性）
        var activity = await _collector.CollectAsync(userId, monday, sunday, CancellationToken.None);
        var activitySummary = BuildActivitySummary(activity, sourcePrefs, promptPrefs);
        _logger.LogInformation(
            "开始 AI 生成周报: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}, data={ActivitySummary}",
            userId, teamId, weekYear, weekNumber, activitySummary);

        // 4. 构建 Prompt
        var userPrompt = BuildUserPrompt(template, activity, weekYear, weekNumber, sourcePrefs, promptPrefs.EffectivePrompt);

        // 5. 调用 LLM（非流式，CancellationToken.None）
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ReportAgent.Generate.Draft,
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
            Context = new GatewayRequestContext { UserId = userId }
        };

        var response = await _gateway.SendAsync(request, CancellationToken.None);
        List<WeeklyReportSection>? generatedSections = null;
        string? primaryFailureReason = null;
        var usedRuleFallback = false;

        if (!response.Success)
        {
            primaryFailureReason = string.IsNullOrWhiteSpace(response.ErrorMessage)
                ? "AI 生成失败，请稍后重试"
                : $"AI 生成失败：{response.ErrorMessage}";
            _logger.LogWarning(
                "AI 生成周报失败，准备启用规则兜底: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}, errorCode={ErrorCode}, error={ErrorMessage}, data={ActivitySummary}",
                userId, teamId, weekYear, weekNumber, response.ErrorCode, response.ErrorMessage, activitySummary);
        }
        else if (string.IsNullOrWhiteSpace(response.Content))
        {
            primaryFailureReason = "AI 返回空内容，未生成周报草稿";
            _logger.LogWarning(
                "AI 生成周报返回空内容，准备启用规则兜底: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}, logId={LogId}, data={ActivitySummary}",
                userId, teamId, weekYear, weekNumber, response.LogId, activitySummary);
        }
        else
        {
            generatedSections = ParseGeneratedSections(response.Content, template);
            if (generatedSections == null)
            {
                primaryFailureReason = "AI 返回格式异常，未生成有效周报内容";
                _logger.LogWarning(
                    "AI 生成周报解析失败，准备启用规则兜底: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}, logId={LogId}, preview={Preview}, data={ActivitySummary}",
                    userId, teamId, weekYear, weekNumber, response.LogId, Preview(response.Content), activitySummary);
            }
            else if (CountGeneratedItems(generatedSections) <= 0)
            {
                primaryFailureReason = "AI 未生成有效周报条目，请稍后重试";
                _logger.LogWarning(
                    "AI 生成周报无有效条目，准备启用规则兜底: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}, logId={LogId}, preview={Preview}, data={ActivitySummary}",
                    userId, teamId, weekYear, weekNumber, response.LogId, Preview(response.Content), activitySummary);
                generatedSections = null;
            }
        }

        if (generatedSections == null)
        {
            var fallbackSections = BuildRuleBasedSections(template, activity, sourcePrefs, weekYear, weekNumber);
            if (fallbackSections != null && CountGeneratedItems(fallbackSections) > 0)
            {
                generatedSections = fallbackSections;
                usedRuleFallback = true;
                _logger.LogInformation(
                    "AI 生成周报已切换规则兜底成功: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}, reason={Reason}, data={ActivitySummary}",
                    userId, teamId, weekYear, weekNumber, primaryFailureReason ?? "unknown", activitySummary);
            }
            else
            {
                throw new InvalidOperationException(primaryFailureReason ?? "AI 生成失败，请稍后重试");
            }
        }

        // 7. Upsert 周报
        var filter = Builders<WeeklyReport>.Filter.Eq(x => x.UserId, userId)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.TeamId, teamId)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.WeekYear, weekYear)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.WeekNumber, weekNumber);

        var existing = await _db.WeeklyReports.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
        var generatedAt = DateTime.UtcNow;
        var autoGeneratedBy = usedRuleFallback ? "rule-fallback" : "llm";
        var autoGeneratedModelId = usedRuleFallback ? null : response.Resolution?.ActualModel;
        var autoGeneratedPlatformId = usedRuleFallback ? null : response.Resolution?.ActualPlatformId;

        if (existing != null)
        {
            // 更新现有草稿
            var update = Builders<WeeklyReport>.Update
                .Set(x => x.Sections, generatedSections)
                .Set(x => x.AutoGeneratedAt, generatedAt)
                .Set(x => x.AutoGeneratedBy, autoGeneratedBy)
                .Set(x => x.AutoGeneratedModelId, autoGeneratedModelId)
                .Set(x => x.AutoGeneratedPlatformId, autoGeneratedPlatformId)
                .Set(x => x.UpdatedAt, generatedAt);

            await _db.WeeklyReports.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
            existing.Sections = generatedSections;
            existing.AutoGeneratedAt = generatedAt;
            existing.AutoGeneratedBy = autoGeneratedBy;
            existing.AutoGeneratedModelId = autoGeneratedModelId;
            existing.AutoGeneratedPlatformId = autoGeneratedPlatformId;
            return existing;
        }
        else
        {
            // 查找用户信息
            var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(CancellationToken.None);
            var team = await _db.ReportTeams.Find(t => t.Id == teamId).FirstOrDefaultAsync(CancellationToken.None);

            var report = new WeeklyReport
            {
                UserId = userId,
                UserName = user?.DisplayName,
                AvatarFileName = user?.AvatarFileName,
                TeamId = teamId,
                TeamName = team?.Name,
                TemplateId = templateId,
                WeekYear = weekYear,
                WeekNumber = weekNumber,
                PeriodStart = monday,
                PeriodEnd = sunday,
                Status = WeeklyReportStatus.Draft,
                Sections = generatedSections,
                AutoGeneratedAt = generatedAt,
                AutoGeneratedBy = autoGeneratedBy,
                AutoGeneratedModelId = autoGeneratedModelId,
                AutoGeneratedPlatformId = autoGeneratedPlatformId
            };

            try
            {
                await _db.WeeklyReports.InsertOneAsync(report, cancellationToken: CancellationToken.None);
            }
            catch (MongoDB.Driver.MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 并发创建，读取已有记录
                return await _db.WeeklyReports.Find(filter).FirstOrDefaultAsync(CancellationToken.None)
                       ?? report;
            }

            return report;
        }
    }

    internal static string BuildUserPrompt(
        ReportTemplate template,
        CollectedActivity activity,
        int weekYear,
        int weekNumber,
        GenerationSourcePrefs sourcePrefs,
        string effectivePrompt)
    {
        var (targetPlanWeekYear, targetPlanWeekNumber) = GetNextIsoWeek(weekYear, weekNumber);
        var todoPlanItems = BuildTodoPlanItemsForTargetWeek(activity, targetPlanWeekYear, targetPlanWeekNumber);
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"## 周报周期: {weekYear} 年第 {weekNumber} 周");
        sb.AppendLine();
        sb.AppendLine("## 写作要求（生效 Prompt）");
        sb.AppendLine(effectivePrompt);
        sb.AppendLine();

        // 模板结构
        sb.AppendLine("## 模板结构（请严格按此结构输出 JSON）");
        sb.AppendLine("输出格式: { \"sections\": [ { \"items\": [ { \"content\": \"...\", \"source\": \"...\" } ] } ] }");
        sb.AppendLine("sections 数组长度必须与以下板块数量一致。");
        sb.AppendLine();

        for (var i = 0; i < template.Sections.Count; i++)
        {
            var section = template.Sections[i];
            sb.AppendLine($"### 板块 {i + 1}: {section.Title}");
            if (!string.IsNullOrEmpty(section.Description))
                sb.AppendLine($"填写指引: {section.Description}");
            sb.AppendLine($"输入类型: {section.InputType}");
            sb.AppendLine($"是否必填: {(section.IsRequired ? "是" : "否")}");
            if (section.MaxItems.HasValue)
                sb.AppendLine($"最多条目: {section.MaxItems}");
            if (!string.IsNullOrEmpty(section.DataSourceHint))
                sb.AppendLine($"数据来源提示: {section.DataSourceHint}");
            sb.AppendLine();
        }

        // 采集数据
        sb.AppendLine("## 采集到的原始数据");
        sb.AppendLine();

        if (sourcePrefs.MapPlatformEnabled && activity.Commits.Count > 0)
        {
            sb.AppendLine("### MAP 平台工作记录（代码提交）");
            foreach (var c in activity.Commits.Take(50))
            {
                sb.AppendLine($"- [{c.CommittedAt:MM-dd}] {c.Message}");
            }
            sb.AppendLine($"总计: {activity.Commits.Count} 次提交");
            var totalAdd = activity.Commits.Sum(c => c.Additions);
            var totalDel = activity.Commits.Sum(c => c.Deletions);
            sb.AppendLine($"代码统计: +{totalAdd} -{totalDel}");
            sb.AppendLine();
        }

        if (sourcePrefs.DailyLogEnabled && activity.DailyLogs.Count > 0)
        {
            sb.AppendLine("### 每日打点");
            foreach (var log in activity.DailyLogs)
            {
                sb.AppendLine($"#### {log.Date:yyyy-MM-dd}");
                foreach (var item in log.Items)
                {
                    var dur = item.DurationMinutes.HasValue ? $" ({item.DurationMinutes}min)" : "";
                    sb.AppendLine($"- [{item.Category}] {item.Content}{dur}");
                }
            }
            sb.AppendLine();
        }

        if (sourcePrefs.DailyLogEnabled && todoPlanItems.Count > 0)
        {
            sb.AppendLine($"### Todo 计划池（目标：{targetPlanWeekYear} 年第 {targetPlanWeekNumber} 周）");
            foreach (var item in todoPlanItems)
            {
                sb.AppendLine($"- {item.Content}");
            }
            sb.AppendLine();
        }

        if (sourcePrefs.MapPlatformEnabled)
        {
            var hasAnyMapStats = activity.PrdSessions > 0 || activity.PrdMessageCount > 0
                || activity.DefectsSubmitted > 0 || activity.VisualSessions > 0
                || activity.ImageGenCompletedCount > 0 || activity.VideoGenCompletedCount > 0
                || activity.DocumentEditCount > 0 || activity.WorkflowExecutionCount > 0
                || activity.ToolboxRunCount > 0 || activity.WebPagePublishCount > 0
                || activity.AttachmentUploadCount > 0 || activity.LlmCalls > 0;

            if (hasAnyMapStats)
            {
                sb.AppendLine("### MAP 平台工作记录（行为统计）");
                if (activity.PrdSessions > 0)
                    sb.AppendLine($"- PRD 对话会话: {activity.PrdSessions} 次");
                if (activity.PrdMessageCount > 0)
                    sb.AppendLine($"- PRD 对话消息: {activity.PrdMessageCount} 条");
                if (activity.DefectsSubmitted > 0)
                {
                    sb.AppendLine($"- 缺陷提交: {activity.DefectsSubmitted} 个");
                    if (activity.DefectDetails is { Resolved: > 0 })
                        sb.AppendLine($"  · 已解决 {activity.DefectDetails.Resolved} 个，平均 {activity.DefectDetails.AvgResolutionHours} 小时");
                    if (activity.DefectDetails is { Reopened: > 0 })
                        sb.AppendLine($"  · 退回/重开 {activity.DefectDetails.Reopened} 个");
                }
                if (activity.VisualSessions > 0)
                    sb.AppendLine($"- 视觉创作会话: {activity.VisualSessions} 次");
                if (activity.ImageGenCompletedCount > 0)
                    sb.AppendLine($"- 图片生成完成: {activity.ImageGenCompletedCount} 次");
                if (activity.VideoGenCompletedCount > 0)
                    sb.AppendLine($"- 视频生成完成: {activity.VideoGenCompletedCount} 次");
                if (activity.DocumentEditCount > 0)
                    sb.AppendLine($"- 创建 PRD 项目: {activity.DocumentEditCount} 个");
                if (activity.WorkflowExecutionCount > 0)
                    sb.AppendLine($"- 自动化工作流执行: {activity.WorkflowExecutionCount} 次");
                if (activity.ToolboxRunCount > 0)
                    sb.AppendLine($"- AI 工具箱使用: {activity.ToolboxRunCount} 次");
                if (activity.WebPagePublishCount > 0)
                    sb.AppendLine($"- 网页发布/更新: {activity.WebPagePublishCount} 次");
                if (activity.AttachmentUploadCount > 0)
                    sb.AppendLine($"- 附件上传: {activity.AttachmentUploadCount} 个");
                if (activity.LlmCalls > 0)
                    sb.AppendLine($"- AI 调用: {activity.LlmCalls} 次");
                sb.AppendLine();
            }
        }

        var sourceTags = new List<string> { "daily-log", "ai" };
        if (sourcePrefs.MapPlatformEnabled)
            sourceTags.Insert(0, "map-platform");
        sb.AppendLine($"请基于以上数据生成周报，每个条目的 source 字段标记来源：{string.Join(" / ", sourceTags)}");
        sb.AppendLine("严格约束：");
        sb.AppendLine("1. 只基于「采集到的原始数据」中明确列出的指标生成内容，禁止凭空编造。");
        sb.AppendLine("2. 不要把指标名称改写成其他活动。采集结果说什么就是什么，不允许语义漂移：");
        sb.AppendLine("   - 「创建 PRD 项目」不能写成「编辑文档」「新建知识库」「完成技术规范」");
        sb.AppendLine("   - 「网页发布/更新」不能写成「发布网站」的泛化描述或夸大数量");
        sb.AppendLine("   - 「AI 调用」不能写成「优化处理效率」「辅助生成」的效果类描述");
        sb.AppendLine("3. 指标数值必须与采集结果完全一致，禁止凑整、放大、捏造修饰语（如「量较大」「若干篇」）。");
        sb.AppendLine("4. 如果某个板块确实没有数据支撑，请输出空 items 数组，禁止用「无数据」「待补充」等占位文本。");

        return sb.ToString();
    }

    private async Task<GenerationSourcePrefs> LoadGenerationSourcePrefsAsync(string userId, CancellationToken ct)
    {
        var prefs = await _db.UserPreferences
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        return new GenerationSourcePrefs(
            DailyLogEnabled: true,
            MapPlatformEnabled: prefs?.ReportAgentPreferences?.MapPlatformSourceEnabled ?? true
        );
    }

    private async Task<GenerationPromptPrefs> LoadGenerationPromptPrefsAsync(string userId, CancellationToken ct)
    {
        var prefs = await _db.UserPreferences
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        var customPrompt = NormalizeCustomPrompt(prefs?.ReportAgentPreferences?.WeeklyReportPrompt);
        var effectivePrompt = customPrompt ?? ReportAgentPromptDefaults.WeeklyReportSystemDefaultPrompt;
        return new GenerationPromptPrefs(
            SystemDefaultPrompt: ReportAgentPromptDefaults.WeeklyReportSystemDefaultPrompt,
            CustomPrompt: customPrompt,
            EffectivePrompt: effectivePrompt,
            IsCustom: customPrompt != null
        );
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

    internal sealed record GenerationSourcePrefs(bool DailyLogEnabled, bool MapPlatformEnabled);
    private sealed record GenerationPromptPrefs(
        string SystemDefaultPrompt,
        string? CustomPrompt,
        string EffectivePrompt,
        bool IsCustom);

    private List<WeeklyReportSection>? ParseGeneratedSections(string content, ReportTemplate template)
    {
        try
        {
            // 先尝试提取文本主体（兼容 OpenAI/Claude 外层响应）
            var normalizedContent = NormalizeGatewayContent(content);

            // 再提取 JSON（可能被 markdown 代码块包裹）
            var json = ExtractJson(normalizedContent);
            if (string.IsNullOrEmpty(json)) return null;

            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            JsonElement sectionsElement;
            if (root.TryGetProperty("sections", out sectionsElement)
                && sectionsElement.ValueKind == JsonValueKind.Array)
            {
                var sections = new List<WeeklyReportSection>();
                var sectionIdx = 0;

                foreach (var sectionJson in sectionsElement.EnumerateArray())
                {
                    var templateSection = sectionIdx < template.Sections.Count
                        ? template.Sections[sectionIdx]
                        : new ReportTemplateSection { Title = $"板块 {sectionIdx + 1}" };

                    var items = new List<WeeklyReportItem>();

                    if (sectionJson.TryGetProperty("items", out var itemsArray)
                        && itemsArray.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var itemJson in itemsArray.EnumerateArray())
                        {
                            var itemContent = itemJson.ValueKind switch
                            {
                                JsonValueKind.String => itemJson.GetString() ?? "",
                                JsonValueKind.Object when itemJson.TryGetProperty("content", out var c) => c.GetString() ?? "",
                                JsonValueKind.Object when itemJson.TryGetProperty("text", out var t) => t.GetString() ?? "",
                                _ => ""
                            };
                            var source = itemJson.ValueKind == JsonValueKind.Object
                                && itemJson.TryGetProperty("source", out var s)
                                ? s.GetString() ?? "ai"
                                : "ai";

                            if (!string.IsNullOrWhiteSpace(itemContent))
                            {
                                items.Add(new WeeklyReportItem
                                {
                                    Content = itemContent,
                                    Source = source
                                });
                            }
                        }
                    }

                    sections.Add(new WeeklyReportSection
                    {
                        TemplateSection = templateSection,
                        Items = items
                    });

                    sectionIdx++;
                }

                // 补齐缺失的板块
                while (sections.Count < template.Sections.Count)
                {
                    sections.Add(new WeeklyReportSection
                    {
                        TemplateSection = template.Sections[sections.Count],
                        Items = new()
                    });
                }

                return sections;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "解析 AI 生成的周报内容失败");
        }

        return null;
    }

    private static string NormalizeGatewayContent(string content)
    {
        var trimmed = (content ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
            return trimmed;

        // 先移除可能干扰 JSON 提取的思考标签
        trimmed = System.Text.RegularExpressions.Regex
            .Replace(trimmed, "<think>[\\s\\S]*?</think>", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Trim();

        if (!trimmed.StartsWith('{'))
            return trimmed;

        try
        {
            using var doc = JsonDocument.Parse(trimmed);
            var root = doc.RootElement;

            // 已经是目标格式
            if (root.TryGetProperty("sections", out _))
                return trimmed;

            // OpenAI 样式：choices[0].message.content
            if (root.TryGetProperty("choices", out var choices)
                && choices.ValueKind == JsonValueKind.Array
                && choices.GetArrayLength() > 0)
            {
                var firstChoice = choices[0];
                if (firstChoice.TryGetProperty("message", out var message)
                    && message.TryGetProperty("content", out var messageContent))
                {
                    var extracted = ExtractTextValue(messageContent);
                    if (!string.IsNullOrWhiteSpace(extracted))
                        return extracted;
                }
            }

            // Claude 样式：content[0].text
            if (root.TryGetProperty("content", out var claudeContent))
            {
                var extracted = ExtractTextValue(claudeContent);
                if (!string.IsNullOrWhiteSpace(extracted))
                    return extracted;
            }
        }
        catch
        {
            // ignore - 继续走后续提取逻辑
        }

        return trimmed;
    }

    private static string ExtractTextValue(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString() ?? "",
            JsonValueKind.Array => string.Join(
                "\n",
                element.EnumerateArray()
                    .Select(ExtractTextValue)
                    .Where(x => !string.IsNullOrWhiteSpace(x))),
            JsonValueKind.Object when element.TryGetProperty("text", out var text)
                => text.GetString() ?? "",
            JsonValueKind.Object when element.TryGetProperty("content", out var content)
                => ExtractTextValue(content),
            _ => ""
        };
    }

    private static string? ExtractJson(string content)
    {
        // 尝试直接解析
        content = content.Trim();
        if (content.StartsWith('{'))
            return content;

        // 尝试从 markdown 代码块中提取
        var jsonStart = content.IndexOf("```json", StringComparison.OrdinalIgnoreCase);
        if (jsonStart >= 0)
        {
            var start = content.IndexOf('\n', jsonStart) + 1;
            var end = content.IndexOf("```", start, StringComparison.Ordinal);
            if (end > start)
                return content[start..end].Trim();
        }

        // 尝试找到第一个 { 和最后一个 }
        var firstBrace = content.IndexOf('{');
        var lastBrace = content.LastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace)
            return content[firstBrace..(lastBrace + 1)];

        return null;
    }

    private static int CountGeneratedItems(IEnumerable<WeeklyReportSection> sections)
        => sections.Sum(s => s.Items?.Count ?? 0);

    private static string Preview(string? content, int maxLength = 240)
    {
        if (string.IsNullOrWhiteSpace(content))
            return string.Empty;
        var normalized = content.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string BuildActivitySummary(
        CollectedActivity activity,
        GenerationSourcePrefs sourcePrefs,
        GenerationPromptPrefs promptPrefs)
        => $"dailyLogs={activity.DailyLogs.Count}, commits={activity.Commits.Count}, prdSessions={activity.PrdSessions}, prdMessages={activity.PrdMessageCount}, llmCalls={activity.LlmCalls}, mapEnabled={sourcePrefs.MapPlatformEnabled}, dailyEnabled={sourcePrefs.DailyLogEnabled}, promptCustomized={promptPrefs.IsCustom}";

    private static List<WeeklyReportSection>? BuildRuleBasedSections(
        ReportTemplate template,
        CollectedActivity activity,
        GenerationSourcePrefs sourcePrefs,
        int weekYear,
        int weekNumber)
    {
        var (targetPlanWeekYear, targetPlanWeekNumber) = GetNextIsoWeek(weekYear, weekNumber);
        var todoPlanItems = BuildTodoPlanItemsForTargetWeek(activity, targetPlanWeekYear, targetPlanWeekNumber);
        var completionPool = BuildCompletionPool(activity, sourcePrefs);
        var hasStats = HasAnyActivity(activity, sourcePrefs);
        if (completionPool.Count == 0 && !hasStats)
            return null;

        var sections = new List<WeeklyReportSection>();
        var completionCursor = 0;

        foreach (var section in template.Sections)
        {
            var sectionType = section.SectionType;
            var normalizedKey = $"{section.Title} {section.Description}".Trim().ToLowerInvariant();
            var maxItems = Math.Clamp(section.MaxItems ?? 5, 1, 8);
            var items = new List<WeeklyReportItem>();

            if (sectionType == ReportSectionType.ManualList || sectionType == ReportSectionType.FreeText)
            {
                sections.Add(new WeeklyReportSection
                {
                    TemplateSection = section,
                    Items = items
                });
                continue;
            }

            if (normalizedKey.Contains("风险", StringComparison.Ordinal)
                || normalizedKey.Contains("问题", StringComparison.Ordinal)
                || normalizedKey.Contains("阻塞", StringComparison.Ordinal))
            {
                items.AddRange(BuildRiskItems(activity, sourcePrefs, maxItems));
            }
            else if (normalizedKey.Contains("计划", StringComparison.Ordinal)
                || normalizedKey.Contains("下周", StringComparison.Ordinal)
                || normalizedKey.Contains("待办", StringComparison.Ordinal))
            {
                items.AddRange(BuildPlanItems(todoPlanItems, completionPool, maxItems));
            }
            else if (normalizedKey.Contains("总结", StringComparison.Ordinal)
                || normalizedKey.Contains("复盘", StringComparison.Ordinal)
                || normalizedKey.Contains("思考", StringComparison.Ordinal))
            {
                items.AddRange(BuildSummaryItems(activity, sourcePrefs, maxItems));
            }
            else
            {
                while (items.Count < maxItems && completionCursor < completionPool.Count)
                {
                    items.Add(completionPool[completionCursor]);
                    completionCursor++;
                }
            }

            // 如果该章节未命中专用策略但整体有数据，至少补一条摘要，避免空章节。
            if (items.Count == 0 && hasStats)
            {
                items.AddRange(BuildSummaryItems(activity, sourcePrefs, 1));
            }

            sections.Add(new WeeklyReportSection
            {
                TemplateSection = section,
                Items = items
            });
        }

        return sections;
    }

    private static List<WeeklyReportItem> BuildCompletionPool(CollectedActivity activity, GenerationSourcePrefs sourcePrefs)
    {
        var result = new List<WeeklyReportItem>();

        if (sourcePrefs.DailyLogEnabled)
        {
            foreach (var log in activity.DailyLogs.OrderBy(x => x.Date))
            {
                foreach (var item in log.Items.Where(i => !string.IsNullOrWhiteSpace(i.Content)))
                {
                    var content = $"{log.Date:MM-dd} {item.Content.Trim()}";
                    if (item.DurationMinutes is > 0)
                        content += $"（约 {item.DurationMinutes} 分钟）";
                    result.Add(new WeeklyReportItem
                    {
                        Content = content,
                        Source = "daily-log"
                    });
                }
            }
        }

        if (sourcePrefs.MapPlatformEnabled)
        {
            foreach (var commit in activity.Commits
                         .Where(c => !string.IsNullOrWhiteSpace(c.Message))
                         .OrderByDescending(c => c.CommittedAt)
                         .Take(20))
            {
                result.Add(new WeeklyReportItem
                {
                    Content = $"代码提交：{commit.Message.Trim()}",
                    Source = "map-platform"
                });
            }
        }

        return result;
    }

    private static List<WeeklyReportItem> BuildRiskItems(CollectedActivity activity, GenerationSourcePrefs sourcePrefs, int maxItems)
    {
        var items = new List<WeeklyReportItem>();

        if (sourcePrefs.MapPlatformEnabled && activity.DefectsSubmitted > 0)
        {
            items.Add(new WeeklyReportItem
            {
                Content = $"本周提交缺陷 {activity.DefectsSubmitted} 个，重点跟进高优先级问题闭环。",
                Source = "map-platform"
            });
        }

        if (activity.DefectDetails is { Reopened: > 0 })
        {
            items.Add(new WeeklyReportItem
            {
                Content = $"存在 {activity.DefectDetails.Reopened} 个退回/重开问题，需提前补充验收标准。",
                Source = "map-platform"
            });
        }

        if (items.Count == 0)
        {
            items.Add(new WeeklyReportItem
            {
                Content = "本周未发现明显阻塞风险，建议保持每日同步并提前暴露依赖问题。",
                Source = sourcePrefs.MapPlatformEnabled ? "map-platform" : "daily-log"
            });
        }

        return items.Take(maxItems).ToList();
    }

    private static List<WeeklyReportItem> BuildPlanItems(
        List<WeeklyReportItem> todoPlanItems,
        List<WeeklyReportItem> completionPool,
        int maxItems)
    {
        if (todoPlanItems.Count > 0)
            return todoPlanItems.Take(maxItems).ToList();

        var seed = completionPool
            .Where(x => !string.IsNullOrWhiteSpace(x.Content))
            .Take(maxItems)
            .Select(x => new WeeklyReportItem
            {
                Content = $"继续推进：{x.Content}",
                Source = x.Source
            })
            .ToList();

        if (seed.Count == 0)
        {
            seed.Add(new WeeklyReportItem
            {
                Content = "下周聚焦核心目标拆解与交付节奏，按优先级推进并按日复盘。",
                Source = "ai"
            });
        }

        return seed;
    }

    private static List<WeeklyReportItem> BuildTodoPlanItemsForTargetWeek(
        CollectedActivity activity,
        int targetWeekYear,
        int targetWeekNumber)
    {
        var result = new List<WeeklyReportItem>();
        foreach (var log in activity.DailyLogs.OrderBy(x => x.Date))
        {
            foreach (var item in log.Items.Where(i => !string.IsNullOrWhiteSpace(i.Content)))
            {
                if (!IsTodoItem(item))
                    continue;
                if (item.PlanWeekYear != targetWeekYear || item.PlanWeekNumber != targetWeekNumber)
                    continue;
                var content = item.Content.Trim();
                result.Add(new WeeklyReportItem
                {
                    Content = content.StartsWith("继续推进：", StringComparison.Ordinal) ? content : $"继续推进：{content}",
                    Source = "daily-log"
                });
            }
        }
        return result;
    }

    private static bool IsTodoItem(DailyLogItem item)
    {
        if (string.Equals(item.Category, DailyLogCategory.Todo, StringComparison.OrdinalIgnoreCase))
            return true;
        return item.Tags.Any(tag => string.Equals(tag, DailyLogCategory.Todo, StringComparison.OrdinalIgnoreCase));
    }

    private static (int weekYear, int weekNumber) GetNextIsoWeek(int weekYear, int weekNumber)
    {
        var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        var targetDate = monday.AddDays(7);
        return (ISOWeek.GetYear(targetDate), ISOWeek.GetWeekOfYear(targetDate));
    }

    private static List<WeeklyReportItem> BuildSummaryItems(CollectedActivity activity, GenerationSourcePrefs sourcePrefs, int maxItems)
    {
        var source = sourcePrefs.MapPlatformEnabled ? "map-platform" : "daily-log";
        var summaries = new List<string>();

        if (sourcePrefs.DailyLogEnabled && activity.DailyLogs.Count > 0)
            summaries.Add($"本周累计记录 {activity.DailyLogs.Count} 天日常工作，执行节奏整体稳定。");
        if (sourcePrefs.MapPlatformEnabled && activity.Commits.Count > 0)
            summaries.Add($"本周完成 {activity.Commits.Count} 次代码提交，持续推进需求落地。");
        if (sourcePrefs.MapPlatformEnabled && activity.PrdSessions > 0)
            summaries.Add($"围绕需求与方案开展 {activity.PrdSessions} 次对话会话，协作沟通较充分。");
        if (sourcePrefs.MapPlatformEnabled && activity.DefectsSubmitted > 0)
            summaries.Add($"缺陷处理侧提交 {activity.DefectsSubmitted} 个问题，质量治理持续推进。");

        if (summaries.Count == 0)
        {
            summaries.Add("本周工作按计划推进，建议下周继续围绕核心目标聚焦执行。");
        }

        return summaries.Take(maxItems)
            .Select(s => new WeeklyReportItem { Content = s, Source = source })
            .ToList();
    }

    private static bool HasAnyActivity(CollectedActivity activity, GenerationSourcePrefs sourcePrefs)
    {
        if (sourcePrefs.DailyLogEnabled && activity.DailyLogs.Count > 0)
            return true;
        if (sourcePrefs.MapPlatformEnabled &&
            (activity.Commits.Count > 0
             || activity.PrdSessions > 0
             || activity.DefectsSubmitted > 0
             || activity.LlmCalls > 0
             || activity.PrdMessageCount > 0))
            return true;
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    // Markdown 导入 — 上传 .md → LLM 映射模板章节 → 规则兜底
    // ═══════════════════════════════════════════════════════════════

    public sealed record ImportMarkdownResult(
        WeeklyReport? Report,
        string? ImportError,
        bool UsedRuleFallback,
        string? ModelId,
        string? PlatformId,
        bool NeedsOverwriteConfirmation);

    /// <summary>
    /// 从 Markdown 文件导入周报。支持覆盖 draft 状态的已有周报（需 confirmOverwrite=true）。
    /// </summary>
    public async Task<ImportMarkdownResult> ImportFromMarkdownAsync(
        string userId, string teamId, string templateId,
        int weekYear, int weekNumber,
        string markdownContent,
        bool confirmOverwrite,
        CancellationToken ct)
    {
        var template = await _db.ReportTemplates.Find(t => t.Id == templateId).FirstOrDefaultAsync(ct);
        if (template == null)
            throw new InvalidOperationException($"模板 {templateId} 不存在");

        var team = await _db.ReportTeams.Find(t => t.Id == teamId).FirstOrDefaultAsync(ct);
        if (team == null)
            throw new InvalidOperationException($"团队 {teamId} 不存在");

        var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        var sunday = monday.AddDays(6).AddHours(23).AddMinutes(59).AddSeconds(59);

        // 检查已有报告
        var filter = Builders<WeeklyReport>.Filter.Eq(x => x.UserId, userId)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.TeamId, teamId)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.WeekYear, weekYear)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.WeekNumber, weekNumber);
        var existing = await _db.WeeklyReports.Find(filter).FirstOrDefaultAsync(ct);

        if (existing != null)
        {
            // submitted+ 状态不允许覆盖
            var overwritableStatuses = new[]
            {
                WeeklyReportStatus.Draft,
                WeeklyReportStatus.Returned,
                WeeklyReportStatus.Overdue,
                WeeklyReportStatus.NotStarted
            };
            if (!overwritableStatuses.Contains(existing.Status))
            {
                throw new InvalidOperationException(
                    $"本周周报已处于 {existing.Status} 状态，不支持 Markdown 导入覆盖");
            }

            // 非确认状态 — 返回需要确认
            if (!confirmOverwrite)
            {
                return new ImportMarkdownResult(
                    Report: null,
                    ImportError: null,
                    UsedRuleFallback: false,
                    ModelId: null,
                    PlatformId: null,
                    NeedsOverwriteConfirmation: true);
            }
        }

        _logger.LogInformation(
            "开始 Markdown 导入周报: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}, len={Len}, hasExisting={HasExisting}",
            userId, teamId, weekYear, weekNumber, markdownContent.Length, existing != null);

        // LLM 映射
        var userPrompt = BuildImportUserPrompt(template, markdownContent, weekYear, weekNumber);
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ReportAgent.Import.Markdown,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = GatewayImportSystemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                },
                ["temperature"] = 0.2,
                ["max_tokens"] = 4096
            },
            Context = new GatewayRequestContext { UserId = userId }
        };

        var response = await _gateway.SendAsync(request, CancellationToken.None);

        List<WeeklyReportSection>? mappedSections = null;
        string? primaryFailureReason = null;

        if (!response.Success)
        {
            primaryFailureReason = string.IsNullOrWhiteSpace(response.ErrorMessage)
                ? "AI 映射失败，已启用规则兜底"
                : $"AI 映射失败：{response.ErrorMessage}";
            _logger.LogWarning(
                "Markdown 导入 LLM 调用失败: userId={UserId}, errorCode={ErrorCode}, error={Error}",
                userId, response.ErrorCode, response.ErrorMessage);
        }
        else if (string.IsNullOrWhiteSpace(response.Content))
        {
            primaryFailureReason = "AI 返回空内容，已启用规则兜底";
            _logger.LogWarning("Markdown 导入 LLM 返回空内容: userId={UserId}, logId={LogId}", userId, response.LogId);
        }
        else
        {
            mappedSections = ParseImportedSections(response.Content, template);
            if (mappedSections == null || CountGeneratedItems(mappedSections) <= 0)
            {
                primaryFailureReason = "AI 返回结构异常，已启用规则兜底";
                _logger.LogWarning(
                    "Markdown 导入 LLM 解析失败: userId={UserId}, logId={LogId}, preview={Preview}",
                    userId, response.LogId, Preview(response.Content));
                mappedSections = null;
            }
        }

        var usedRuleFallback = false;
        string? importError = null;
        if (mappedSections == null)
        {
            // _markdownParser 注入用于未来扩展（如高级结构解析），当前 fallback 依赖简单 heading 切分
            _ = _markdownParser;
            mappedSections = BuildFallbackFromMarkdown(markdownContent, template);
            usedRuleFallback = true;
            importError = primaryFailureReason;
        }

        // Upsert
        var generatedAt = DateTime.UtcNow;
        var modelId = usedRuleFallback ? null : response.Resolution?.ActualModel;
        var platformId = usedRuleFallback ? null : response.Resolution?.ActualPlatformId;
        const string autoGeneratedBy = "markdown-import";

        if (existing != null)
        {
            var update = Builders<WeeklyReport>.Update
                .Set(x => x.Sections, mappedSections)
                .Set(x => x.TemplateId, templateId)
                .Set(x => x.AutoGeneratedAt, generatedAt)
                .Set(x => x.AutoGeneratedBy, autoGeneratedBy)
                .Set(x => x.AutoGeneratedModelId, modelId)
                .Set(x => x.AutoGeneratedPlatformId, platformId)
                .Set(x => x.UpdatedAt, generatedAt);
            await _db.WeeklyReports.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
            existing.Sections = mappedSections;
            existing.TemplateId = templateId;
            existing.AutoGeneratedAt = generatedAt;
            existing.AutoGeneratedBy = autoGeneratedBy;
            existing.AutoGeneratedModelId = modelId;
            existing.AutoGeneratedPlatformId = platformId;
            existing.UpdatedAt = generatedAt;
            return new ImportMarkdownResult(existing, importError, usedRuleFallback, modelId, platformId, NeedsOverwriteConfirmation: false);
        }

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(CancellationToken.None);
        var report = new WeeklyReport
        {
            UserId = userId,
            UserName = user?.DisplayName,
            AvatarFileName = user?.AvatarFileName,
            TeamId = teamId,
            TeamName = team.Name,
            TemplateId = templateId,
            WeekYear = weekYear,
            WeekNumber = weekNumber,
            PeriodStart = monday,
            PeriodEnd = sunday,
            Status = WeeklyReportStatus.Draft,
            Sections = mappedSections,
            AutoGeneratedAt = generatedAt,
            AutoGeneratedBy = autoGeneratedBy,
            AutoGeneratedModelId = modelId,
            AutoGeneratedPlatformId = platformId
        };

        try
        {
            await _db.WeeklyReports.InsertOneAsync(report, cancellationToken: CancellationToken.None);
        }
        catch (MongoDB.Driver.MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            var fetched = await _db.WeeklyReports.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
            return new ImportMarkdownResult(fetched ?? report, importError, usedRuleFallback, modelId, platformId, NeedsOverwriteConfirmation: false);
        }

        return new ImportMarkdownResult(report, importError, usedRuleFallback, modelId, platformId, NeedsOverwriteConfirmation: false);
    }

    /// <summary>
    /// 构建导入场景的 user prompt — 按 inputType 嵌入 JSON schema 片段，明确 issue-list 留空规则。
    /// </summary>
    internal static string BuildImportUserPrompt(
        ReportTemplate template,
        string markdownContent,
        int weekYear, int weekNumber)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"## 周报周期: {weekYear} 年第 {weekNumber} 周");
        sb.AppendLine();
        sb.AppendLine("## 模板结构（请严格按此顺序输出 JSON，sections 数组长度必须与以下板块数量一致）");
        sb.AppendLine("输出格式: { \"sections\": [ { \"items\": [ ... ] } ] }");
        sb.AppendLine();

        for (var i = 0; i < template.Sections.Count; i++)
        {
            var section = template.Sections[i];
            sb.AppendLine($"### 板块 {i + 1}: {section.Title}");
            if (!string.IsNullOrEmpty(section.Description))
                sb.AppendLine($"填写指引: {section.Description}");
            sb.AppendLine($"输入类型: {section.InputType}");
            if (!string.IsNullOrEmpty(section.SectionType))
                sb.AppendLine($"板块类型: {section.SectionType}");
            if (section.MaxItems.HasValue)
                sb.AppendLine($"最多条目: {section.MaxItems}");

            // 按 inputType 给 LLM 明确的 item JSON schema
            switch (section.InputType)
            {
                case "key-value":
                    sb.AppendLine("item 结构: { \"content\": \"<指标名>\", \"sourceRef\": \"<数值或文本值>\", \"source\": \"markdown-import\" }");
                    sb.AppendLine("说明: 每个 item 表示一条 key-value，key 写 content 字段，value 写 sourceRef 字段。");
                    break;
                case "progress-table":
                    sb.AppendLine("item 结构: { \"content\": \"<任务/里程碑名>\", \"sourceRef\": \"<进度描述，如 80%>\", \"source\": \"markdown-import\" }");
                    break;
                case "issue-list":
                    sb.AppendLine("item 结构: { \"content\": \"<问题/需求描述>\", \"source\": \"markdown-import\", \"issueCategoryKey\": null, \"issueStatusKey\": null, \"imageUrls\": null }");
                    sb.AppendLine("⚠ 硬规则: issueCategoryKey 和 issueStatusKey 必须留 null，由用户在界面中手动补充；不允许硬猜。");
                    if (section.IssueCategories is { Count: > 0 })
                        sb.AppendLine("可选分类（仅供参考，不要写进 JSON）: " + string.Join(", ", section.IssueCategories.Select(c => c.Label)));
                    if (section.IssueStatuses is { Count: > 0 })
                        sb.AppendLine("可选状态（仅供参考，不要写进 JSON）: " + string.Join(", ", section.IssueStatuses.Select(s => s.Label)));
                    break;
                case "rich-text":
                case "free-text":
                    sb.AppendLine("item 结构: { \"content\": \"<段落文本，可含 markdown>\", \"source\": \"markdown-import\" }");
                    sb.AppendLine("说明: 可保留 markdown 语法，建议整段内容放 1 条 item。");
                    break;
                case "bullet-list":
                default:
                    sb.AppendLine("item 结构: { \"content\": \"<条目文本>\", \"source\": \"markdown-import\" }");
                    sb.AppendLine("说明: 每个列表项一个 item。");
                    break;
            }
            sb.AppendLine();
        }

        sb.AppendLine("## 用户上传的 Markdown 周报");
        sb.AppendLine("<<<MARKDOWN");
        sb.AppendLine(markdownContent);
        sb.AppendLine("MARKDOWN>>>");
        sb.AppendLine();
        sb.AppendLine("## 映射要求");
        sb.AppendLine("1. 逐段读取上传 markdown，按标题/内容语义判断归属到哪个模板板块。");
        sb.AppendLine("2. 如果某段 markdown 内容无法对应任何板块，请归入第一个 free-text / rich-text 板块（若都没有则丢弃）。");
        sb.AppendLine("3. 禁止编造任何 markdown 中没有出现的内容或数值。");
        sb.AppendLine("4. 所有 item 的 source 字段必须固定为 \"markdown-import\"。");
        sb.AppendLine("5. 对 issue-list 板块，issueCategoryKey 和 issueStatusKey 必须是 JSON null，不要猜测值。");
        sb.AppendLine("6. sections 数组长度必须与模板板块数量一致，顺序保持不变；空板块请输出 items: []。");

        return sb.ToString();
    }

    /// <summary>
    /// 解析导入场景的 LLM JSON 响应 — 比 ParseGeneratedSections 多提取 sourceRef / issueCategoryKey / issueStatusKey / imageUrls。
    /// </summary>
    private List<WeeklyReportSection>? ParseImportedSections(string content, ReportTemplate template)
    {
        try
        {
            var normalized = NormalizeGatewayContent(content);
            var json = ExtractJson(normalized);
            if (string.IsNullOrEmpty(json)) return null;

            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("sections", out var sectionsElement)
                || sectionsElement.ValueKind != JsonValueKind.Array)
                return null;

            var sections = new List<WeeklyReportSection>();
            var sectionIdx = 0;
            foreach (var sectionJson in sectionsElement.EnumerateArray())
            {
                var templateSection = sectionIdx < template.Sections.Count
                    ? template.Sections[sectionIdx]
                    : new ReportTemplateSection { Title = $"板块 {sectionIdx + 1}" };

                var items = new List<WeeklyReportItem>();
                if (sectionJson.TryGetProperty("items", out var itemsArray)
                    && itemsArray.ValueKind == JsonValueKind.Array)
                {
                    foreach (var itemJson in itemsArray.EnumerateArray())
                    {
                        var item = ParseImportedItem(itemJson, templateSection.InputType);
                        if (item != null)
                            items.Add(item);
                    }
                }

                sections.Add(new WeeklyReportSection
                {
                    TemplateSection = templateSection,
                    Items = items
                });
                sectionIdx++;
            }

            while (sections.Count < template.Sections.Count)
            {
                sections.Add(new WeeklyReportSection
                {
                    TemplateSection = template.Sections[sections.Count],
                    Items = new()
                });
            }

            return sections;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "解析 Markdown 导入 LLM 响应失败");
            return null;
        }
    }

    private static WeeklyReportItem? ParseImportedItem(JsonElement itemJson, string inputType)
    {
        string? contentText = null;
        string? sourceRef = null;

        switch (itemJson.ValueKind)
        {
            case JsonValueKind.String:
                contentText = itemJson.GetString();
                break;
            case JsonValueKind.Object:
                if (itemJson.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String)
                    contentText = c.GetString();
                else if (itemJson.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                    contentText = t.GetString();
                if (itemJson.TryGetProperty("sourceRef", out var sr) && sr.ValueKind == JsonValueKind.String)
                    sourceRef = sr.GetString();
                break;
            default:
                return null;
        }
        if (string.IsNullOrWhiteSpace(contentText))
            return null;

        var item = new WeeklyReportItem
        {
            Content = contentText,
            Source = MarkdownImportSourceKey,
            SourceRef = sourceRef
        };

        // issue-list 专用字段 — 即便 LLM 违规猜了也忽略掉，强制 null
        if (inputType == "issue-list")
        {
            item.IssueCategoryKey = null;
            item.IssueStatusKey = null;
            item.ImageUrls = null;
        }

        return item;
    }

    /// <summary>
    /// 规则兜底：按 H1/H2 标题 normalize 后做包含匹配；未匹配 markdown 归入第一个 rich-text/free-text 章节。
    /// </summary>
    internal static List<WeeklyReportSection> BuildFallbackFromMarkdown(
        string markdownContent, ReportTemplate template)
    {
        var chunks = SplitMarkdownByHeadings(markdownContent);
        var sections = template.Sections
            .Select(t => new WeeklyReportSection { TemplateSection = t, Items = new() })
            .ToList();

        if (sections.Count == 0)
            return sections;

        var used = new HashSet<int>();
        for (var i = 0; i < sections.Count; i++)
        {
            var t = sections[i].TemplateSection;
            var normTitle = NormalizeHeading(t.Title);
            if (string.IsNullOrEmpty(normTitle)) continue;

            int bestIdx = -1;
            int bestScore = int.MaxValue;
            for (var j = 0; j < chunks.Count; j++)
            {
                if (used.Contains(j)) continue;
                var normChunk = NormalizeHeading(chunks[j].Title);
                if (string.IsNullOrEmpty(normChunk)) continue;
                if (normChunk.Contains(normTitle, StringComparison.Ordinal)
                    || normTitle.Contains(normChunk, StringComparison.Ordinal))
                {
                    bestIdx = j;
                    bestScore = 0;
                    break;
                }
                var d = LevenshteinDistance(normTitle, normChunk, 3);
                if (d < bestScore)
                {
                    bestScore = d;
                    bestIdx = j;
                }
            }

            if (bestIdx >= 0 && bestScore <= 3)
            {
                used.Add(bestIdx);
                sections[i].Items.AddRange(BuildItemsFromChunk(chunks[bestIdx].Body, t.InputType));
            }
        }

        // 未匹配的 chunk 归入第一个 rich-text / free-text 章节
        var leftover = chunks.Where((_, j) => !used.Contains(j)).ToList();
        if (leftover.Count > 0)
        {
            var targetIdx = sections.FindIndex(s =>
                s.TemplateSection.InputType == "rich-text" || s.TemplateSection.InputType == "free-text");
            if (targetIdx < 0)
                targetIdx = sections.Count - 1;
            if (targetIdx >= 0)
            {
                var combined = string.Join("\n\n",
                    leftover.Select(l => $"## {l.Title}\n{l.Body}".Trim()));
                if (!string.IsNullOrWhiteSpace(combined))
                {
                    sections[targetIdx].Items.AddRange(BuildItemsFromChunk(combined, sections[targetIdx].TemplateSection.InputType));
                }
            }
        }

        return sections;
    }

    private sealed record MarkdownChunk(string Title, string Body);

    private static List<MarkdownChunk> SplitMarkdownByHeadings(string markdown)
    {
        var lines = (markdown ?? string.Empty).Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
        var headingPattern = new System.Text.RegularExpressions.Regex(@"^(#{1,3})\s+(.+)$");
        var chunks = new List<MarkdownChunk>();
        string? currentTitle = null;
        var bodyLines = new List<string>();
        foreach (var line in lines)
        {
            var m = headingPattern.Match(line);
            if (m.Success)
            {
                if (currentTitle != null)
                    chunks.Add(new MarkdownChunk(currentTitle, string.Join("\n", bodyLines).Trim()));
                currentTitle = m.Groups[2].Value.Trim();
                bodyLines = new List<string>();
            }
            else if (currentTitle != null)
            {
                bodyLines.Add(line);
            }
        }
        if (currentTitle != null)
            chunks.Add(new MarkdownChunk(currentTitle, string.Join("\n", bodyLines).Trim()));
        return chunks;
    }

    private static List<WeeklyReportItem> BuildItemsFromChunk(string body, string inputType)
    {
        body = (body ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(body))
            return new();

        // rich-text / free-text → 整段作为 1 条 item 保留 markdown
        if (inputType == "rich-text" || inputType == "free-text")
        {
            return new()
            {
                new WeeklyReportItem { Content = body, Source = MarkdownImportSourceKey }
            };
        }

        // 其它类型 → 按列表行拆条
        var items = new List<WeeklyReportItem>();
        foreach (var rawLine in body.Split('\n'))
        {
            var line = rawLine.Trim();
            if (string.IsNullOrEmpty(line)) continue;
            var cleaned = System.Text.RegularExpressions.Regex.Replace(line, @"^[-*+]\s+|^\d+[.)]\s+|^>\s+", "").Trim();
            if (string.IsNullOrEmpty(cleaned)) continue;

            if (inputType == "key-value" || inputType == "progress-table")
            {
                var colonIdx = cleaned.IndexOfAny(new[] { ':', '：' });
                if (colonIdx > 0)
                {
                    items.Add(new WeeklyReportItem
                    {
                        Content = cleaned[..colonIdx].Trim(),
                        SourceRef = cleaned[(colonIdx + 1)..].Trim(),
                        Source = MarkdownImportSourceKey
                    });
                    continue;
                }
            }

            items.Add(new WeeklyReportItem
            {
                Content = cleaned,
                Source = MarkdownImportSourceKey
            });
        }
        return items;
    }

    /// <summary>
    /// 章节标题归一化 — 去 emoji、去符号、NFKC、lower，便于模糊匹配。
    /// </summary>
    internal static string NormalizeHeading(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;
        var normalized = text.Normalize(System.Text.NormalizationForm.FormKC);
        var sb = new System.Text.StringBuilder(normalized.Length);
        foreach (var c in normalized)
        {
            if (char.IsLetterOrDigit(c))
                sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

    /// <summary>
    /// Levenshtein 距离 — 早停优化：超过 maxDistance 即返回 maxDistance+1。
    /// </summary>
    internal static int LevenshteinDistance(string a, string b, int maxDistance)
    {
        if (a == b) return 0;
        if (string.IsNullOrEmpty(a)) return Math.Min(b.Length, maxDistance + 1);
        if (string.IsNullOrEmpty(b)) return Math.Min(a.Length, maxDistance + 1);
        if (Math.Abs(a.Length - b.Length) > maxDistance) return maxDistance + 1;

        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++) prev[j] = j;

        for (var i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            var rowMin = cur[0];
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                if (cur[j] < rowMin) rowMin = cur[j];
            }
            if (rowMin > maxDistance) return maxDistance + 1;
            (prev, cur) = (cur, prev);
        }
        return prev[b.Length];
    }

    // ═══════════════════════════════════════════════════════════════
    // v2.0 — Workflow Pipeline Generation
    // ═══════════════════════════════════════════════════════════════

    /// <summary>
    /// v2.0 生成：触发团队采集工作流 → 读 Artifact → 合并个人源 → 按成员拆分 → AI 生成
    /// </summary>
    public async Task<List<WeeklyReport>> GenerateForTeamV2Async(
        string teamId, int weekYear, int weekNumber, CancellationToken ct)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == teamId).FirstOrDefaultAsync(CancellationToken.None);
        if (team == null)
            throw new InvalidOperationException($"团队不存在: {teamId}");

        var members = await _db.ReportTeamMembers
            .Find(m => m.TeamId == teamId)
            .ToListAsync(CancellationToken.None);

        var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        var sunday = monday.AddDays(6).AddHours(23).AddMinutes(59).AddSeconds(59);

        // Step 1: 触发团队采集工作流（如果有绑定）
        TeamCollectedStats teamStats = new();
        string? executionId = null;

        if (!string.IsNullOrEmpty(team.DataCollectionWorkflowId))
        {
            try
            {
                var execution = await _workflowExecService.ExecuteInternalAsync(
                    team.DataCollectionWorkflowId,
                    new Dictionary<string, string>
                    {
                        ["weekYear"] = weekYear.ToString(),
                        ["weekNumber"] = weekNumber.ToString(),
                        ["dateFrom"] = monday.ToString("yyyy-MM-dd"),
                        ["dateTo"] = sunday.ToString("yyyy-MM-dd"),
                        ["teamId"] = teamId
                    },
                    triggeredBy: "report-agent-auto-generate",
                    ct: CancellationToken.None);

                var completed = await _workflowExecService.WaitForCompletionAsync(
                    execution.Id, TimeSpan.FromMinutes(5), CancellationToken.None);

                teamStats = ArtifactStatsParser.Parse(completed.FinalArtifacts);
                executionId = completed.Id;

                _logger.LogInformation("[ReportGenV2] Workflow completed for team {TeamId}: {Sources} sources, {ArtifactCount} artifacts",
                    teamId, teamStats.Sources.Count, completed.FinalArtifacts.Count);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[ReportGenV2] Workflow execution failed for team {TeamId}, proceeding with personal sources only", teamId);
            }
        }

        // Step 2: 按成员拆分团队数据
        var memberStatsMap = ArtifactStatsParser.SplitByMember(teamStats, members)
            .ToDictionary(m => m.UserId);

        // Step 3: 为每个成员生成周报
        var reports = new List<WeeklyReport>();
        foreach (var member in members)
        {
            try
            {
                var report = await GenerateForMemberV2Async(
                    member, team, weekYear, weekNumber, monday, sunday,
                    memberStatsMap.GetValueOrDefault(member.UserId),
                    executionId, ct);
                reports.Add(report);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[ReportGenV2] Failed to generate for member {UserId} in team {TeamId}",
                    member.UserId, teamId);
            }
        }

        return reports;
    }

    private async Task<WeeklyReport> GenerateForMemberV2Async(
        ReportTeamMember member, ReportTeam team,
        int weekYear, int weekNumber, DateTime monday, DateTime sunday,
        MemberCollectedStats? teamMemberStats, string? executionId,
        CancellationToken ct)
    {
        // 查找适用的模板
        var template = await FindTemplateAsync(team.Id, member.JobTitle, ct);
        if (template == null)
            throw new InvalidOperationException($"找不到适用的模板（团队={team.Id}，岗位={member.JobTitle}）");

        // 合并个人数据源
        var personalStats = await _personalSourceService.CollectAllAsync(member.UserId, monday, sunday, CancellationToken.None);

        // 同时采集 v1.0 的系统活动数据
        var activity = await _collector.CollectAsync(member.UserId, monday, sunday, CancellationToken.None);

        // 构建 v2.0 Prompt
        var promptPrefs = await LoadGenerationPromptPrefsAsync(member.UserId, ct);
        var userPrompt = BuildUserPromptV2(template, teamMemberStats, personalStats, activity, weekYear, weekNumber, promptPrefs.EffectivePrompt);

        // 调用 LLM
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ReportAgent.Generate.Draft,
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
            Context = new GatewayRequestContext { UserId = member.UserId }
        };

        var response = await _gateway.SendAsync(request, CancellationToken.None);

        List<WeeklyReportSection>? generatedSections = null;
        if (response.Success && !string.IsNullOrWhiteSpace(response.Content))
            generatedSections = ParseGeneratedSections(response.Content, template);
        var usedLlmResult = generatedSections != null && CountGeneratedItems(generatedSections) > 0;
        if (!usedLlmResult)
            generatedSections = null;

        if (generatedSections == null)
        {
            generatedSections = template.Sections.Select(s => new WeeklyReportSection
            {
                TemplateSection = s,
                Items = new()
            }).ToList();
        }

        // 构建 StatsSnapshot
        var snapshot = teamMemberStats?.ToSnapshot() ?? new Dictionary<string, object>();
        foreach (var ps in personalStats)
        {
            if (!snapshot.ContainsKey(ps.SourceType))
                snapshot[ps.SourceType] = ps.Summary;
        }

        // Upsert 周报
        var filter = Builders<WeeklyReport>.Filter.Eq(x => x.UserId, member.UserId)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.TeamId, team.Id)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.WeekYear, weekYear)
                   & Builders<WeeklyReport>.Filter.Eq(x => x.WeekNumber, weekNumber);

        var existing = await _db.WeeklyReports.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
        var generatedAt = DateTime.UtcNow;

        if (existing != null)
        {
            var update = Builders<WeeklyReport>.Update
                .Set(x => x.Sections, generatedSections)
                .Set(x => x.AutoGeneratedAt, generatedAt)
                .Set(x => x.AutoGeneratedBy, usedLlmResult ? "llm" : "rule-fallback")
                .Set(x => x.AutoGeneratedModelId, usedLlmResult ? response.Resolution?.ActualModel : null)
                .Set(x => x.AutoGeneratedPlatformId, usedLlmResult ? response.Resolution?.ActualPlatformId : null)
                .Set(x => x.WorkflowExecutionId, executionId)
                .Set(x => x.StatsSnapshot, snapshot)
                .Set(x => x.UpdatedAt, generatedAt);

            await _db.WeeklyReports.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
            existing.Sections = generatedSections;
            existing.AutoGeneratedAt = generatedAt;
            existing.StatsSnapshot = snapshot;
            existing.WorkflowExecutionId = executionId;
            existing.AutoGeneratedBy = usedLlmResult ? "llm" : "rule-fallback";
            existing.AutoGeneratedModelId = usedLlmResult ? response.Resolution?.ActualModel : null;
            existing.AutoGeneratedPlatformId = usedLlmResult ? response.Resolution?.ActualPlatformId : null;
            return existing;
        }

        var user = await _db.Users.Find(u => u.UserId == member.UserId).FirstOrDefaultAsync(CancellationToken.None);

        var report = new WeeklyReport
        {
            UserId = member.UserId,
            UserName = user?.DisplayName ?? member.UserName,
            AvatarFileName = user?.AvatarFileName ?? member.AvatarFileName,
            TeamId = team.Id,
            TeamName = team.Name,
            TemplateId = template.Id,
            WeekYear = weekYear,
            WeekNumber = weekNumber,
            PeriodStart = monday,
            PeriodEnd = sunday,
            Status = WeeklyReportStatus.Draft,
            Sections = generatedSections,
            AutoGeneratedAt = generatedAt,
            AutoGeneratedBy = usedLlmResult ? "llm" : "rule-fallback",
            AutoGeneratedModelId = usedLlmResult ? response.Resolution?.ActualModel : null,
            AutoGeneratedPlatformId = usedLlmResult ? response.Resolution?.ActualPlatformId : null,
            WorkflowExecutionId = executionId,
            StatsSnapshot = snapshot
        };

        try
        {
            await _db.WeeklyReports.InsertOneAsync(report, cancellationToken: CancellationToken.None);
        }
        catch (MongoDB.Driver.MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return await _db.WeeklyReports.Find(filter).FirstOrDefaultAsync(CancellationToken.None) ?? report;
        }

        return report;
    }

    private async Task<ReportTemplate?> FindTemplateAsync(string teamId, string? jobTitle, CancellationToken ct)
    {
        // 1. 团队 + 岗位特定模板
        if (!string.IsNullOrEmpty(jobTitle))
        {
            var specific = await _db.ReportTemplates
                .Find(t => t.TeamId == teamId && t.JobTitle == jobTitle)
                .FirstOrDefaultAsync(ct);
            if (specific != null) return specific;
        }

        // 2. 团队通用模板
        var teamTemplate = await _db.ReportTemplates
            .Find(t => t.TeamId == teamId && t.JobTitle == null)
            .FirstOrDefaultAsync(ct);
        if (teamTemplate != null) return teamTemplate;

        // 3. 系统默认模板
        return await _db.ReportTemplates
            .Find(t => t.IsDefault)
            .FirstOrDefaultAsync(ct);
    }

    internal static string BuildUserPromptV2(
        ReportTemplate template,
        MemberCollectedStats? teamStats,
        List<SourceStats> personalStats,
        CollectedActivity activity,
        int weekYear, int weekNumber,
        string effectivePrompt)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"## 周报周期: {weekYear} 年第 {weekNumber} 周");
        sb.AppendLine();
        sb.AppendLine("## 写作要求（生效 Prompt）");
        sb.AppendLine(effectivePrompt);
        sb.AppendLine();

        // 模板结构
        sb.AppendLine("## 模板结构（请严格按此结构输出 JSON）");
        sb.AppendLine("输出格式: { \"sections\": [ { \"items\": [ { \"content\": \"...\", \"source\": \"...\" } ] } ] }");
        sb.AppendLine("sections 数组长度必须与以下板块数量一致。");
        sb.AppendLine();

        for (var i = 0; i < template.Sections.Count; i++)
        {
            var section = template.Sections[i];
            var sectionType = section.SectionType ?? ReportSectionType.AutoList;
            sb.AppendLine($"### 板块 {i + 1}: {section.Title}");
            if (!string.IsNullOrEmpty(section.Description))
                sb.AppendLine($"填写指引: {section.Description}");
            sb.AppendLine($"输入类型: {section.InputType}");
            sb.AppendLine($"板块类型: {sectionType}");
            if (section.DataSources is { Count: > 0 })
                sb.AppendLine($"数据来源: {string.Join(", ", section.DataSources)}");
            if (section.MaxItems.HasValue)
                sb.AppendLine($"最多条目: {section.MaxItems}");

            // 指导 AI 如何处理不同板块类型
            switch (sectionType)
            {
                case ReportSectionType.AutoStats:
                    sb.AppendLine("⚡ 此板块为自动统计, 请用 key-value 格式输出统计数字 (content=指标名, sourceRef=数值)");
                    break;
                case ReportSectionType.AutoList:
                    sb.AppendLine("⚡ 此板块由 AI 归纳, 请将零散数据归纳为有意义的工作项, 每条不超过30字");
                    break;
                case ReportSectionType.ManualList:
                    sb.AppendLine("⚡ 此板块由用户手动填写, 请输出空 items 数组");
                    break;
                case ReportSectionType.FreeText:
                    sb.AppendLine("⚡ 此板块为自由文本, 请输出空 items 数组");
                    break;
            }
            sb.AppendLine();
        }

        // 采集数据 — 团队工作流数据
        sb.AppendLine("## 采集到的原始数据");
        sb.AppendLine();

        if (teamStats != null && teamStats.Sources.Count > 0)
        {
            sb.AppendLine("### 来自团队采集工作流的数据");
            foreach (var source in teamStats.Sources)
            {
                sb.AppendLine($"#### {source.SourceType} 统计");
                foreach (var kv in source.Summary)
                    sb.AppendLine($"- {kv.Key}: {kv.Value}");
                if (source.Details.Count > 0)
                {
                    sb.AppendLine("明细:");
                    foreach (var d in source.Details.Take(30))
                        sb.AppendLine($"- [{d.Type}] {d.Title}");
                }
                sb.AppendLine();
            }
        }

        // 个人数据源
        if (personalStats.Count > 0)
        {
            sb.AppendLine("### 来自个人数据源的数据");
            foreach (var source in personalStats)
            {
                sb.AppendLine($"#### {source.SourceType} 统计");
                foreach (var kv in source.Summary)
                    sb.AppendLine($"- {kv.Key}: {kv.Value}");
                if (source.Details.Count > 0)
                {
                    sb.AppendLine("明细:");
                    foreach (var d in source.Details.Take(30))
                        sb.AppendLine($"- [{d.Type}] {d.Title}");
                }
                sb.AppendLine();
            }
        }

        // v1.0 兼容数据
        if (activity.Commits.Count > 0)
        {
            sb.AppendLine("### Git 提交记录（团队数据源）");
            foreach (var c in activity.Commits.Take(50))
                sb.AppendLine($"- [{c.CommittedAt:MM-dd}] {c.Message}");
            sb.AppendLine($"总计: {activity.Commits.Count} 次提交, +{activity.Commits.Sum(c => c.Additions)} -{activity.Commits.Sum(c => c.Deletions)}");
            sb.AppendLine();
        }

        if (activity.DailyLogs.Count > 0)
        {
            sb.AppendLine("### 每日打点");
            foreach (var log in activity.DailyLogs)
            {
                sb.AppendLine($"#### {log.Date:yyyy-MM-dd}");
                foreach (var item in log.Items)
                {
                    var dur = item.DurationMinutes.HasValue ? $" ({item.DurationMinutes}min)" : "";
                    sb.AppendLine($"- [{item.Category}] {item.Content}{dur}");
                }
            }
            sb.AppendLine();
        }

        var hasAnySystemStats = activity.PrdSessions > 0 || activity.PrdMessageCount > 0
            || activity.DefectsSubmitted > 0 || activity.VisualSessions > 0
            || activity.ImageGenCompletedCount > 0 || activity.VideoGenCompletedCount > 0
            || activity.DocumentEditCount > 0 || activity.WorkflowExecutionCount > 0
            || activity.ToolboxRunCount > 0 || activity.WebPagePublishCount > 0
            || activity.AttachmentUploadCount > 0 || activity.LlmCalls > 0;

        if (hasAnySystemStats)
        {
            sb.AppendLine("### 系统活动统计");
            if (activity.PrdSessions > 0)
                sb.AppendLine($"- PRD 对话会话: {activity.PrdSessions} 次");
            if (activity.PrdMessageCount > 0)
                sb.AppendLine($"- PRD 对话消息: {activity.PrdMessageCount} 条");
            if (activity.DefectsSubmitted > 0)
            {
                sb.AppendLine($"- 缺陷提交: {activity.DefectsSubmitted} 个");
                if (activity.DefectDetails is { Resolved: > 0 })
                    sb.AppendLine($"  · 已解决 {activity.DefectDetails.Resolved} 个，平均 {activity.DefectDetails.AvgResolutionHours} 小时");
            }
            if (activity.VisualSessions > 0)
                sb.AppendLine($"- 视觉创作会话: {activity.VisualSessions} 次");
            if (activity.ImageGenCompletedCount > 0)
                sb.AppendLine($"- 图片生成完成: {activity.ImageGenCompletedCount} 次");
            if (activity.VideoGenCompletedCount > 0)
                sb.AppendLine($"- 视频生成完成: {activity.VideoGenCompletedCount} 次");
            if (activity.DocumentEditCount > 0)
                sb.AppendLine($"- 创建 PRD 项目: {activity.DocumentEditCount} 个");
            if (activity.WorkflowExecutionCount > 0)
                sb.AppendLine($"- 自动化工作流执行: {activity.WorkflowExecutionCount} 次");
            if (activity.ToolboxRunCount > 0)
                sb.AppendLine($"- AI 工具箱使用: {activity.ToolboxRunCount} 次");
            if (activity.WebPagePublishCount > 0)
                sb.AppendLine($"- 网页发布/更新: {activity.WebPagePublishCount} 次");
            if (activity.AttachmentUploadCount > 0)
                sb.AppendLine($"- 附件上传: {activity.AttachmentUploadCount} 个");
            if (activity.LlmCalls > 0)
                sb.AppendLine($"- AI 调用: {activity.LlmCalls} 次");
            sb.AppendLine();
        }
        sb.AppendLine("请基于以上数据生成周报，source 可选值: map-platform / github / yuque / daily-log / ai");
        sb.AppendLine("严格约束：");
        sb.AppendLine("1. 只基于采集到的原始数据和统计数值生成内容，禁止凭空编造。");
        sb.AppendLine("2. 不要把指标名称改写成其他活动（如把「创建 PRD 项目」写成「编辑 N 篇文档」）。");
        sb.AppendLine("3. 指标数值必须与采集结果完全一致，禁止凑整、放大或捏造修饰语。");
        sb.AppendLine("4. 如果某个板块确实没有数据支撑，请输出空 items 数组，禁止用「无数据」「待补充」等占位文本。");

        return sb.ToString();
    }
}
