using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

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

    private readonly MongoDbContext _db;
    private readonly ISkillService _skillService;
    private readonly IRunEventStore _runStore;
    private readonly IRunQueue _runQueue;
    private readonly ISessionService _sessionService;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<PrdAgentSkillsController> _logger;

    public PrdAgentSkillsController(
        MongoDbContext db,
        ISkillService skillService,
        IRunEventStore runStore,
        IRunQueue runQueue,
        ISessionService sessionService,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<PrdAgentSkillsController> logger)
    {
        _db = db;
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

    private static string ToKebabCase(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) return "untitled-skill";
        // Remove non-ASCII (Chinese etc.) chars, replace spaces/underscores with hyphens
        var ascii = System.Text.RegularExpressions.Regex.Replace(input, @"[^\x20-\x7E]", "");
        if (string.IsNullOrWhiteSpace(ascii)) return $"skill-{DateTime.UtcNow:yyyyMMddHHmmss}";
        return System.Text.RegularExpressions.Regex.Replace(ascii.Trim(), @"[\s_]+", "-").ToLowerInvariant();
    }

    private async Task<(Session? Session, UserRole EffectiveAnswerRole, IActionResult? Error)> ResolveAccessibleSessionAsync(
        string sessionId,
        string userId,
        CancellationToken ct)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        var session = await _sessionService.GetByIdAsync(sid);
        if (session == null)
        {
            return (null, default, NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在")));
        }

        if (!string.IsNullOrWhiteSpace(session.OwnerUserId))
        {
            if (!string.Equals(session.OwnerUserId, userId, StringComparison.Ordinal))
            {
                return (session, default, StatusCode(StatusCodes.Status403Forbidden,
                    ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权访问该会话")));
            }

            return (session, session.CurrentRole, null);
        }

        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            var gid = session.GroupId.Trim();
            var member = await _db.GroupMembers
                .Find(x => x.GroupId == gid && x.UserId == userId)
                .FirstOrDefaultAsync(ct);
            if (member == null)
            {
                return (session, default, StatusCode(StatusCodes.Status403Forbidden,
                    ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员")));
            }

            return (session, member.MemberRole, null);
        }

        return (session, default, StatusCode(StatusCodes.Status403Forbidden,
            ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权访问该会话")));
    }

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

        // 会话访问校验：个人会话必须 owner，群会话必须是成员。
        // 群会话回答角色始终以 GroupMembers.MemberRole 为准，避免直接信任 session.CurrentRole。
        var (session, effectiveAnswerRole, accessError) = await ResolveAccessibleSessionAsync(request.SessionId, userId, ct);
        if (accessError != null)
            return accessError;

        if (skill.Roles.Count > 0 && !skill.Roles.Contains(effectiveAnswerRole))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "当前角色无权执行此技能"));
        }

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
            GroupId = string.IsNullOrWhiteSpace(session!.GroupId) ? null : session.GroupId.Trim(),
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
                answerAsRole = effectiveAnswerRole.ToString(),
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
    /// 从对话消息提炼可复用的提示词模板（纯文本）
    /// LLM 只负责提炼 promptTemplate，元数据由前端表单填写
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
            AppCallerCode: appCallerCode));

        var systemPrompt = @"你是一个提示词模板提炼助手。根据用户提供的对话片段（用户问题 + AI 回复），从中提炼出一个可复用的提示词模板。

直接输出提示词模板的纯文本，不要包含任何额外说明、不要用 JSON、不要用代码块包裹。

