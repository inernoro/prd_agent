using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// PRD Agent 技能系统（Desktop 客户端 API）
/// - 遵循 App Identity 原则：硬编码 appKey = prd-agent
/// - 技能列表、个人技能 CRUD、技能执行
/// </summary>
[ApiController]
[Route("api/prd-agent/skills")]
[Authorize]
public class PrdAgentSkillsController : ControllerBase
{
    private const string AppKey = "prd-agent";

    private readonly ISkillService _skillService;
    private readonly IRunEventStore _runStore;
    private readonly IRunQueue _runQueue;
    private readonly ISessionService _sessionService;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<PrdAgentSkillsController> _logger;

    public PrdAgentSkillsController(
        ISkillService skillService,
        IRunEventStore runStore,
        IRunQueue runQueue,
        ISessionService sessionService,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<PrdAgentSkillsController> logger)
    {
        _skillService = skillService;
        _runStore = runStore;
        _runQueue = runQueue;
        _sessionService = sessionService;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    private string GetUserId()
        => User.FindFirst("userId")?.Value ?? User.FindFirst("sub")?.Value ?? "";

    /// <summary>
    /// 获取当前用户可见的技能列表（系统 + 公共 + 个人）
    /// 注意：不返回 Execution 配置（防止提示词泄露）
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? role, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        UserRole? roleFilter = null;
        if (!string.IsNullOrWhiteSpace(role))
        {
            if (Enum.TryParse<UserRole>(role, true, out var parsed))
                roleFilter = parsed;
        }

        var skills = await _skillService.GetVisibleSkillsAsync(userId, roleFilter, ct);

        // 移除执行配置（不下发客户端）
        var clientSkills = skills.Select(s => new
        {
            s.SkillKey,
            s.Title,
            s.Description,
            s.Icon,
            s.Category,
            s.Tags,
            roles = s.Roles.Select(r => r.ToString()).ToList(),
            s.Order,
            s.Visibility,
            input = new
            {
                s.Input.ContextScope,
                s.Input.AcceptsUserInput,
                s.Input.UserInputPlaceholder,
                s.Input.AcceptsAttachments,
                s.Input.Parameters,
            },
            output = new
            {
                s.Output.Mode,
                s.Output.FileNameTemplate,
                s.Output.EchoToChat,
            },
            s.IsEnabled,
            s.IsBuiltIn,
            s.UsageCount,
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { skills = clientSkills }));
    }

