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
            "scope" => $"用户想要的技能：{session.Intent ?? "未知"}。根据这个意图判断：(1) 运行时是否需要读取已有文档作为背景？(2) 用户每次使用时是否需要提供不同的内容？(3) 是否涉及文件附件？直接给出你的判断。",
            "draft" => $"用户意图：{session.Intent ?? "未知"}。请直接编写一份专业的指令模板。写作要求：用祈使句；包含一个「输入→输出」示例帮助理解；解释为什么要按这个格式输出（让执行者理解意图而非死记规则）；需要用户提供内容的地方用 {{{{userInput}}}} 占位；去掉所有不必要的废话，保持精练有力。",
            "metadata" => $"用户意图：{session.Intent ?? "未知"}。请推荐：(1) 2-6 字名称；(2) 最贴切的 emoji；(3) 分类；(4) 2-3 个标签；(5) 一句话描述——描述要包含功能和典型使用场景（比如「当你需要……时使用」），让技能更容易被匹配到。",
            _ => "请继续。",
        };
    }

    /// <summary>
    /// Generate welcome message for a new session
    /// </summary>
    public SseChunk GenerateWelcome()
    {
        const string welcome = "你好！我是技能创建助手。\n\n" +
                               "告诉我你经常重复做的一件事，我来帮你变成一键可用的 AI 技能。\n\n" +
                               "描述越具体越好，比如：\n" +
                               "- 「每次开完会，要把录音笔记整理成待办清单，按人分组」\n" +
                               "- 「客户发来英文合同，我需要提取关键条款翻译成中文摘要」\n" +
                               "- 「拿到竞品截图后，写一份功能对比分析报告」";
        return new SseChunk("welcome", new { message = welcome, stage = "intent", stageLabel = "意图理解" });
    }

    // ━━━ Skill Save & Export ━━━━━━━━

    /// <summary>
    /// 保存技能草稿为个人技能。幂等：首次走 Create，后续"需要调整"重复保存走 Update，
    /// SkillKey 以 session.SavedSkillKey 为准（不随 Title 漂移），确保不会产生重复记录。
    /// 返回 (skill, alreadySaved)：alreadySaved=true 表示走的是更新路径。
    /// </summary>
    public async Task<(Skill? skill, bool alreadySaved)> SaveAsPersonalSkillAsync(SkillAgentSession session, string userId)
    {
        if (session.SkillDraft == null) return (null, false);

        // 已经保存过 → 走 Update，锁定首次保存时的 SkillKey
        if (!string.IsNullOrWhiteSpace(session.SavedSkillKey))
        {
            var savedKey = session.SavedSkillKey!;
            // 把 Draft 的 key 同步为已保存的 key，避免 Title 变更导致 ToKebabCase 产出新 key
            session.SkillDraft.SkillKey = savedKey;

            var updated = await _skillService.UpdatePersonalSkillAsync(userId, savedKey, session.SkillDraft);
            if (updated)
            {
                return (session.SkillDraft, true);
            }
            // Update 失败（记录被删 / 跨用户 / 无权）→ 清掉 SavedSkillKey 退回 Create 路径
            _logger.LogWarning("[skill-agent] Update fallback to create for session {SessionId}, skillKey {SkillKey}", session.Id, savedKey);
            session.SavedSkillKey = null;
        }

        // 首次保存：SkillDraft 的 SkillKey 可能为空或有值，交给 SkillService 决定
        var created = await _skillService.CreatePersonalSkillAsync(userId, session.SkillDraft);
        session.SavedSkillKey = created.SkillKey;
        return (created, false);
    }

    // ━━━ Skill Auto-Test (post-save evaluation loop) ━━━━━━━━

    /// <summary>
    /// Auto-test after save: generate a test input based on skill intent, then run the skill with it.
    /// Returns SSE stream: test_input event → typing events → done event.
    /// </summary>
    public async IAsyncEnumerable<SseChunk> AutoTestAfterSaveAsync(SkillAgentSession session, string userId)
    {
        if (session.SkillDraft == null) yield break;
        var skill = session.SkillDraft;

        // Step 1: Generate a realistic test input
        yield return new SseChunk("phase", new { message = "正在构思测试场景…" });

        var testInput = await GenerateTestInputAsync(skill, session.Intent ?? "", userId);
        yield return new SseChunk("test_input", new { input = testInput });

        // Step 2: Run the skill with the test input
        yield return new SseChunk("phase", new { message = "正在用测试内容试跑技能…" });

        await foreach (var chunk in TestSkillAsync(skill, testInput, userId))
        {
            yield return chunk;
        }

        // Step 3: Optimize description for better trigger matching
        yield return new SseChunk("phase", new { message = "正在优化技能描述…" });

        var optimizeResult = await OptimizeDescriptionAsync(skill, session.Intent ?? "", userId);
        if (optimizeResult != null)
        {
            // Update the draft and persist
            var oldDesc = skill.Description;
            skill.Description = optimizeResult.BestDescription;

            // Try to update in DB if already saved
            await _skillService.UpdatePersonalSkillAsync(userId, skill.SkillKey, skill);

            yield return new SseChunk("desc_optimized", new
            {
                oldDescription = oldDesc,
                newDescription = optimizeResult.BestDescription,
                score = optimizeResult.BestScore,
                candidates = optimizeResult.CandidateCount,
            });
        }
    }

    // ━━━ Description Optimization ━━━━━━━━

    /// <summary>
    /// Optimize skill description: generate 3 candidates + 5 test queries → score matrix → pick best
    /// </summary>
    private async Task<DescriptionOptimizeResult?> OptimizeDescriptionAsync(Skill skill, string intent, string userId)
    {
        var appCallerCode = AppCallerRegistry.SkillAgent.Guide.Chat;
        var requestId = Guid.NewGuid().ToString();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "skill-agent-desc-optimize",
            RequestType: "skill-agent-desc-optimize",
            AppCallerCode: appCallerCode));

        try
        {
            // Call 1: Generate 3 candidate descriptions + 5 test queries
            var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 2048, temperature: 0.5);

            var genPrompt = $@"你是一个技能匹配优化专家。用户有一个技能：

