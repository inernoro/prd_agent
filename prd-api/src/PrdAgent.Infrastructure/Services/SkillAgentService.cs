using System.IO.Compression;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 技能引导 Agent 服务 — 用户描述意图后自动连跑 scope→draft→metadata→preview
/// </summary>
public class SkillAgentService
{
    private readonly ILlmGateway _gateway;
    private readonly ISkillService _skillService;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<SkillAgentService> _logger;

    public SkillAgentService(
        ILlmGateway gateway,
        ISkillService skillService,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<SkillAgentService> logger)
    {
        _gateway = gateway;
        _skillService = skillService;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    // ━━━ Stage Definitions ━━━━━━━━

    public static readonly string[] Stages = { "intent", "scope", "draft", "metadata", "preview" };

    // Stages that auto-advance without user input after intent is confirmed
    private static readonly string[] AutoRunStages = { "scope", "draft", "metadata", "preview" };

    public static string GetStageLabel(string stage) => stage switch
    {
        "intent" => "意图理解",
        "scope" => "范围界定",
        "draft" => "Prompt 草稿",
        "metadata" => "元数据补全",
        "preview" => "预览与导出",
        _ => "未知阶段"
    };

    // ━━━ Guided Conversation ━━━━━━━━

    /// <summary>
    /// 处理用户消息：Stage 1 需要对话；Stage 1 完成后自动连跑 2-5
    /// 如果用户在 preview 阶段提修改意见，回到 draft 阶段局部迭代后再自动连跑
    /// </summary>
    public async IAsyncEnumerable<SseChunk> ProcessMessageAsync(
        SkillAgentSession session,
        string userMessage,
        string userId)
    {
        // Record user message
        session.Messages.Add(new SkillAgentMessage("user", userMessage));

        // Run the current stage with user input
        var stageCompleted = false;
        await foreach (var chunk in RunSingleStageAsync(session, userMessage, userId))
        {
            yield return chunk;
            if (chunk.Event == "stage_complete") stageCompleted = true;
        }

        // If the current stage completed and next stage is auto-runnable, keep going
        if (stageCompleted && AutoRunStages.Contains(session.CurrentStage))
        {
            await foreach (var chunk in RunAutoStagesAsync(session, userId))
            {
                yield return chunk;
            }
        }

        // Final done event with full state
        yield return new SseChunk("done", new
        {
            currentStage = session.CurrentStage,
            stageLabel = GetStageLabel(session.CurrentStage),
            stageIndex = Array.IndexOf(Stages, session.CurrentStage),
            skillDraft = session.SkillDraft != null ? SerializeSkillPreview(session.SkillDraft) : null,
        });
    }

    /// <summary>
    /// Auto-run stages that don't need user input (scope → draft → metadata → preview)
    /// Each stage gets a synthetic "continue" instruction and runs LLM autonomously
    /// </summary>
    private async IAsyncEnumerable<SseChunk> RunAutoStagesAsync(
        SkillAgentSession session,
        string userId)
    {
        while (AutoRunStages.Contains(session.CurrentStage) && session.CurrentStage != "preview")
        {
            // Notify frontend: advancing to next stage
            yield return new SseChunk("stage_advance", new
            {
                stage = session.CurrentStage,
                stageLabel = GetStageLabel(session.CurrentStage),
                stageIndex = Array.IndexOf(Stages, session.CurrentStage),
            });

            // Build a synthetic instruction for this auto-stage
            var autoInstruction = BuildAutoInstruction(session);

            var stageCompleted = false;
            await foreach (var chunk in RunSingleStageAsync(session, autoInstruction, userId, isAutoRun: true))
            {
                yield return chunk;
                if (chunk.Event == "stage_complete") stageCompleted = true;
            }

            // If stage didn't complete (LLM didn't produce valid JSON), stop auto-run
            if (!stageCompleted) break;
        }

        // Handle preview stage
        if (session.CurrentStage == "preview" && session.SkillDraft != null)
        {
            yield return new SseChunk("stage_advance", new
            {
                stage = "preview",
                stageLabel = GetStageLabel("preview"),
                stageIndex = Array.IndexOf(Stages, "preview"),
            });

            // Auto-complete preview — just notify, no LLM call needed
            session.Messages.Add(new SkillAgentMessage("assistant",
                $"技能「{session.SkillDraft.Title}」已生成完毕！你可以在右侧预览效果，点击保存或导出。如果需要修改，直接告诉我。"));
        }
    }

    /// <summary>
    /// Run a single stage: call LLM, parse result, advance if complete
    /// </summary>
    private async IAsyncEnumerable<SseChunk> RunSingleStageAsync(
        SkillAgentSession session,
        string userMessage,
        string userId,
        bool isAutoRun = false)
    {
        var appCallerCode = AppCallerRegistry.SkillAgent.Guide.Chat;
        var requestId = Guid.NewGuid().ToString();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: session.Id,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userMessage.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"skill-agent-{session.CurrentStage}",
            RequestType: "skill-agent-guide",
            AppCallerCode: appCallerCode));

