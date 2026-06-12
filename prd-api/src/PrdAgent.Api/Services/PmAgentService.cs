using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 项目管理智能体服务 — AI 需求拆解引擎。
///
/// 核心理念：
/// - AI 提案，人类拍板：拆解结果不直接落库，先流式返回草稿供用户确认
/// - 可追溯：每个任务带 SourceRef，标明源自业务目标/需求文档哪一段
/// - 结构化：输出带优先级、工时、依赖关系，而非扁平 todo
/// </summary>
public class PmAgentService
{
    private readonly ILlmGateway _gateway;
    private readonly ILogger<PmAgentService> _logger;

    public PmAgentService(ILlmGateway gateway, ILogger<PmAgentService> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    /// <summary>
    /// 将项目业务目标 + 可选需求文本拆解为任务草稿（一维，不落库）。
    /// </summary>
    /// <param name="onContent">LLM 流式增量文本回调（透传 typing 事件，消除空白等待）</param>
    /// <param name="onThinking">LLM 思考流回调（透传 thinking 事件）</param>
    public async IAsyncEnumerable<PmTaskDraft> DecomposeAsync(
        PmProject project,
        string? requirementText,
        string userId,
        Action<string>? onError = null,
        Func<string, Task>? onContent = null,
        Func<string, Task>? onThinking = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var systemPrompt = BuildDecomposeSystemPrompt(project);
        var userMessage = BuildDecomposeUserMessage(project, requirementText);

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectManagement.Decompose.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userMessage }
                },
                ["temperature"] = 0.5,
                // 让推理模型实时回传思考内容，避免首字长时间空白（见 .claude/rules/llm-gateway.md）
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 120,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };

        _logger.LogInformation("[pm-agent] Decompose: streaming LLM for project {ProjectId}", project.Id);
        var (fullContent, streamError) = await StreamAndAccumulateAsync(request, onContent, onThinking);
        if (streamError != null)
        {
            onError?.Invoke(streamError);
            yield break;
        }
        if (string.IsNullOrWhiteSpace(fullContent))
        {
            onError?.Invoke("LLM 返回空内容（模型响应为空）");
            yield break;
        }

        var drafts = ParseDrafts(fullContent);
        foreach (var draft in drafts)
            yield return draft;
    }

    // ── Prompt 构建 ──

    private static string BuildDecomposeSystemPrompt(PmProject project)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一个资深项目经理，擅长把项目业务目标拆解为可执行的任务清单。");
        sb.AppendLine("遵循「价值导向」原则：任务必须服务于项目业务目标，避免为做而做。");
        sb.AppendLine();
        sb.AppendLine("## 拆解原则");
        sb.AppendLine("1. 每个任务可独立交付、可验收，粒度适中（0.5-5 人天为宜）");
        sb.AppendLine("2. 标注优先级、预估工时、前置依赖关系");
        sb.AppendLine("3. 有明确先后顺序的任务，用 dependsOnTitles 声明依赖（必须是本次输出里其他任务的确切标题）");
        sb.AppendLine("4. 每个任务标注 sourceRef —— 源自业务目标/需求文档的哪一段（可追溯，不可编造）");
        sb.AppendLine("5. 任务数量控制在 5-12 个，过多则归并");
        sb.AppendLine();
        sb.AppendLine("## 输出格式（严格 JSON 数组，只输出 JSON）");
        sb.AppendLine("```json");
        sb.AppendLine("[{");
        sb.AppendLine("  \"title\": \"任务标题（简洁，6-16 字）\",");
        sb.AppendLine("  \"description\": \"任务说明（一句话讲清交付物）\",");
        sb.AppendLine("  \"priority\": \"urgent|high|medium|low|none\",");
        sb.AppendLine("  \"estimateDays\": 2,");
        sb.AppendLine("  \"dependsOnTitles\": [\"前置任务的确切标题\"],");
        sb.AppendLine("  \"sourceRef\": \"源自业务目标：'XXX'\",");
        sb.AppendLine("  \"labels\": [\"标签\"]");
        sb.AppendLine("}]");
        sb.AppendLine("```");
        sb.AppendLine("无依赖的任务 dependsOnTitles 传 []。只输出 JSON 数组，不要任何额外说明。");
        return sb.ToString();
    }

    private static string BuildDecomposeUserMessage(PmProject project, string? requirementText)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"请拆解以下项目，生成可执行任务清单。");
        sb.AppendLine();
        sb.AppendLine($"项目名称：{project.Title}");
        if (!string.IsNullOrWhiteSpace(project.Description))
            sb.AppendLine($"项目描述：{project.Description}");
        sb.AppendLine($"业务目标：{project.BusinessGoal}");
        if (!string.IsNullOrWhiteSpace(requirementText))
        {
            var trimmed = requirementText.Trim();
            sb.AppendLine();
            sb.AppendLine("需求文档/补充材料：");
            sb.AppendLine(trimmed.Length > 6000 ? trimmed[..6000] + "\n...(已截取)" : trimmed);
        }
        return sb.ToString();
    }

    // ── 响应解析 ──

    private static List<PmTaskDraft> ParseDrafts(string content)
    {
        var drafts = new List<PmTaskDraft>();
        try
        {
            var json = ExtractJsonArray(content);
            if (json == null) return drafts;

            foreach (var item in json)
            {
                if (item is not JsonObject obj) continue;
                drafts.Add(new PmTaskDraft
                {
                    Title = obj["title"]?.GetValue<string>() ?? "未命名任务",
                    Description = obj["description"]?.GetValue<string>(),
                    Priority = NormalizePriority(obj["priority"]?.GetValue<string>()),
                    EstimateDays = GetDoubleValue(obj, "estimateDays"),
                    DependsOnTitles = GetStringArray(obj, "dependsOnTitles"),
                    SourceRef = obj["sourceRef"]?.GetValue<string>(),
                    Labels = GetStringArray(obj, "labels"),
                });
            }
        }
        catch (Exception)
        {
            // 解析失败返回空列表，不阻断流程
        }
        return drafts;
    }

    private static string NormalizePriority(string? raw)
    {
        var p = raw?.Trim().ToLowerInvariant();
        return PmTaskPriority.All.Contains(p) ? p! : PmTaskPriority.Medium;
    }

    // ── AI 结案报告 ──

    /// <summary>基于项目执行数据摘要流式生成 Markdown 结案报告（不落库，前端审核后存知识库）。</summary>
    public async Task<string?> GenerateClosureReportAsync(
        PmProject project, string statsSummary, string userId,
        Func<string, Task>? onContent, Func<string, Task>? onThinking, Action<string>? onError)
    {
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectManagement.ClosureReport.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildClosureReportSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = statsSummary }
                },
                ["temperature"] = 0.5,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 180,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };
        var (full, err) = await StreamAndAccumulateAsync(request, onContent, onThinking);
        if (err != null) { onError?.Invoke(err); return null; }
        return full;
    }

    private static string BuildClosureReportSystemPrompt()
        => "你是资深项目管理专家，正在为一个已结案的项目撰写【结案报告】。基于用户提供的项目执行数据"
         + "（业务目标、目标达成、里程碑、任务完成、成本、NPSS 评价、风险、关键决策等），输出一份结构化 Markdown 结案报告。"
         + "结构：## 一、项目概述 / ## 二、目标达成情况 / ## 三、关键里程碑与交付 / ## 四、数据回顾（任务·进度·成本）/ "
         + "## 五、干系人评价(NPSS) / ## 六、经验与不足 / ## 七、后续建议。客观、具体、可追溯，避免空话套话。只输出 Markdown 正文。";

    // ── AI 项目健康诊断 ──

    /// <summary>基于在管项目实时数据摘要流式生成 Markdown 健康诊断（不落库，前端审核后可存知识库）。</summary>
    public async Task<string?> DiagnoseHealthAsync(
        PmProject project, string statsSummary, string userId,
        Func<string, Task>? onContent, Func<string, Task>? onThinking, Action<string>? onError)
    {
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectManagement.HealthDiagnosis.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildHealthDiagnosisSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = statsSummary }
                },
                ["temperature"] = 0.4,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 180,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };
        var (full, err) = await StreamAndAccumulateAsync(request, onContent, onThinking);
        if (err != null) { onError?.Invoke(err); return null; }
        return full;
    }

    // ── AI 项目简报 ──

    /// <summary>基于项目实时数据摘要生成结构化简报内容（JSON），由调用方渲染进固定 HTML 模板。
    /// onModel 回传实际调度到的模型名（落库 + 前端可见，规则 ai-model-visibility）。</summary>
    public async Task<PmBriefingAiContent?> GenerateBriefingAsync(
        PmProject project, string statsSummary, string userId,
        Func<string, Task>? onContent, Func<string, Task>? onThinking, Action<string>? onError, Action<string>? onModel = null,
        string? userNote = null)
    {
        var userMessage = string.IsNullOrWhiteSpace(userNote)
            ? statsSummary
            : statsSummary + "\n\n用户补充要求（优先满足，但不得编造数据）：" + userNote.Trim();
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectManagement.Briefing.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildBriefingSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = userMessage }
                },
                ["temperature"] = 0.4,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 180,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };
        var (full, err) = await StreamAndAccumulateAsync(request, onContent, onThinking, onModel);
        if (err != null) { onError?.Invoke(err); return null; }
        if (string.IsNullOrWhiteSpace(full)) { onError?.Invoke("LLM 返回空内容（模型响应为空）"); return null; }
        var parsed = ParseBriefingContent(full);
        if (parsed == null) onError?.Invoke("简报内容解析失败（LLM 未按 JSON 格式输出）");
        return parsed;
    }

    /// <summary>按用户自然语言意图改写既有简报内容：硬数据摘要 + 原结构化内容 + 调整要求 → 重新产出同 JSON 格式内容（数字以硬数据为准，不得编造）。</summary>
    public async Task<PmBriefingAiContent?> RefineBriefingAsync(
        PmProject project, string dataSummary, string previousContentJson, string instruction, string userId,
        Func<string, Task>? onContent, Func<string, Task>? onThinking, Action<string>? onError, Action<string>? onModel = null)
    {
        var sb = new StringBuilder();
        sb.AppendLine("以下是该项目的硬数据摘要（数字以此为准，不得编造）：");
        sb.AppendLine(dataSummary);
        sb.AppendLine();
        sb.AppendLine("以下是当前简报的结构化内容（JSON）：");
        sb.AppendLine(previousContentJson);
        sb.AppendLine();
        sb.AppendLine("用户对当前内容不满意，调整要求如下，请在保持事实准确的前提下按要求改写，输出同格式 JSON：");
        sb.AppendLine(instruction.Trim());

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectManagement.Briefing.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildBriefingSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = sb.ToString() }
                },
                ["temperature"] = 0.4,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 180,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };
        var (full, err) = await StreamAndAccumulateAsync(request, onContent, onThinking, onModel);
        if (err != null) { onError?.Invoke(err); return null; }
        if (string.IsNullOrWhiteSpace(full)) { onError?.Invoke("LLM 返回空内容（模型响应为空）"); return null; }
        var parsed = ParseBriefingContent(full);
        if (parsed == null) onError?.Invoke("简报内容解析失败（LLM 未按 JSON 格式输出）");
        return parsed;
    }

    private static string BuildBriefingSystemPrompt()
        => "你是资深项目经理，正在为项目干系人（领导/客户/协作团队）撰写一份对外【项目简报】。"
         + "基于用户提供的项目实时数据（业务目标、目标与 KR、里程碑健康、任务完成、风险、近期周报），提炼出干系人最关心的信息。"
         + "语言克制、专业、基于事实，引用真实数据，不空话不夸大。禁止使用任何 emoji 字符。"
         + "输出严格 JSON（只输出 JSON，不要任何额外说明、不要 markdown 代码围栏之外的文字）：\n"
         + "{\n"
         + "  \"summary\": \"项目整体进展摘要，2-4 句，给没时间看细节的领导\",\n"
         + "  \"status\": \"on_track|at_risk|off_track\",\n"
         + "  \"statusNote\": \"一句话状态判定依据\",\n"
         + "  \"highlights\": [\"本期进展亮点，3-6 条，每条一句话，可引用数据\"],\n"
         + "  \"risks\": [{\"text\": \"风险/问题描述及影响\", \"level\": \"high|medium|low\"}],\n"
         + "  \"nextSteps\": [\"下一步计划，2-5 条，具体可验收\"]\n"
         + "}";

    private static PmBriefingAiContent? ParseBriefingContent(string content)
    {
        try
        {
            var start = content.IndexOf('{');
            var end = content.LastIndexOf('}');
            if (start < 0 || end <= start) return null;
            var obj = JsonSerializer.Deserialize<JsonObject>(content[start..(end + 1)]);
            if (obj == null) return null;
            var result = new PmBriefingAiContent
            {
                Summary = obj["summary"]?.GetValue<string>() ?? string.Empty,
                Status = obj["status"]?.GetValue<string>() ?? "on_track",
                StatusNote = obj["statusNote"]?.GetValue<string>() ?? string.Empty,
            };
            if (obj["highlights"] is JsonArray hs)
                foreach (var h in hs) { var v = h?.GetValue<string>(); if (!string.IsNullOrWhiteSpace(v)) result.Highlights.Add(v); }
            if (obj["risks"] is JsonArray rs)
                foreach (var r in rs)
                {
                    if (r is not JsonObject ro) continue;
                    var text = ro["text"]?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(text)) continue;
                    result.Risks.Add(new PmBriefingRisk { Text = text, Level = ro["level"]?.GetValue<string>() ?? "medium" });
                }
            if (obj["nextSteps"] is JsonArray ns)
                foreach (var n in ns) { var v = n?.GetValue<string>(); if (!string.IsNullOrWhiteSpace(v)) result.NextSteps.Add(v); }
            return string.IsNullOrWhiteSpace(result.Summary) ? null : result;
        }
        catch
        {
            return null;
        }
    }

    private static string BuildHealthDiagnosisSystemPrompt()
        => "你是资深项目管理顾问（PMO），正在为一个【进行中】的项目做健康诊断（注意：不是结案总结，而是发现当前问题、给出可立即执行的纠偏建议）。"
         + "基于用户提供的项目实时数据（进度、逾期任务、里程碑健康、风险概率×影响分布、未决决策、预算使用、计划周期、最近周报趋势），输出结构化 Markdown 诊断。"
         + "结构：## 一、健康总评（先给一句结论 + 评级：健康 / 需关注 / 高危，并说明判定依据）/ "
         + "## 二、关键风险信号（按严重度排序，逐条说明现象→影响→根因推测）/ "
         + "## 三、进度与里程碑诊断 / ## 四、风险与决策诊断（含长期未决的待决策事项）/ "
         + "## 五、立即行动建议（3-6 条，每条给出建议负责角色与优先级，可落地、可验收）。"
         + "诊断要尖锐、具体、对事不对人，引用真实数据佐证，避免空话套话与无依据的乐观。只输出 Markdown 正文。";

    // ── 工具方法 ──

    /// <summary>带自动重试的流式调用：上游偶发 401/超时（如模型池中某平台密钥失效返回
    /// "No cookie auth credentials found"）时，在尚无任何产出的前提下重试 —— 每次重试都重新走
    /// 模型解析，有机会切换到池内健康平台。已有部分产出则不重试，避免内容重复。</summary>
    private async Task<(string content, string? error)> StreamAndAccumulateAsync(
        GatewayRequest request,
        Func<string, Task>? onContent,
        Func<string, Task>? onThinking,
        Action<string>? onModel = null)
    {
        const int maxAttempts = 3;
        string? lastError = null;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            var (content, error) = await StreamOnceAsync(request, onContent, onThinking, onModel);
            if (error == null) return (content, null);
            lastError = error;
            if (content.Length > 0) return (content, error);
            if (attempt < maxAttempts)
            {
                _logger.LogWarning("[pm-agent] LLM 流式失败（第 {Attempt}/{Max} 次）：{Error}，800ms 后重试",
                    attempt, maxAttempts, error);
                await Task.Delay(TimeSpan.FromMilliseconds(800));
            }
        }
        return (string.Empty, lastError);
    }

    private async Task<(string content, string? error)> StreamOnceAsync(
        GatewayRequest request,
        Func<string, Task>? onContent,
        Func<string, Task>? onThinking,
        Action<string>? onModel = null)
    {
        var buffer = new StringBuilder();
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Error)
                    return (buffer.ToString(), $"LLM 流式失败: {chunk.Error ?? "未知错误"}");

                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null && !string.IsNullOrEmpty(chunk.Resolution.ActualModel))
                {
                    try { onModel?.Invoke(chunk.Resolution.ActualModel); }
                    catch (Exception cbEx) { _logger.LogDebug(cbEx, "[pm-agent] onModel callback ignored"); }
                    continue;
                }

                if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (onThinking != null)
                    {
                        try { await onThinking(chunk.Content); }
                        catch (Exception cbEx) { _logger.LogDebug(cbEx, "[pm-agent] onThinking callback ignored"); }
                    }
                    continue;
                }
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    buffer.Append(chunk.Content);
                    if (onContent != null)
                    {
                        try { await onContent(chunk.Content); }
                        catch (Exception cbEx) { _logger.LogDebug(cbEx, "[pm-agent] onContent callback ignored"); }
                    }
                }
            }
            return (buffer.ToString(), null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[pm-agent] LLM stream failed: {Error}", ex.Message);
            return (buffer.ToString(), $"LLM 调用异常: {ex.Message}");
        }
    }

    private static JsonArray? ExtractJsonArray(string content)
    {
        var start = content.IndexOf('[');
        var end = content.LastIndexOf(']');
        if (start < 0 || end <= start) return null;
        var jsonStr = content[start..(end + 1)];
        return JsonSerializer.Deserialize<JsonArray>(jsonStr);
    }

    private static double? GetDoubleValue(JsonObject obj, string key)
    {
        if (obj.TryGetPropertyValue(key, out var node) && node != null)
        {
            try { return node.GetValue<double>(); }
            catch { return null; }
        }
        return null;
    }

    private static List<string> GetStringArray(JsonObject obj, string key)
    {
        if (obj.TryGetPropertyValue(key, out var node) && node is JsonArray arr)
        {
            return arr
                .Select(n => n?.GetValue<string>())
                .Where(s => !string.IsNullOrEmpty(s))
                .Select(s => s!)
                .ToList();
        }
        return new();
    }

    // ── AI 目标拆解（业务目标 → 目标/关键结果）──

    /// <summary>
    /// 拆解目标草稿（不落库，供前端确认后创建）。parentGoal 为 null 时依据项目业务目标拆顶层目标；
    /// 非 null 时把该父目标拆为更具体的子目标，ancestorChain 提供从顶到父的祖先上下文使「越深越具体」。
    /// </summary>
    public async IAsyncEnumerable<PmGoalDraft> DecomposeGoalsAsync(
        PmProject project,
        PmGoal? parentGoal,
        List<PmGoal> ancestorChain,
        string userId,
        Action<string>? onError = null,
        Func<string, Task>? onContent = null,
        Func<string, Task>? onThinking = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectManagement.GoalDecompose.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildGoalDecomposeSystemPrompt(parentGoal != null) },
                    new JsonObject { ["role"] = "user", ["content"] = BuildGoalDecomposeUserMessage(project, parentGoal, ancestorChain) }
                },
                ["temperature"] = 0.6,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 120,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };
        var (full, err) = await StreamAndAccumulateAsync(request, onContent, onThinking);
        if (err != null) { onError?.Invoke(err); yield break; }
        if (string.IsNullOrWhiteSpace(full)) { onError?.Invoke("LLM 返回空内容（模型响应为空）"); yield break; }
        foreach (var d in ParseGoalDrafts(full)) yield return d;
    }

    private static List<PmGoalDraft> ParseGoalDrafts(string content)
    {
        var list = new List<PmGoalDraft>();
        try
        {
            var json = ExtractJsonArray(content);
            if (json == null) return list;
            foreach (var item in json)
            {
                if (item is not JsonObject obj) continue;
                list.Add(new PmGoalDraft
                {
                    Title = obj["title"]?.GetValue<string>() ?? "未命名目标",
                    Description = obj["description"]?.GetValue<string>(),
                    Metric = obj["metric"]?.GetValue<string>(),
                    Period = obj["period"]?.GetValue<string>(),
                });
            }
        }
        catch (Exception) { /* 解析失败返回空，不阻断 */ }
        return list;
    }

    // ── AI 里程碑建议（业务目标/目标/任务 → 分阶段里程碑）──

    /// <summary>依据项目目标/任务/计划周期建议分阶段里程碑草稿（不落库，前端审核后批量创建）。</summary>
    public async IAsyncEnumerable<PmMilestoneDraft> SuggestMilestonesAsync(
        PmProject project,
        List<PmGoal> goals,
        List<string> taskTitles,
        string userId,
        Action<string>? onError = null,
        Func<string, Task>? onContent = null,
        Func<string, Task>? onThinking = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectManagement.MilestoneSuggest.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildMilestoneSuggestSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = BuildMilestoneSuggestUserMessage(project, goals, taskTitles) }
                },
                ["temperature"] = 0.5,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 120,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };
        var (full, err) = await StreamAndAccumulateAsync(request, onContent, onThinking);
        if (err != null) { onError?.Invoke(err); yield break; }
        if (string.IsNullOrWhiteSpace(full)) { onError?.Invoke("LLM 返回空内容（模型响应为空）"); yield break; }
        foreach (var d in ParseMilestoneDrafts(full)) yield return d;
    }

    private static string BuildMilestoneSuggestSystemPrompt()
        => "你是资深项目经理。请依据项目业务目标、团队目标、任务主题与计划周期，规划 4-8 个分阶段【里程碑】。"
         + "里程碑是阶段性关键交付/验收节点（不是任务），彼此应有清晰先后顺序。"
         + "每个里程碑给出：title(简洁，6-16 字)、description(该阶段交付什么/如何判定)、"
         + "acceptanceCriteria(2-4 条可验收的完成标准)、dueDate(若提供了计划周期则在周期内给 yyyy-MM-dd 且按先后顺序递增，没有周期则留空)。"
         + "严格只输出 JSON 数组，元素形如 {\"title\":\"\",\"description\":\"\",\"acceptanceCriteria\":[\"\",\"\"],\"dueDate\":\"2026-07-01\"}。"
         + "不要输出数组以外的任何文字。";

    private static string BuildMilestoneSuggestUserMessage(PmProject project, List<PmGoal> goals, List<string> taskTitles)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"项目名称：{project.Title}");
        sb.AppendLine($"业务目标：{project.BusinessGoal}");
        if (!string.IsNullOrWhiteSpace(project.Description)) sb.AppendLine($"项目描述：{project.Description}");
        if (project.PlannedStartAt.HasValue || project.PlannedEndAt.HasValue)
            sb.AppendLine($"计划周期：{project.PlannedStartAt:yyyy-MM-dd} ~ {project.PlannedEndAt:yyyy-MM-dd}");
        var teamGoals = goals.Where(g => g.Scope == PmGoalScope.Team).Take(12).ToList();
        if (teamGoals.Count > 0)
        {
            sb.AppendLine("团队目标：");
            foreach (var g in teamGoals) sb.AppendLine($"- {g.Title}{(string.IsNullOrWhiteSpace(g.Metric) ? "" : $"（指标 {g.Metric}）")}");
        }
        if (taskTitles.Count > 0)
        {
            sb.AppendLine("任务主题（节选）：");
            foreach (var t in taskTitles.Take(30)) sb.AppendLine($"- {t}");
        }
        sb.AppendLine("请据此规划 4-8 个分阶段里程碑，只输出 JSON 数组。");
        return sb.ToString();
    }

    private static List<PmMilestoneDraft> ParseMilestoneDrafts(string content)
    {
        var list = new List<PmMilestoneDraft>();
        try
        {
            var json = ExtractJsonArray(content);
            if (json == null) return list;
            foreach (var item in json)
            {
                if (item is not JsonObject obj) continue;
                list.Add(new PmMilestoneDraft
                {
                    Title = obj["title"]?.GetValue<string>() ?? "未命名里程碑",
                    Description = obj["description"]?.GetValue<string>(),
                    AcceptanceCriteria = GetStringArray(obj, "acceptanceCriteria"),
                    DueDate = obj["dueDate"]?.GetValue<string>(),
                });
            }
        }
        catch (Exception) { /* 解析失败返回空，不阻断 */ }
        return list;
    }

    private static string BuildGoalDecomposeSystemPrompt(bool isSubGoal)
    {
        var jsonShape = "{\"title\":\"目标标题\",\"description\":\"详细说明（落地思路/可行性）\",\"metric\":\"衡量指标/关键结果\",\"period\":\"周期(可选,如 2026 Q2)\"}";
        if (!isSubGoal)
            return "你是资深项目管理专家。请把项目的业务目标拆解为 3-6 个可量化的【目标/关键结果(OKR)】。"
                 + "每个目标聚焦结果而非动作，尽量可衡量。严格只输出 JSON 数组，元素形如：" + jsonShape + "。"
                 + "不要输出数组以外的任何文字。";
        return "你是资深项目管理专家。现在要把一个【上级目标】拆解为更具体、更可落地的 2-5 个【子目标/关键结果】。"
             + "要求：① 每深一层应更聚焦执行与可验证的结果，比上级更具体；② 探索不同的可行性路径，子目标之间尽量正交、可独立推进；"
             + "③ 不要重复上级目标的措辞，要往下细化一层；④ description 写清这个子目标的落地思路或可行性考量。"
             + "严格只输出 JSON 数组，元素形如：" + jsonShape + "。不要输出数组以外的任何文字。";
    }

    private static string BuildGoalDecomposeUserMessage(PmProject project, PmGoal? parentGoal, List<PmGoal> ancestorChain)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"项目名称：{project.Title}");
        sb.AppendLine($"业务目标（北极星）：{project.BusinessGoal}");
        if (!string.IsNullOrWhiteSpace(project.Description)) sb.AppendLine($"项目描述：{project.Description}");
        if (!string.IsNullOrWhiteSpace(project.StrategyAlignment)) sb.AppendLine($"战略对齐：{project.StrategyAlignment}");

        if (parentGoal == null)
        {
            sb.AppendLine("请据此拆解 3-6 个目标/关键结果，只输出 JSON 数组。");
            return sb.ToString();
        }

        // 子目标拆解：给出从顶到父的祖先链，让模型理解当前拆的是这条链最末端的目标
        if (ancestorChain.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("目标层级路径（从上到下）：");
            var level = 1;
            foreach (var a in ancestorChain)
            {
                var extra = string.IsNullOrWhiteSpace(a.Metric) ? "" : $"（指标：{a.Metric}）";
                sb.AppendLine($"  L{level}. {a.Title}{extra}");
                level++;
            }
            sb.AppendLine($"  L{level}.（待拆解的上级目标，见下）");
        }

        sb.AppendLine();
        sb.AppendLine("待拆解的上级目标：");
        sb.AppendLine($"  标题：{parentGoal.Title}");
        if (!string.IsNullOrWhiteSpace(parentGoal.Description)) sb.AppendLine($"  说明：{parentGoal.Description}");
        if (!string.IsNullOrWhiteSpace(parentGoal.Metric)) sb.AppendLine($"  指标：{parentGoal.Metric}");
        if (!string.IsNullOrWhiteSpace(parentGoal.Period)) sb.AppendLine($"  周期：{parentGoal.Period}");
        sb.AppendLine("请把上面这个上级目标拆解为更具体的 2-5 个子目标/关键结果，只输出 JSON 数组。");
        return sb.ToString();
    }
}