提炼规则：
1. 从 AI 回复中提炼核心指令和输出格式要求，去除具体细节，保留通用结构
2. 如果回复中包含分步骤指令，保留步骤结构
3. 如果回复中有输出格式规范（表格、列表等），在模板中明确要求
4. 用 {{userInput}} 作为用户输入占位符（如果模板需要用户提供额外信息）
5. 不要在模板中包含具体的项目信息或一次性内容";

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

        var promptTemplate = resultBuilder.ToString().Trim();

        if (string.IsNullOrWhiteSpace(promptTemplate))
            return StatusCode(500, ApiResponse<object>.Fail("GENERATION_FAILED", "AI 未生成有效内容"));

        _logger.LogInformation("Skill promptTemplate extracted from message by {UserId}, length={Length}",
            userId, promptTemplate.Length);

        return Ok(ApiResponse<object>.Ok(new { promptTemplate }));
    }

    /// <summary>
    /// 从多轮对话提炼技能草案（增强版）
    /// 支持用户选择多轮对话上下文，LLM 同时提炼 promptTemplate + title/description/category/icon
    /// </summary>
    [HttpPost("generate-from-conversation")]
    public async Task<IActionResult> GenerateFromConversation([FromBody] GenerateSkillFromConversationRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        if (request.ConversationMessages == null || request.ConversationMessages.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "对话内容不能为空"));

        if (string.IsNullOrWhiteSpace(request.KeyAssistantMessage))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "关键 AI 回复不能为空"));

        const string appCallerCode = "prd-agent.skill-gen::chat";
        var llmClient = _gateway.CreateClient(appCallerCode, "chat", maxTokens: 3072, temperature: 0.3);

        var totalChars = request.ConversationMessages.Sum(m => m.Content?.Length ?? 0);
        var requestId = Guid.NewGuid().ToString();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: totalChars,
            DocumentHash: null,
            SystemPromptRedacted: "skill-gen-conversation-system-prompt",
            RequestType: "skill-generation-conversation",
            AppCallerCode: appCallerCode));

        var systemPrompt = @"你是一个技能提炼专家。用户提供了一段多轮对话（包含用户的教导/需求和 AI 的回复），你需要从中提炼出一个可复用的技能草案。