    /// <summary>
    /// 创建个人技能
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateSkillRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "技能名称不能为空"));

        var skill = new Skill
        {
            Title = request.Title.Trim(),
            Description = (request.Description ?? "").Trim(),
            Icon = request.Icon,
            Category = request.Category ?? "general",
            Tags = request.Tags ?? new List<string>(),
            Roles = new List<UserRole>(),
            Order = request.Order,
            Input = request.Input ?? new SkillInputConfig(),
            Execution = request.Execution ?? new SkillExecutionConfig(),
            Output = request.Output ?? new SkillOutputConfig(),
            IsEnabled = true,
        };

        var created = await _skillService.CreatePersonalSkillAsync(userId, skill, ct);

        _logger.LogInformation("Personal skill created: {SkillKey} by {UserId}", created.SkillKey, userId);

        return Ok(ApiResponse<object>.Ok(new { skillKey = created.SkillKey }));
    }

    /// <summary>
    /// 更新个人技能
    /// </summary>
    [HttpPut("{skillKey}")]
    public async Task<IActionResult> Update(string skillKey, [FromBody] CreateSkillRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        var updates = new Skill
        {
            Title = (request.Title ?? "").Trim(),
            Description = (request.Description ?? "").Trim(),
            Icon = request.Icon,
            Category = request.Category ?? "general",
            Tags = request.Tags ?? new List<string>(),
            Roles = new List<UserRole>(),
            Order = request.Order,
            Input = request.Input ?? new SkillInputConfig(),
            Execution = request.Execution ?? new SkillExecutionConfig(),
            Output = request.Output ?? new SkillOutputConfig(),
            IsEnabled = true,
        };

        var ok = await _skillService.UpdatePersonalSkillAsync(userId, skillKey, updates, ct);
        if (!ok)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在或无权修改"));

        return Ok(ApiResponse<object>.Ok(new { skillKey }));
    }

    /// <summary>
    /// 删除个人技能
    /// </summary>
    [HttpDelete("{skillKey}")]
    public async Task<IActionResult> Delete(string skillKey, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        var ok = await _skillService.DeletePersonalSkillAsync(userId, skillKey, ct);
        if (!ok)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在或无权删除"));

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 执行技能：创建 ChatRun 并返回 runId
    /// 复用现有 Run/Worker + ChatService 管线，通过 InputJson 传递技能元数据
    /// </summary>
    [HttpPost("{skillKey}/execute")]
    public async Task<IActionResult> Execute(string skillKey, [FromBody] SkillExecuteRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        if (string.IsNullOrWhiteSpace(request.SessionId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "sessionId 不能为空"));

        // 查找技能
        var skill = await _skillService.GetByKeyAsync(skillKey, ct);
        if (skill == null || !skill.IsEnabled)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在或已禁用"));

        // 权限检查：个人技能只有创建者可执行
        if (skill.Visibility == SkillVisibility.Personal && skill.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权执行此技能"));

        // 会话检查
        var session = await _sessionService.GetByIdAsync(request.SessionId);
        if (session == null)
            return NotFound(ApiResponse<object>.Fail("SESSION_NOT_FOUND", "会话不存在"));

        // 解析模板参数
        var promptTemplate = skill.Execution.PromptTemplate;
        if (request.Parameters != null)
        {
            foreach (var (key, value) in request.Parameters)
            {
                promptTemplate = promptTemplate.Replace($"{{{{{key}}}}}", value);
            }
        }

        // 构建消息内容
        var content = string.IsNullOrWhiteSpace(request.UserInput)
            ? $"【{skill.Title}】"
            : $"【{skill.Title}】{request.UserInput.Trim()}";

        var contextScope = request.ContextScopeOverride ?? skill.Input.ContextScope;
        var outputMode = request.OutputModeOverride ?? skill.Output.Mode;

        // 创建 Run（复用 ChatRun 管线）
        var runId = Guid.NewGuid().ToString("N");
        var assistantMessageId = Guid.NewGuid().ToString("N");
        var userMessageId = Guid.NewGuid().ToString("N");

        var meta = new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.Chat,
            Status = RunStatuses.Queued,
            GroupId = string.IsNullOrWhiteSpace(session.GroupId) ? null : session.GroupId.Trim(),
            SessionId = request.SessionId,
            CreatedByUserId = userId,
            UserMessageId = userMessageId,
            AssistantMessageId = assistantMessageId,
            CreatedAt = DateTime.UtcNow,
            LastSeq = 0,
            CancelRequested = false,
            InputJson = JsonSerializer.Serialize(new
            {
                sessionId = request.SessionId,
                content,
                // 技能的 promptKey 就是 skillKey，ChatService 会通过 IPromptService 解析
                // 同时传递解析后的模板供 ChatRunWorker 直接使用
                promptKey = skill.SkillKey,
                resolvedPromptTemplate = promptTemplate,
                answerAsRole = session.CurrentRole.ToString(),
                attachmentIds = request.AttachmentIds ?? new List<string>(),
                userId,
                // 技能元数据
                skillKey = skill.SkillKey,
                contextScope,
                outputMode,
                systemPromptOverride = skill.Execution.SystemPromptOverride,
            }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })
        };

        await _runStore.SetRunAsync(RunKinds.Chat, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
        await _runQueue.EnqueueAsync(RunKinds.Chat, runId, CancellationToken.None);

        // 增加使用计数（异步，不阻塞响应）
        _ = _skillService.IncrementUsageAsync(skillKey, CancellationToken.None);

        _logger.LogInformation("Skill executed: {SkillKey}, runId={RunId}, userId={UserId}",
            skillKey, runId, userId);

        return Ok(ApiResponse<object>.Ok(new
        {
            runId,
            userMessageId,
            assistantMessageId,
        }));
    }

    /// <summary>
    /// 从对话消息自动生成技能草案
    /// 接收用户消息 + AI 回复内容，调用 LLM 分析并返回结构化的技能配置草案
    /// </summary>
    [HttpPost("generate-from-message")]
    public async Task<IActionResult> GenerateFromMessage([FromBody] GenerateSkillFromMessageRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        if (string.IsNullOrWhiteSpace(request.AssistantMessage))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "AI 回复内容不能为空"));

        const string appCallerCode = "prd-agent.skill-gen::chat";
        var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 2048, temperature: 0.3);

        var requestId = Guid.NewGuid().ToString();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: (request.UserMessage?.Length ?? 0) + request.AssistantMessage.Length,
            DocumentHash: null,
            SystemPromptRedacted: "skill-gen-system-prompt",
            RequestType: "skill-generation",
            RequestPurpose: appCallerCode));

        var systemPrompt = @"你是一个技能模板生成助手。根据用户提供的对话片段（用户问题 + AI 回复），分析其中的可复用模式，生成一个结构化的技能配置草案。