/// <summary>
/// AI 拆解出的任务草稿（不落库，供前端展示供用户确认后批量创建）。
/// </summary>
public class PmTaskDraft
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string Priority { get; set; } = PmTaskPriority.Medium;
    public double? EstimateDays { get; set; }
    /// <summary>依赖的前置任务标题（同批草稿内引用，落库时由前端/后端映射为 ID）</summary>
    public List<string> DependsOnTitles { get; set; } = new();
    public string? SourceRef { get; set; }
    public List<string> Labels { get; set; } = new();
}

/// <summary>AI 拆解出的目标草稿（不落库）。</summary>
public class PmGoalDraft
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Metric { get; set; }
    public string? Period { get; set; }
}

/// <summary>AI 生成的简报结构化内容（不直接落库，由 PmBriefingRenderer 渲染进 HTML 模板后落 PmBriefing）。</summary>
public class PmBriefingAiContent
{
    public string Summary { get; set; } = string.Empty;
    /// <summary>整体状态：on_track | at_risk | off_track</summary>
    public string Status { get; set; } = "on_track";
    public string StatusNote { get; set; } = string.Empty;
    public List<string> Highlights { get; set; } = new();
    public List<PmBriefingRisk> Risks { get; set; } = new();
    public List<string> NextSteps { get; set; } = new();
}

public class PmBriefingRisk
{
    public string Text { get; set; } = string.Empty;
    /// <summary>high | medium | low</summary>
    public string Level { get; set; } = "medium";
}

/// <summary>AI 建议的里程碑草稿（不落库，前端审核后批量创建）。</summary>
public class PmMilestoneDraft
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public List<string> AcceptanceCriteria { get; set; } = new();
    /// <summary>建议日期 yyyy-MM-dd（可空）</summary>
    public string? DueDate { get; set; }
}
