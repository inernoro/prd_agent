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

    // ── 工具方法 ──

    private async Task<(string content, string? error)> StreamAndAccumulateAsync(
        GatewayRequest request,
        Func<string, Task>? onContent,
        Func<string, Task>? onThinking)
    {
        var buffer = new StringBuilder();
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Error)
                    return (buffer.ToString(), $"LLM 流式失败: {chunk.Error ?? "未知错误"}");

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