        var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 4096, temperature: 0.3);
        var systemPrompt = BuildSystemPrompt(session, isAutoRun);

        // Build message history (keep recent context, not full history for auto-runs)
        var messages = new List<LLMMessage>();
        if (isAutoRun)
        {
            // For auto-run, just provide the essential context
            messages.Add(new LLMMessage { Role = "user", Content = userMessage });
        }
        else
        {
            foreach (var msg in session.Messages)
            {
                messages.Add(new LLMMessage { Role = msg.Role, Content = msg.Content });
            }
        }

        var resultBuilder = new StringBuilder();
        await foreach (var chunk in llmClient.StreamGenerateAsync(systemPrompt, messages, false, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                resultBuilder.Append(chunk.Content);
                yield return new SseChunk("typing", new { text = chunk.Content });
            }
        }

        var fullResponse = resultBuilder.ToString().Trim();
        if (string.IsNullOrWhiteSpace(fullResponse))
        {
            yield return new SseChunk("error", new { message = "AI 未生成有效回复" });
            yield break;
        }

        var (displayText, stageData) = ExtractStageData(fullResponse);

        // Record assistant message
        session.Messages.Add(new SkillAgentMessage("assistant", displayText));

        if (stageData is { } sd)
        {
            ApplyStageData(session, sd);
            yield return new SseChunk("stage_complete", new
            {
                stage = session.CurrentStage,
                stageIndex = Array.IndexOf(Stages, session.CurrentStage),
            });
        }
    }

    /// <summary>
    /// Build synthetic instruction for auto-run stages (no user interaction needed)
    /// </summary>
    private static string BuildAutoInstruction(SkillAgentSession session)
    {
        return session.CurrentStage switch
        {
            "scope" => $"用户想要的技能：{session.Intent ?? "未知"}。请根据这个意图，自动判断最合适的输入配置（contextScope、acceptsUserInput、acceptsAttachments），直接给出结论并输出 JSON 结果。",
            "draft" => $"用户意图：{session.Intent ?? "未知"}。输入配置：contextScope={session.SkillDraft?.Input.ContextScope ?? "none"}, acceptsUserInput={session.SkillDraft?.Input.AcceptsUserInput ?? true}。请直接生成高质量的 prompt template，不需要询问用户意见，直接输出完整内容和 JSON 结果。",
            "metadata" => $"用户意图：{session.Intent ?? "未知"}。Prompt 模板已生成。请直接推荐最佳的 title/icon/category/tags/description，不需要询问用户，直接输出 JSON 结果。",
            _ => "请继续。",
        };
    }

    /// <summary>
    /// Generate welcome message for a new session
    /// </summary>
    public SseChunk GenerateWelcome()
    {
        const string welcome = "你好！我是技能创建助手。\n\n" +
                               "只需一句话告诉我**你想让 AI 帮你做什么**，我会自动帮你生成完整的技能模板。\n\n" +
                               "比如：\n" +
                               "- 「把会议纪要整理成待办事项」\n" +
                               "- 「分析代码的安全隐患」\n" +
                               "- 「把英文技术文档翻译成中文摘要」";
        return new SseChunk("welcome", new { message = welcome, stage = "intent", stageLabel = "意图理解" });
    }

    // ━━━ Skill Save & Export ━━━━━━━━

    public async Task<Skill?> SaveAsPersonalSkillAsync(SkillAgentSession session, string userId)
    {
        if (session.SkillDraft == null) return null;
        return await _skillService.CreatePersonalSkillAsync(userId, session.SkillDraft);
    }

    // ━━━ Skill Test ━━━━━━━━

    /// <summary>
    /// Get a skill for testing (personal skill owned by user)
    /// </summary>
    public async Task<Skill?> GetSkillForTestAsync(string skillKey, string userId)
    {
        var skill = await _skillService.GetByKeyAsync(skillKey);
        if (skill == null) return null;
        // Only allow testing personal skills owned by this user, or public/system skills
        if (skill.Visibility == SkillVisibility.Personal && skill.OwnerUserId != userId)
            return null;
        return skill;
    }

    /// <summary>
    /// Test a skill: run the prompt template with user input and stream the result
    /// </summary>
    public async IAsyncEnumerable<SseChunk> TestSkillAsync(Skill skill, string userInput, string userId)
    {
        var appCallerCode = AppCallerRegistry.SkillAgent.Guide.Chat;
        var requestId = Guid.NewGuid().ToString();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userInput.Length,
            DocumentHash: null,
            SystemPromptRedacted: "skill-agent-test",
            RequestType: "skill-agent-test",
            AppCallerCode: appCallerCode));

        var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 4096, temperature: 0.3);

        // Build the prompt: replace {{userInput}} placeholder
        var prompt = skill.Execution.PromptTemplate;
        if (!string.IsNullOrWhiteSpace(userInput))
            prompt = prompt.Replace("{{userInput}}", userInput);

        var systemPrompt = skill.Execution.SystemPromptOverride ??
            "你是一位资深专家级 AI 助手。请严格按照指令要求完成任务。" +
            "输出要求：结构清晰、逻辑严谨、语言专业、格式规范。" +
            "如果指令要求特定输出格式（表格、列表、分段等），必须严格遵循。" +
            "对于分析类任务，要有明确的结论和可操作的建议。";
        var messages = new List<LLMMessage> { new() { Role = "user", Content = prompt } };

        yield return new SseChunk("start", new { skillKey = skill.SkillKey, title = skill.Title });

        var resultBuilder = new StringBuilder();
        await foreach (var chunk in llmClient.StreamGenerateAsync(systemPrompt, messages, false, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                resultBuilder.Append(chunk.Content);
                yield return new SseChunk("typing", new { text = chunk.Content });
            }
        }

        yield return new SseChunk("done", new { totalChars = resultBuilder.Length });
    }

    public string? ExportAsMarkdown(SkillAgentSession session)
    {
        if (session.SkillDraft == null) return null;
        return SkillMdFormat.Serialize(session.SkillDraft);
    }

    public async Task<byte[]?> ExportAsZipAsync(SkillAgentSession session, string userId)
    {
        if (session.SkillDraft == null) return null;

        var skill = session.SkillDraft;
        var skillMd = SkillMdFormat.Serialize(skill);
        var (readme, example) = await GenerateExportDocsAsync(skill, userId);

        using var memoryStream = new MemoryStream();
        using (var archive = new ZipArchive(memoryStream, ZipArchiveMode.Create, true))
        {
            AddTextEntry(archive, "SKILL.md", skillMd);
            AddTextEntry(archive, "README.md", readme);
            AddTextEntry(archive, "examples/example-usage.md", example);
        }

        return memoryStream.ToArray();
    }

    // ━━━ Private: System Prompt Building ━━━━━━━━

    private string BuildSystemPrompt(SkillAgentSession session, bool isAutoRun)
    {
        var stage = session.CurrentStage;

        var basePrompt = @"你是一个技能创建引导助手。你的任务是帮用户把重复性工作变成可复用的 AI 技能。

技能 = 预设提示词模板 + 输入/输出配置。

【输出格式 - 严格遵守】
1. 先用通俗易懂的中文回复用户（禁止出现任何 JSON、代码块、字段名、技术术语）
2. 回复末尾附上一个系统解析用的 JSON 块：
```json:stage_result
{ ... }
```
3. JSON 块之外的文字中禁止出现 stageComplete、nextStage、contextScope、acceptsUserInput 等字段名
4. 用日常用语代替技术概念，如说「需要你提供额外内容」而不是「acceptsUserInput: true」";

        var autoSuffix = isAutoRun ? "\n\n【重要】这是自动流转阶段，不要向用户提问，直接给出你的最佳判断并输出 JSON 结果。保持简洁，不超过 3 句话说明即可。" : "";

        var stagePrompt = stage switch
        {
            "intent" => @"
当前阶段：意图理解

理解用户想自动化什么任务。如果描述清晰，确认并总结。如果模糊，追问一个关键问题。

理解后输出：
```json:stage_result
{""stageComplete"": true, ""intent"": ""一句话描述意图"", ""nextStage"": ""scope""}
```",

            "scope" => $@"
当前阶段：范围界定

用户意图：{session.Intent ?? "未知"}

根据意图判断输入配置：
- contextScope: ""prd""/""all""/""current""/""none""（是否需要文档上下文）
- acceptsUserInput: true/false（是否需要用户额外输入）
- acceptsAttachments: true/false（是否接受附件）

输出：
```json:stage_result
{{""stageComplete"": true, ""contextScope"": ""..."", ""acceptsUserInput"": true, ""acceptsAttachments"": false, ""nextStage"": ""draft""}}
```",

            "draft" => $@"
当前阶段：生成 Prompt 模板

用户意图：{session.Intent ?? "未知"}
输入配置：contextScope={session.SkillDraft?.Input.ContextScope ?? "none"}, acceptsUserInput={session.SkillDraft?.Input.AcceptsUserInput ?? true}

生成高质量 prompt template：
1. 用 {{{{userInput}}}} 作为用户输入占位符
2. 明确输出格式（表格/列表/分段）
3. 包含约束和注意事项
4. 专业简洁

输出：
```json:stage_result
{{""stageComplete"": true, ""promptTemplate"": ""完整 prompt template"", ""nextStage"": ""metadata""}}
```",

            "metadata" => $@"
当前阶段：元数据生成

用户意图：{session.Intent ?? "未知"}

直接推荐最佳元数据：
- title: 2-8 字简洁名称
- icon: 最匹配的 emoji
- category: general/analysis/generation/extraction/translation/summary/check/optimization/other
- tags: 2-4 个标签
- description: 一句话描述

输出：
```json:stage_result
{{""stageComplete"": true, ""title"": ""名称"", ""icon"": ""emoji"", ""category"": ""分类"", ""tags"": [""标签1"", ""标签2""], ""description"": ""描述"", ""nextStage"": ""preview""}}
```",

            "preview" => @"
技能已完成。简洁告知用户可以保存或导出。
```json:stage_result
{""stageComplete"": true, ""action"": ""preview""}
```",

            _ => ""
        };

        return basePrompt + stagePrompt + autoSuffix;
    }

    // ━━━ Private: Stage Data Extraction ━━━━━━━━

    private static (string displayText, JsonElement? stageData) ExtractStageData(string fullResponse)
    {
        const string startMarker = "```json:stage_result";
        const string endMarker = "```";

        var startIdx = fullResponse.IndexOf(startMarker, StringComparison.Ordinal);
        if (startIdx < 0)
            return (fullResponse, null);

        var jsonStart = startIdx + startMarker.Length;
        var jsonEnd = fullResponse.IndexOf(endMarker, jsonStart, StringComparison.Ordinal);
        if (jsonEnd < 0)
            return (fullResponse, null);

        var jsonStr = fullResponse[jsonStart..jsonEnd].Trim();
        var displayText = fullResponse[..startIdx].TrimEnd();

        try
        {
            var doc = JsonDocument.Parse(jsonStr);
            return (displayText, doc.RootElement.Clone());
        }
        catch (JsonException)
        {
            return (fullResponse, null);
        }
    }

    private void ApplyStageData(SkillAgentSession session, JsonElement data)
    {
        var stageComplete = data.TryGetProperty("stageComplete", out var sc) && sc.GetBoolean();
        if (!stageComplete) return;

        switch (session.CurrentStage)
        {
            case "intent":
                if (data.TryGetProperty("intent", out var intent))
                    session.Intent = intent.GetString();
                break;

            case "scope":
                session.SkillDraft ??= new Skill();
                if (data.TryGetProperty("contextScope", out var cs))
                    session.SkillDraft.Input.ContextScope = cs.GetString() ?? "prd";
                if (data.TryGetProperty("acceptsUserInput", out var aui))
                    session.SkillDraft.Input.AcceptsUserInput = aui.GetBoolean();
                if (data.TryGetProperty("acceptsAttachments", out var aa))
                    session.SkillDraft.Input.AcceptsAttachments = aa.GetBoolean();
                break;

            case "draft":
                session.SkillDraft ??= new Skill();
                if (data.TryGetProperty("promptTemplate", out var pt))
                    session.SkillDraft.Execution.PromptTemplate = pt.GetString() ?? "";
                break;

            case "metadata":
                session.SkillDraft ??= new Skill();
                if (data.TryGetProperty("title", out var t))
                    session.SkillDraft.Title = t.GetString() ?? "";
                if (data.TryGetProperty("icon", out var ic))
                    session.SkillDraft.Icon = ic.GetString();
                if (data.TryGetProperty("category", out var cat))
                    session.SkillDraft.Category = cat.GetString() ?? "general";
                if (data.TryGetProperty("description", out var desc))
                    session.SkillDraft.Description = desc.GetString() ?? "";
                if (data.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array)
                {
                    session.SkillDraft.Tags = tags.EnumerateArray()
                        .Select(e => e.GetString() ?? "")
                        .Where(s => !string.IsNullOrWhiteSpace(s))
                        .ToList();
                }
                if (!string.IsNullOrWhiteSpace(session.SkillDraft.Title))
                    session.SkillDraft.SkillKey = ToKebabCase(session.SkillDraft.Title);
                break;

            case "preview":
                break;
        }

        if (data.TryGetProperty("nextStage", out var ns))
        {
            var nextStage = ns.GetString();
            if (!string.IsNullOrWhiteSpace(nextStage) && Stages.Contains(nextStage))
                session.CurrentStage = nextStage;
        }
    }

    // ━━━ Private: Export Docs Generation ━━━━━━━━

    private async Task<(string readme, string example)> GenerateExportDocsAsync(Skill skill, string userId)
    {
        var appCallerCode = AppCallerRegistry.SkillAgent.Export.GenerateReadme;
        var requestId = Guid.NewGuid().ToString();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "skill-agent-export-readme",
            RequestType: "skill-agent-export",
            AppCallerCode: appCallerCode));

        var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 2048, temperature: 0.3);

        var systemPrompt = @"你是技能文档生成器。输出两段，用 === README === 和 === EXAMPLE === 分隔。