输出必须是一个严格的 JSON 对象，不要包含任何其他文本。JSON 结构如下：
{
  ""title"": ""简洁的技能名称（5-15字）"",
  ""description"": ""一句话描述用途"",
  ""icon"": ""一个匹配用途的 emoji"",
  ""category"": ""分类：analysis / testing / development / general"",
  ""tags"": [""标签1"", ""标签2""],
  ""contextScope"": ""上下文范围：prd / all / current / none"",
  ""acceptsUserInput"": true/false,
  ""promptTemplate"": ""从 AI 回复中提炼出的可复用提示词模板，用 {{userInput}} 作为用户输入占位符"",
  ""outputMode"": ""输出模式：chat / download / clipboard""
}

生成规则：
1. promptTemplate 应从 AI 回复中提炼核心指令和输出格式要求，去除具体细节，保留通用结构
2. 如果回复中包含分步骤指令，保留步骤结构
3. 如果回复中有输出格式规范（表格、列表等），在模板中明确要求
4. contextScope 根据内容判断：涉及 PRD 分析→prd，通用任务→none，需要对话历史→all
5. acceptsUserInput：如果技能需要用户提供额外信息才能工作，设为 true
6. 不要在 promptTemplate 中包含具体的项目信息或一次性内容";

        var userContent = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(request.UserMessage))
        {
            userContent.AppendLine("## 用户消息");
            userContent.AppendLine(request.UserMessage);
            userContent.AppendLine();
        }
        userContent.AppendLine("## AI 回复");
        userContent.AppendLine(request.AssistantMessage);

        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = userContent.ToString() }
        };

        var resultBuilder = new StringBuilder();
        await foreach (var chunk in llmClient.StreamGenerateAsync(systemPrompt, messages, false, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                resultBuilder.Append(chunk.Content);
        }

        var rawResult = resultBuilder.ToString().Trim();

        // 提取 JSON（处理可能的 ```json 包裹）
        var jsonStr = rawResult;
        if (jsonStr.Contains("```"))
        {
            var startIdx = jsonStr.IndexOf('{');
            var endIdx = jsonStr.LastIndexOf('}');
            if (startIdx >= 0 && endIdx > startIdx)
                jsonStr = jsonStr[startIdx..(endIdx + 1)];
        }

        try
        {
            var draft = JsonSerializer.Deserialize<GenerateSkillDraftResponse>(jsonStr, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                PropertyNameCaseInsensitive = true,
            });

            if (draft == null || string.IsNullOrWhiteSpace(draft.Title))
                return StatusCode(500, ApiResponse<object>.Fail("GENERATION_FAILED", "AI 生成结果无法解析"));

            _logger.LogInformation("Skill draft generated from message by {UserId}: {Title}", userId, draft.Title);

            return Ok(ApiResponse<object>.Ok(draft));
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse skill draft JSON: {Raw}", rawResult[..Math.Min(200, rawResult.Length)]);
            return StatusCode(500, ApiResponse<object>.Fail("GENERATION_FAILED", "AI 返回格式不正确，请重试"));
        }
    }

    /// <summary>
    /// 从 prompt_stages 迁移到 skills（管理员操作）
    /// </summary>
    [HttpPost("migrate-prompts")]
    public async Task<IActionResult> MigratePrompts(CancellationToken ct)
    {
        var count = await _skillService.MigrateFromPromptsAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { migratedCount = count }));
    }
}

/// <summary>创建/更新技能的请求体</summary>
public class CreateSkillRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? Category { get; set; }
    public List<string>? Tags { get; set; }
    public int Order { get; set; }
    public SkillInputConfig? Input { get; set; }
    public SkillExecutionConfig? Execution { get; set; }
    public SkillOutputConfig? Output { get; set; }
}

/// <summary>从消息生成技能草案的请求体</summary>
public class GenerateSkillFromMessageRequest
{
    /// <summary>用户的原始消息（可选，提供更多上下文）</summary>
    public string? UserMessage { get; set; }

    /// <summary>AI 的回复内容（必填，从中提炼技能模板）</summary>
    public string AssistantMessage { get; set; } = string.Empty;
}

/// <summary>AI 生成的技能草案</summary>
public class GenerateSkillDraftResponse
{
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Icon { get; set; } = string.Empty;
    public string Category { get; set; } = "general";
    public List<string> Tags { get; set; } = new();
    public string ContextScope { get; set; } = "prd";
    public bool AcceptsUserInput { get; set; }
    public string PromptTemplate { get; set; } = string.Empty;
    public string OutputMode { get; set; } = "chat";
}