名称：{skill.Title}
意图：{intent}
当前描述：{skill.Description}

请输出 JSON（不要代码块包裹）：
{{
  ""candidates"": [
    ""简洁型描述：一句话直奔功能"",
    ""场景型描述：描述用户典型使用场景，如'当你收到XX需要快速YY时'"",
    ""激进型描述：尽可能覆盖多种触发词和使用场景""
  ],
  ""queries"": [
    ""用户可能怎么搜/说来触发这个技能的5条模拟查询（口语化、有细节）""
  ]
}}

3 个候选描述风格各异但都准确，5 条查询要像真实用户说的话（不是抽象关键词）。";

            var genMessages = new List<LLMMessage> { new() { Role = "user", Content = genPrompt } };
            var genResult = new StringBuilder();
            await foreach (var chunk in llmClient.StreamGenerateAsync(
                "输出纯 JSON，不要解释。", genMessages, false, CancellationToken.None))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                    genResult.Append(chunk.Content);
            }

            var genJson = genResult.ToString().Trim();
            // Strip markdown code block if present
            if (genJson.StartsWith("```")) genJson = genJson.Split('\n', 2).Length > 1
                ? genJson.Split('\n', 2)[1] : genJson;
            if (genJson.EndsWith("```")) genJson = genJson[..genJson.LastIndexOf("```", StringComparison.Ordinal)];
            genJson = genJson.Trim();

            using var genDoc = JsonDocument.Parse(genJson);
            var candidates = genDoc.RootElement.GetProperty("candidates")
                .EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0).ToList();
            var queries = genDoc.RootElement.GetProperty("queries")
                .EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0).ToList();

            if (candidates.Count == 0 || queries.Count == 0) return null;

            // Include the original description as a candidate
            candidates.Insert(0, skill.Description);

            // Call 2: Score each candidate against each query
            var scoreClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 1024, temperature: 0.1);

            var scorePrompt = $@"你是技能匹配引擎。给每个描述对每条查询打匹配分（0-10，10=完美匹配）。