请输出 JSON 格式（不要用 ```json 代码块包裹），包含以下字段：
{
  ""promptTemplate"": ""提炼出的提示词模板（必填）"",
  ""title"": ""简洁的技能名称，2-8个字（必填）"",
  ""description"": ""技能用途描述，一句话（必填）"",
  ""category"": ""分类（必填，从以下选择：general/analysis/generation/extraction/translation/summary/check/optimization/other）"",
  ""icon"": ""推荐一个最匹配的 emoji 图标（必填）""
}

提炼规则：
1. 重点关注标记为【关键回复】的 AI 回复，它代表用户最终满意的结果
2. 前面的对话轮次体现了用户的偏好、约束条件和迭代调整，将这些融入模板
3. 从用户的多次教导中提炼出隐含的「风格偏好」「格式要求」「注意事项」
4. 如果用户纠正过 AI 的错误，在模板中加入相应的约束避免同类错误
5. 用 {{userInput}} 作为用户输入占位符（如果模板需要用户提供额外信息）
6. 不要在模板中包含具体的项目信息或一次性内容
7. 保留对话中体现的步骤结构、输出格式规范
8. title 应简洁有力，像「深度分析」「会议纪要」「代码审查」这样的风格";

        var userContent = new StringBuilder();
        userContent.AppendLine("## 多轮对话记录");
        userContent.AppendLine();

        for (var i = 0; i < request.ConversationMessages.Count; i++)
        {
            var msg = request.ConversationMessages[i];
            var role = string.Equals(msg.Role, "user", StringComparison.OrdinalIgnoreCase) ? "用户" : "AI";
            var isKey = string.Equals(msg.Role, "assistant", StringComparison.OrdinalIgnoreCase)
                        && string.Equals(msg.Content?.Trim(), request.KeyAssistantMessage?.Trim(), StringComparison.Ordinal);
            userContent.AppendLine(isKey ? $"### {role}（第 {i + 1} 条）【关键回复】" : $"### {role}（第 {i + 1} 条）");
            userContent.AppendLine(msg.Content);
            userContent.AppendLine();
        }

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

        if (string.IsNullOrWhiteSpace(rawResult))
            return StatusCode(500, ApiResponse<object>.Fail("GENERATION_FAILED", "AI 未生成有效内容"));

        // 解析 JSON 响应
        try
        {
            var jsonOpts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var draft = JsonSerializer.Deserialize<SkillDraftResult>(rawResult, jsonOpts);

            if (draft == null || string.IsNullOrWhiteSpace(draft.PromptTemplate))
                return StatusCode(500, ApiResponse<object>.Fail("GENERATION_FAILED", "AI 未生成有效的提示词模板"));

            _logger.LogInformation(
                "Skill draft extracted from {TurnCount}-turn conversation by {UserId}, title={Title}",
                request.ConversationMessages.Count, userId, draft.Title);

            // 同时生成 SKILL.md 格式
            var draftSkill = new Skill
            {
                SkillKey = ToKebabCase(draft.Title ?? "untitled-skill"),
                Title = draft.Title ?? "未命名技能",
                Description = draft.Description ?? "",
                Icon = draft.Icon,
                Category = draft.Category ?? "general",
                Execution = new SkillExecutionConfig { PromptTemplate = draft.PromptTemplate },
            };
            var skillMd = SkillMdFormat.Serialize(draftSkill);

            return Ok(ApiResponse<object>.Ok(new
            {
                promptTemplate = draft.PromptTemplate,
                title = draft.Title,
                description = draft.Description,
                category = draft.Category,
                icon = draft.Icon,
                skillMd,
            }));
        }
        catch (JsonException)
        {
            // JSON 解析失败时回退：把整个输出当作 promptTemplate
            _logger.LogWarning("Failed to parse skill draft JSON from LLM, falling back to raw promptTemplate");

            var fallbackSkill = new Skill
            {
                SkillKey = "untitled-skill",
                Title = "未命名技能",
                Execution = new SkillExecutionConfig { PromptTemplate = rawResult },
            };
            var fallbackMd = SkillMdFormat.Serialize(fallbackSkill);

            return Ok(ApiResponse<object>.Ok(new
            {
                promptTemplate = rawResult,
                title = (string?)null,
                description = (string?)null,
                category = (string?)null,
                icon = (string?)null,
                skillMd = fallbackMd,
            }));
        }
    }

    /// <summary>
    /// 导出技能为 SKILL.md 格式
    /// </summary>
    [HttpGet("{skillKey}/export")]
    public async Task<IActionResult> Export(string skillKey, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        var skill = await _skillService.GetByKeyAsync(skillKey, ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在"));

        // 个人技能仅创建者可导出
        if (skill.Visibility == SkillVisibility.Personal && skill.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权导出此技能"));

        var skillMd = SkillMdFormat.Serialize(skill);

        return Ok(ApiResponse<object>.Ok(new
        {
            skillMd,
            fileName = $"{skill.SkillKey}.skill.md",
        }));
    }

    /// <summary>
    /// 从 SKILL.md 内容导入创建个人技能
    /// </summary>
    [HttpPost("import")]
    public async Task<IActionResult> Import([FromBody] ImportSkillMdRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未授权"));

        if (string.IsNullOrWhiteSpace(request.SkillMd))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "SKILL.md 内容不能为空"));

        var skill = SkillMdFormat.Deserialize(request.SkillMd);
        if (skill == null || string.IsNullOrWhiteSpace(skill.Execution.PromptTemplate))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "SKILL.md 格式无效或缺少提示词模板"));

        // 如果 skillKey 已存在于个人技能中，生成新的 key
        var existing = await _skillService.GetByKeyAsync(skill.SkillKey, ct);
        if (existing != null)
        {
            skill.SkillKey = $"{skill.SkillKey}-{DateTime.UtcNow:yyyyMMddHHmmss}";
        }

        var created = await _skillService.CreatePersonalSkillAsync(userId, skill, ct);

        _logger.LogInformation("Skill imported from SKILL.md: {SkillKey} by {UserId}", created.SkillKey, userId);

        return Ok(ApiResponse<object>.Ok(new { skillKey = created.SkillKey }));
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

/// <summary>从消息生成技能草案的请求体（旧版：单条消息）</summary>
public class GenerateSkillFromMessageRequest
{
    /// <summary>用户的原始消息（可选，提供更多上下文）</summary>
    public string? UserMessage { get; set; }

    /// <summary>AI 的回复内容（必填，从中提炼技能模板）</summary>
    public string AssistantMessage { get; set; } = string.Empty;
}

/// <summary>从多轮对话生成技能草案的请求体（增强版）</summary>
public class GenerateSkillFromConversationRequest
{
    /// <summary>多轮对话消息列表（按时间顺序）</summary>
    public List<ConversationMessageItem> ConversationMessages { get; set; } = new();

    /// <summary>关键 AI 回复内容（触发"保存为技能"的那条回复）</summary>
    public string KeyAssistantMessage { get; set; } = string.Empty;
}

/// <summary>对话消息项</summary>
public class ConversationMessageItem
{
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
}

/// <summary>导入 SKILL.md 的请求体</summary>
public class ImportSkillMdRequest
{
    /// <summary>SKILL.md 文件内容</summary>
    public string SkillMd { get; set; } = string.Empty;
}

/// <summary>LLM 提炼的技能草案结果</summary>
public class SkillDraftResult
{
    public string PromptTemplate { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Category { get; set; }
    public string? Icon { get; set; }
}

