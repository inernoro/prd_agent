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
/// 技能引导 Agent 服务 — 5 阶段对话式引导用户创建技能
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
    /// 处理用户消息并返回 AI 引导回复（流式）
    /// </summary>
    public async IAsyncEnumerable<SseChunk> ProcessMessageAsync(
        SkillAgentSession session,
        string userMessage,
        string userId)
    {
        var requestId = Guid.NewGuid().ToString();
        var appCallerCode = AppCallerRegistry.SkillAgent.Guide.Chat;

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

        var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 4096, temperature: 0.4);
        var systemPrompt = BuildSystemPrompt(session);

        // Build message history
        var messages = new List<LLMMessage>();
        foreach (var msg in session.Messages)
        {
            messages.Add(new LLMMessage { Role = msg.Role, Content = msg.Content });
        }
        messages.Add(new LLMMessage { Role = "user", Content = userMessage });

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

        // Parse structured output (JSON block at end of response)
        var (displayText, stageData) = ExtractStageData(fullResponse);

        // Record messages
        session.Messages.Add(new SkillAgentMessage("user", userMessage));
        session.Messages.Add(new SkillAgentMessage("assistant", displayText));

        // Process stage data and advance stage if applicable
        if (stageData != null)
        {
            ApplyStageData(session, stageData);
            yield return new SseChunk("stage_data", stageData);
        }

        yield return new SseChunk("done", new
        {
            currentStage = session.CurrentStage,
            stageLabel = GetStageLabel(session.CurrentStage),
            stageIndex = Array.IndexOf(Stages, session.CurrentStage),
            skillDraft = session.SkillDraft != null ? SerializeSkillPreview(session.SkillDraft) : null,
        });
    }

    /// <summary>
    /// Generate welcome message for a new session
    /// </summary>
    public SseChunk GenerateWelcome()
    {
        const string welcome = "你好！我是技能创建助手，帮你把重复性工作变成一键可用的 AI 技能。\n\n" +
                               "**什么是技能？** 就是一个预设好的 AI 指令模板，下次遇到类似任务时一键调用。\n\n" +
                               "请告诉我：**你想让 AI 帮你做什么？** 描述一下你平时重复做的任务就好，比如：\n" +
                               "- 「帮我把会议纪要整理成待办事项」\n" +
                               "- 「分析一段代码的安全隐患」\n" +
                               "- 「把英文技术文档翻译成中文摘要」";
        return new SseChunk("welcome", new { message = welcome, stage = "intent", stageLabel = "意图理解" });
    }

    // ━━━ Skill Save & Export ━━━━━━━━

    /// <summary>
    /// Save the current draft as a personal skill
    /// </summary>
    public async Task<Skill?> SaveAsPersonalSkillAsync(SkillAgentSession session, string userId)
    {
        if (session.SkillDraft == null)
            return null;

        var skill = session.SkillDraft;
        return await _skillService.CreatePersonalSkillAsync(userId, skill);
    }

    /// <summary>
    /// Export the current draft as SKILL.md string
    /// </summary>
    public string? ExportAsMarkdown(SkillAgentSession session)
    {
        if (session.SkillDraft == null) return null;
        return SkillMdFormat.Serialize(session.SkillDraft);
    }

    /// <summary>
    /// Export the current draft as a ZIP package (SKILL.md + README.md + examples/)
    /// </summary>
    public async Task<byte[]?> ExportAsZipAsync(SkillAgentSession session, string userId)
    {
        if (session.SkillDraft == null) return null;

        var skill = session.SkillDraft;
        var skillMd = SkillMdFormat.Serialize(skill);

        // Generate README and example via LLM
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

    private string BuildSystemPrompt(SkillAgentSession session)
    {
        var stage = session.CurrentStage;
        var basePrompt = @"你是一个技能创建引导助手。你的任务是通过友好的对话，帮用户把一个重复性的工作任务变成可复用的 AI 技能。

技能 = 一个预设好的提示词模板 + 输入/输出配置，用户下次遇到类似任务时可一键调用。

你在每个阶段结束时，必须输出一个 JSON 块标记阶段完成，格式为：
```json:stage_result
{ ... }
```

注意：JSON 块必须用 ```json:stage_result 和 ``` 包裹，这是系统解析用的，不会展示给用户。
在 JSON 块之前先输出给用户看的自然语言回复。";

        var stagePrompt = stage switch
        {
            "intent" => @"
当前阶段：意图理解（Stage 1/5）

你的目标：理解用户想自动化什么任务。

引导方式：
1. 如果用户描述模糊，追问具体场景（在什么情况下做、输入是什么、期望输出是什么）
2. 如果用户描述清晰，确认理解并总结

当你确认理解了用户意图后，输出：
```json:stage_result
{""stageComplete"": true, ""intent"": ""一句话描述用户意图"", ""nextStage"": ""scope""}
```

如果还需要追问，不输出 JSON 块。",

            "scope" => @"
当前阶段：范围界定（Stage 2/5）

你的目标：确定这个技能需要什么输入。

需要明确的配置项：
- contextScope: 是否需要文档上下文？(""prd""=PRD文档, ""all""=所有文档, ""current""=当前对话, ""none""=不需要)
- acceptsUserInput: 用户是否需要额外输入？(true/false)
- acceptsAttachments: 是否接受附件？(true/false)

用自然语言询问用户，比如：「这个技能运行时需要读取什么内容？是基于文档来分析，还是用户手输内容就够了？」

当配置明确后输出：
```json:stage_result
{""stageComplete"": true, ""contextScope"": ""prd"", ""acceptsUserInput"": true, ""acceptsAttachments"": false, ""nextStage"": ""draft""}
```",

            "draft" => $@"
当前阶段：Prompt 草稿（Stage 3/5）

你的目标：生成一个高质量的 prompt template。

已知意图：{session.Intent ?? "未知"}
已知输入配置：contextScope={session.SkillDraft?.Input.ContextScope ?? "prd"}, acceptsUserInput={session.SkillDraft?.Input.AcceptsUserInput ?? false}, acceptsAttachments={session.SkillDraft?.Input.AcceptsAttachments ?? false}

prompt template 编写规则：
1. 用 {{{{userInput}}}} 作为用户输入占位符
2. 如果需要文档上下文，可以用「请基于以下文档内容」开头（系统会自动注入上下文）
3. 明确输出格式（表格、列表、分段等）
4. 包含约束条件和注意事项
5. 语气专业但不啰嗦

先给用户展示草稿，询问是否需要修改。
用户确认满意后输出：
```json:stage_result
{{""stageComplete"": true, ""promptTemplate"": ""完整的 prompt template 内容"", ""nextStage"": ""metadata""}}
```

如果用户要求修改，调整后再次展示，不输出 JSON 块直到用户满意。",

            "metadata" => $@"
当前阶段：元数据补全（Stage 4/5）

你的目标：为技能补全元数据（名称、图标、分类、标签）。

已知意图：{session.Intent ?? "未知"}

基于你对这个技能的理解，建议以下元数据：
- title: 2-8 个字的简洁名称
- icon: 一个最匹配的 emoji
- category: 从以下选择一个：general/analysis/generation/extraction/translation/summary/check/optimization/other
- tags: 2-4 个标签
- description: 一句话描述技能用途

向用户展示建议，询问是否要修改。
用户确认后输出：
```json:stage_result
{{""stageComplete"": true, ""title"": ""技能名称"", ""icon"": ""emoji"", ""category"": ""分类"", ""tags"": [""标签1"", ""标签2""], ""description"": ""描述"", ""nextStage"": ""preview""}}
```",

            "preview" => @"
当前阶段：预览与导出（Stage 5/5）

技能已创建完成！向用户展示完整的技能预览，并告知可以：
1. 保存为个人技能（立即可用）
2. 导出为 .md 文件（分享给他人）
3. 导出为 .zip 包（包含说明文档和使用示例）

直接输出：
```json:stage_result
{""stageComplete"": true, ""action"": ""preview""}
```",

            _ => ""
        };

        return basePrompt + stagePrompt;
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
                // Generate skillKey from title
                if (!string.IsNullOrWhiteSpace(session.SkillDraft.Title))
                    session.SkillDraft.SkillKey = ToKebabCase(session.SkillDraft.Title);
                break;

            case "preview":
                // No additional data to apply
                break;
        }

        // Advance to next stage
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

        var systemPrompt = @"你是技能文档生成器。用户给你一个技能的信息，你需要输出两个文档。

用 === README === 和 === EXAMPLE === 分隔两段内容。

README 内容：
- 技能名称和描述
- 使用场景（2-3 个）
- 如何导入和使用
- 注意事项

EXAMPLE 内容：
- 一个完整的使用示例（模拟用户输入和 AI 输出）

用中文撰写，Markdown 格式。";

        var userContent = $"技能名称：{skill.Title}\n描述：{skill.Description}\n" +
                          $"分类：{skill.Category}\n标签：{string.Join(", ", skill.Tags)}\n" +
                          $"Prompt Template:\n{skill.Execution.PromptTemplate}";

        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = userContent }
        };

        var result = new StringBuilder();
        await foreach (var chunk in llmClient.StreamGenerateAsync(systemPrompt, messages, false, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                result.Append(chunk.Content);
        }

        var fullText = result.ToString();
        var parts = fullText.Split("=== EXAMPLE ===", 2, StringSplitOptions.TrimEntries);
        var readmePart = parts[0].Replace("=== README ===", "").Trim();
        var examplePart = parts.Length > 1 ? parts[1].Trim() : $"# 使用示例\n\n（请参考 SKILL.md 中的 prompt template 构造输入）";

        // Ensure README has a title
        if (!readmePart.StartsWith("#"))
            readmePart = $"# {skill.Title}\n\n{readmePart}";

        // Ensure example has a title
        if (!examplePart.StartsWith("#"))
            examplePart = $"# {skill.Title} — 使用示例\n\n{examplePart}";

        return (readmePart, examplePart);
    }

    // ━━━ Private: Helpers ━━━━━━━━

    private static void AddTextEntry(ZipArchive archive, string entryName, string content)
    {
        var entry = archive.CreateEntry(entryName, CompressionLevel.Optimal);
        using var writer = new StreamWriter(entry.Open(), Encoding.UTF8);
        writer.Write(content);
    }

    private static string? SerializeSkillPreview(Skill skill)
    {
        return SkillMdFormat.Serialize(skill);
    }

    private static string ToKebabCase(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) return "untitled-skill";

        // For Chinese text, just use pinyin-style or keep simple
        var sb = new StringBuilder();
        foreach (var ch in input.Trim().ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch))
                sb.Append(ch);
            else if (ch == ' ' || ch == '-' || ch == '_')
                sb.Append('-');
            // Skip other characters (Chinese, etc.)
        }

        var result = sb.ToString().Trim('-');
        if (string.IsNullOrWhiteSpace(result))
            result = $"skill-{Guid.NewGuid().ToString("N")[..8]}";

        return result;
    }
}

// ━━━ Models ━━━━━━━━

/// <summary>
/// 技能引导会话（内存态，不持久化到数据库）
/// </summary>
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

/// <summary>
/// SSE chunk for streaming responses
/// </summary>
public record SseChunk(string Event, object Data);