README: 技能名称和描述、使用场景、如何导入、注意事项。
EXAMPLE: 一个完整使用示例。中文 Markdown 格式。";

        var userContent = $"技能名称：{skill.Title}\n描述：{skill.Description}\n分类：{skill.Category}\n标签：{string.Join(", ", skill.Tags)}\nPrompt Template:\n{skill.Execution.PromptTemplate}";

        var messages = new List<LLMMessage> { new() { Role = "user", Content = userContent } };
        var result = new StringBuilder();
        await foreach (var chunk in llmClient.StreamGenerateAsync(systemPrompt, messages, false, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                result.Append(chunk.Content);
        }

        var fullText = result.ToString();
        var parts = fullText.Split("=== EXAMPLE ===", 2, StringSplitOptions.TrimEntries);
        var readmePart = parts[0].Replace("=== README ===", "").Trim();
        var examplePart = parts.Length > 1 ? parts[1].Trim() : "# 使用示例\n\n（请参考 SKILL.md 中的 prompt template 构造输入）";

        if (!readmePart.StartsWith("#")) readmePart = $"# {skill.Title}\n\n{readmePart}";
        if (!examplePart.StartsWith("#")) examplePart = $"# {skill.Title} — 使用示例\n\n{examplePart}";

        return (readmePart, examplePart);
    }

    // ━━━ Private: Helpers ━━━━━━━━

    private static void AddTextEntry(ZipArchive archive, string entryName, string content)
    {
        var entry = archive.CreateEntry(entryName, CompressionLevel.Optimal);
        using var writer = new StreamWriter(entry.Open(), Encoding.UTF8);
        writer.Write(content);
    }

    private static string? SerializeSkillPreview(Skill skill) => SkillMdFormat.Serialize(skill);

    private static string ToKebabCase(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) return "untitled-skill";
        var sb = new StringBuilder();
        foreach (var ch in input.Trim().ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch)) sb.Append(ch);
            else if (ch is ' ' or '-' or '_') sb.Append('-');
        }
        var result = sb.ToString().Trim('-');
        return string.IsNullOrWhiteSpace(result) ? $"skill-{Guid.NewGuid().ToString("N")[..8]}" : result;
    }
}

// ━━━ Models ━━━━━━━━

public class SkillAgentSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string CurrentStage { get; set; } = "intent";
    public string? Intent { get; set; }
    public Skill? SkillDraft { get; set; }
    public List<SkillAgentMessage> Messages { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;
}

public record SkillAgentMessage(string Role, string Content);
public record SseChunk(string Event, object Data);