描述列表：
{string.Join("\n", candidates.Select((c, i) => $"{i}: {c}"))}

查询列表：
{string.Join("\n", queries.Select((q, i) => $"{i}: {q}"))}

输出 JSON（不要代码块）：
{{""scores"": [[描述0对查询0的分, 描述0对查询1的分, ...], [描述1对查询0的分, ...], ...]}}";

            var scoreMessages = new List<LLMMessage> { new() { Role = "user", Content = scorePrompt } };
            var scoreResult = new StringBuilder();
            await foreach (var chunk in scoreClient.StreamGenerateAsync(
                "输出纯 JSON。", scoreMessages, false, CancellationToken.None))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                    scoreResult.Append(chunk.Content);
            }

            var scoreJson = scoreResult.ToString().Trim();
            if (scoreJson.StartsWith("```")) scoreJson = scoreJson.Split('\n', 2).Length > 1
                ? scoreJson.Split('\n', 2)[1] : scoreJson;
            if (scoreJson.EndsWith("```")) scoreJson = scoreJson[..scoreJson.LastIndexOf("```", StringComparison.Ordinal)];
            scoreJson = scoreJson.Trim();

            using var scoreDoc = JsonDocument.Parse(scoreJson);
            var scoresArray = scoreDoc.RootElement.GetProperty("scores");

            // Calculate total score for each candidate
            var bestIdx = 0;
            var bestTotal = 0.0;
            var idx = 0;
            foreach (var row in scoresArray.EnumerateArray())
            {
                var total = row.EnumerateArray().Sum(v => v.TryGetDouble(out var d) ? d : 0);
                if (total > bestTotal) { bestTotal = total; bestIdx = idx; }
                idx++;
            }

            var bestDesc = candidates[bestIdx];
            var maxPossible = queries.Count * 10.0;

            _logger.LogInformation(
                "[skill-agent] Description optimized for {SkillKey}: picked candidate {Idx} with score {Score}/{Max}",
                skill.SkillKey, bestIdx, bestTotal, maxPossible);

            return new DescriptionOptimizeResult
            {
                BestDescription = bestDesc,
                BestScore = Math.Round(bestTotal / maxPossible * 100),
                CandidateCount = candidates.Count,
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[skill-agent] Description optimization failed for {SkillKey}, skipping", skill.SkillKey);
            return null;
        }
    }

    private class DescriptionOptimizeResult
    {
        public string BestDescription { get; set; } = "";
        public double BestScore { get; set; }
        public int CandidateCount { get; set; }
    }

    /// <summary>
    /// Use LLM to generate a realistic test input that matches the skill's intent.
    /// </summary>
    private async Task<string> GenerateTestInputAsync(Skill skill, string intent, string userId)
    {
        var appCallerCode = AppCallerRegistry.SkillAgent.Guide.Chat;
        var requestId = Guid.NewGuid().ToString();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "skill-agent-gen-test-input",
            RequestType: "skill-agent-gen-test-input",
            AppCallerCode: appCallerCode));

        var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 1024, temperature: 0.6);

        var systemPrompt = "你是一个测试数据生成器。用户给你一个技能的描述和指令模板，你需要生成一段逼真的测试输入内容。" +
                           "要求：内容要像真实用户会输入的（有细节、有上下文、不是抽象占位符），长度适中（100-300字），直接输出内容本身，不要加任何解释。";

        var userContent = $"技能名称：{skill.Title}\n意图：{intent}\n指令模板：\n{skill.Execution.PromptTemplate}";
        var messages = new List<LLMMessage> { new() { Role = "user", Content = userContent } };

        var result = new StringBuilder();
        await foreach (var chunk in llmClient.StreamGenerateAsync(systemPrompt, messages, false, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                result.Append(chunk.Content);
        }

        return result.ToString().Trim();
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

        var basePrompt = @"你是一位经验丰富的技能设计师。你帮用户把重复性工作变成一键可用的 AI 技能（一段精心设计的指令模板）。

【你的设计理念】
- 好的技能像一份清晰的工作说明书：告诉 AI 做什么、为什么这样做、输入什么、输出什么格式
- 用祈使句写指令，解释 why 而不是堆砌 MUST —— AI 理解意图后会做得更好
- 每个技能包含至少一个「输入→输出」示例，让使用者一看就懂
- 保持精练，去掉所有不增加信息量的废话

【沟通风格】
- 像和朋友聊天一样自然，不用术语
- 禁止在回复中出现任何 JSON、代码块、字段名（如 contextScope、stageComplete）
- 这些是系统内部概念，用户不需要知道

【输出格式】
回复末尾附一个系统解析用的 JSON 块（用户看不到）：
```json:stage_result
{ ... }
```";

        var autoSuffix = isAutoRun ? "\n\n【重要】这是自动流转阶段，不要向用户提问，直接给出你的最佳判断并输出 JSON 结果。保持简洁，不超过 3 句话说明即可。" : "";

        var stagePrompt = stage switch
        {
            "intent" => @"
当前阶段：意图理解

你要搞清楚 4 件事（不用一次全问，根据用户描述的清晰程度决定）：
1. 这个技能要帮用户做什么？（核心任务）
2. 典型的使用场景是什么？（在什么情况下会用到）
3. 用户每次会给什么输入？（文字、文件、还是不需要输入）
4. 期望的输出长什么样？（格式、结构、一个简单例子）

如果用户描述已经够清晰（能回答上面大部分问题），直接确认你的理解并总结。
如果模糊，挑最关键的一个问题追问——不要一次问多个。

理解后输出：
```json:stage_result
{""stageComplete"": true, ""intent"": ""一句话精确描述意图"", ""nextStage"": ""scope""}
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
当前阶段：编写指令模板

用户意图：{session.Intent ?? "未知"}

现在是最关键的一步——编写一份高质量的指令模板。这份模板会被反复使用，质量决定了技能的价值。

编写方法论：
1. 用祈使句开头（「分析以下内容」「提取关键信息」「按以下格式整理」）
2. 解释 why——告诉 AI 为什么要按某种方式做（「这样分组是因为用户需要按人分配任务」），AI 理解意图后会做得更好
3. 明确输出格式——给一个具体的示例，比如：
   示例输入：「今天开会讨论了A和B两件事…」
   示例输出：
   ## 待办清单
   - [ ] @张三：完成XX（截止：本周五）
4. 用 {{{{userInput}}}} 作为用户输入内容的占位符
5. 保持精练——每句话都要有信息量，删掉「请注意」「请确保」等废话
6. 不要堆砌 ALWAYS/NEVER/MUST 等大写强调词——用解释取代命令

输出：
```json:stage_result
{{""stageComplete"": true, ""promptTemplate"": ""完整的指令模板"", ""nextStage"": ""metadata""}}
```",

            "metadata" => $@"
当前阶段：命名与描述

用户意图：{session.Intent ?? "未知"}

为这个技能设计身份信息：
- title: 2-6 字动宾短语（如「会议纪要整理」「合同条款提取」），避免「助手」「工具」等泛称
- icon: 选一个最能代表这个任务的 emoji
- category: general/analysis/generation/extraction/translation/summary/check/optimization/other
- tags: 2-3 个用户可能搜索的关键词
- description: 一句话，要「略微激进」——不只写功能，还写使用场景，让用户一看就知道什么时候该用它。
  好的描述：「当你收到英文合同需要快速理解关键条款时，提取核心内容并翻译成中文摘要」
  差的描述：「翻译和摘要工具」

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

    /// <summary>
    /// 首次保存成功后记录的 SkillKey。
    /// 后续"保存并试跑"会认它为准走 Update，避免因 Title 变更导致 SkillKey 漂移而新建重复记录。
    /// </summary>
    public string? SavedSkillKey { get; set; }
}

public record SkillAgentMessage(string Role, string Content);
public record SseChunk(string Event, object Data);
