using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using System.Security.Claims;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 私人助理 Agent — MBB 级执行助理：MECE 任务拆解、四象限排序、任务清单管理
/// </summary>
[ApiController]
[Route("api/pa-agent")]
[Authorize]
[AdminController("pa-agent", AdminPermissionCatalog.PaAgentUse)]
public class PaAgentController : ControllerBase
{
    private const string AppKey = "pa-agent";
    private const string AppCallerCode = "pa-agent.chat::chat";

    private static readonly string SystemPrompt = """
        你是一位 MBB（麦肯锡/波士顿/贝恩）级别的私人执行助理，帮助用户进行清晰的任务规划与高效执行。

        ## 你的核心能力

        1. **MECE 任务拆解**：将模糊目标拆解为互不重叠、完全穷尽的子步骤
        2. **四象限排序**：按重要性-紧急性对任务进行象限分类
           - Q1（紧急重要）：今日必须完成，直接影响核心目标
           - Q2（重要不紧急）：计划性投资，长期价值最高
           - Q3（紧急不重要）：可委托他人或快速处理
           - Q4（不重要不紧急）：可忽略或删除
        3. **执行建议**：给出具体可操作的下一步行动，而非空泛建议
        4. **进度追踪**：帮助用户回顾已完成事项，识别卡点

        ## 输出规范

        - 简洁直接，避免废话
        - 使用结构化输出（列表、表格）
        - 当用户要求保存任务时，在回复末尾输出以下格式的 JSON 块（用 ```json 包裹）：
          ```json
          {
            "action": "save_task",
            "title": "任务标题",
            "quadrant": "Q2",
            "reasoning": "为什么是这个象限",
            "subTasks": ["子步骤1", "子步骤2"]
          }
          ```
        - quadrant 必须是 Q1/Q2/Q3/Q4 之一
        - 只有当用户明确说"保存"、"加入清单"、"记录"时，才输出 JSON 块

        ## 对话风格

        - 称呼用户为"你"，语气专业但不生硬
        - 主动追问关键信息（截止时间、资源约束、优先级）
        - 识别用户的隐性需求，给出超预期建议
        """;

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<PaAgentController> _logger;

    public PaAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILogger<PaAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private string? GetDisplayName()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    // ──────────────────────────────────────────────────────────────────
    // Session
    // ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// 获取或创建当前用户的会话
    /// </summary>
    [HttpGet("session")]
    public async Task<IActionResult> GetOrCreateSession()
    {
        var userId = GetUserId();
        var session = await _db.PaSessions
            .Find(s => s.UserId == userId)
            .SortByDescending(s => s.UpdatedAt)
            .FirstOrDefaultAsync();

        if (session == null)
        {
            session = new PaSession { UserId = userId };
            await _db.PaSessions.InsertOneAsync(session);
        }

        return Ok(ApiResponse<object>.Ok(new { sessionId = session.Id }));
    }

    // ──────────────────────────────────────────────────────────────────
    // Chat (SSE streaming)
    // ──────────────────────────────────────────────────────────────────

    public class ChatRequest
    {
        public string SessionId { get; set; } = string.Empty;
        public string Message { get; set; } = string.Empty;
    }

    /// <summary>
    /// 流式对话 — SSE 推送助理回复
    /// </summary>
    [HttpPost("chat")]
    public async Task Chat([FromBody] ChatRequest req)
    {
        var userId = GetUserId();

        if (string.IsNullOrWhiteSpace(req.Message))
        {
            Response.StatusCode = 400;
            return;
        }

        // Ensure session exists
        var sessionId = req.SessionId;
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            var session = await _db.PaSessions
                .Find(s => s.UserId == userId)
                .SortByDescending(s => s.UpdatedAt)
                .FirstOrDefaultAsync();
            if (session == null)
            {
                session = new PaSession { UserId = userId };
                await _db.PaSessions.InsertOneAsync(session);
            }
            sessionId = session.Id;
        }

        // Persist user message
        var userMsg = new PaMessage
        {
            UserId = userId,
            SessionId = sessionId,
            Role = "user",
            Content = req.Message,
        };
        await _db.PaMessages.InsertOneAsync(userMsg);

        // Load recent history (last 20 messages for context)
        var history = await _db.PaMessages
            .Find(m => m.UserId == userId && m.SessionId == sessionId)
            .SortByDescending(m => m.CreatedAt)
            .Limit(20)
            .ToListAsync();
        history.Reverse();

        var llmMessages = history
            .Where(m => m.Role is "user" or "assistant")
            .Select(m => new LLMMessage { Role = m.Role, Content = m.Content })
            .ToList();

        // SSE headers
        Response.Headers["Content-Type"] = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        var assistantContent = new StringBuilder();

        try
        {
            var client = _gateway.CreateClient(AppCallerCode, "chat", maxTokens: 4096, temperature: 0.3);

            await foreach (var chunk in client.StreamGenerateAsync(SystemPrompt, llmMessages, CancellationToken.None))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    assistantContent.Append(chunk.Content);
                    var sseData = JsonSerializer.Serialize(new { type = "delta", content = chunk.Content });
                    await Response.WriteAsync($"data: {sseData}\n\n", CancellationToken.None);
                    await Response.Body.FlushAsync(CancellationToken.None);
                }
                else if (chunk.Type == "done")
                {
                    var sseData = JsonSerializer.Serialize(new { type = "done" });
                    await Response.WriteAsync($"data: {sseData}\n\n", CancellationToken.None);
                    await Response.Body.FlushAsync(CancellationToken.None);
                }
                else if (chunk.Type == "error")
                {
                    var sseData = JsonSerializer.Serialize(new { type = "error", message = chunk.ErrorMessage });
                    await Response.WriteAsync($"data: {sseData}\n\n", CancellationToken.None);
                    await Response.Body.FlushAsync(CancellationToken.None);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[pa-agent] chat stream error for user {UserId}", userId);
            var errData = JsonSerializer.Serialize(new { type = "error", message = "服务异常，请稍后重试" });
            await Response.WriteAsync($"data: {errData}\n\n", CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }

        // Persist assistant message
        if (assistantContent.Length > 0)
        {
            var assistantMsg = new PaMessage
            {
                UserId = userId,
                SessionId = sessionId,
                Role = "assistant",
                Content = assistantContent.ToString(),
            };
            await _db.PaMessages.InsertOneAsync(assistantMsg);

            // Update session timestamp
            await _db.PaSessions.UpdateOneAsync(
                s => s.Id == sessionId,
                Builders<PaSession>.Update.Set(s => s.UpdatedAt, DateTime.UtcNow));
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Messages
    // ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// 获取会话消息历史
    /// </summary>
    [HttpGet("messages")]
    public async Task<IActionResult> GetMessages([FromQuery] string sessionId, [FromQuery] int limit = 50)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(sessionId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "sessionId 不能为空"));

        var messages = await _db.PaMessages
            .Find(m => m.UserId == userId && m.SessionId == sessionId)
            .SortByDescending(m => m.CreatedAt)
            .Limit(limit)
            .ToListAsync();
        messages.Reverse();

        return Ok(ApiResponse<List<PaMessage>>.Ok(messages));
    }

    // ──────────────────────────────────────────────────────────────────
    // Tasks CRUD
    // ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// 获取任务列表（按象限分组）
    /// </summary>
    [HttpGet("tasks")]
    public async Task<IActionResult> GetTasks([FromQuery] string? quadrant = null, [FromQuery] string? status = null)
    {
        var userId = GetUserId();

        var filter = Builders<PaTask>.Filter.Eq(t => t.UserId, userId);
        if (!string.IsNullOrWhiteSpace(quadrant) && PaTaskQuadrant.All.Contains(quadrant))
            filter &= Builders<PaTask>.Filter.Eq(t => t.Quadrant, quadrant);
        if (!string.IsNullOrWhiteSpace(status) && PaTaskStatus.All.Contains(status))
            filter &= Builders<PaTask>.Filter.Eq(t => t.Status, status);
        else if (string.IsNullOrWhiteSpace(status))
            filter &= Builders<PaTask>.Filter.Ne(t => t.Status, PaTaskStatus.Archived);

        var tasks = await _db.PaTasks
            .Find(filter)
            .SortByDescending(t => t.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<List<PaTask>>.Ok(tasks));
    }

    public class CreateTaskRequest
    {
        public string Title { get; set; } = string.Empty;
        public string Quadrant { get; set; } = PaTaskQuadrant.Q2;
        public string? SessionId { get; set; }
        public string? Reasoning { get; set; }
        public List<string>? SubTasks { get; set; }
        public DateTime? Deadline { get; set; }
        public string? ContentHash { get; set; }
    }

    /// <summary>
    /// 创建任务（含幂等去重：同一 ContentHash 24h 内不重复创建）
    /// </summary>
    [HttpPost("tasks")]
    public async Task<IActionResult> CreateTask([FromBody] CreateTaskRequest req)
    {
        var userId = GetUserId();

        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail("CONTENT_EMPTY", "标题不能为空"));

        if (!string.IsNullOrWhiteSpace(req.ContentHash))
        {
            var cutoff = DateTime.UtcNow.AddHours(-24);
            var existing = await _db.PaTasks
                .Find(t => t.UserId == userId && t.ContentHash == req.ContentHash && t.CreatedAt >= cutoff)
                .FirstOrDefaultAsync();
            if (existing != null)
                return Ok(ApiResponse<PaTask>.Ok(existing));
        }

        var quadrant = PaTaskQuadrant.All.Contains(req.Quadrant) ? req.Quadrant : PaTaskQuadrant.Q2;
        var task = new PaTask
        {
            UserId = userId,
            SessionId = req.SessionId,
            Title = req.Title,
            Quadrant = quadrant,
            Reasoning = req.Reasoning,
            Deadline = req.Deadline,
            ContentHash = req.ContentHash,
            SubTasks = (req.SubTasks ?? new List<string>())
                .Select(s => new PaSubTask { Content = s })
                .ToList(),
        };

        await _db.PaTasks.InsertOneAsync(task);
        return Ok(ApiResponse<PaTask>.Ok(task));
    }

    public class UpdateTaskRequest
    {
        public string? Title { get; set; }
        public string? Quadrant { get; set; }
        public string? Status { get; set; }
        public DateTime? Deadline { get; set; }
        public List<PaSubTask>? SubTasks { get; set; }
    }

    /// <summary>
    /// 更新任务（标题、象限、状态、子步骤）
    /// </summary>
    [HttpPatch("tasks/{id}")]
    public async Task<IActionResult> UpdateTask(string id, [FromBody] UpdateTaskRequest req)
    {
        var userId = GetUserId();
        var task = await _db.PaTasks.Find(t => t.Id == id && t.UserId == userId).FirstOrDefaultAsync();
        if (task == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "任务不存在"));

        var updates = new List<UpdateDefinition<PaTask>>();
        updates.Add(Builders<PaTask>.Update.Set(t => t.UpdatedAt, DateTime.UtcNow));

        if (!string.IsNullOrWhiteSpace(req.Title))
            updates.Add(Builders<PaTask>.Update.Set(t => t.Title, req.Title));

        if (!string.IsNullOrWhiteSpace(req.Quadrant) && PaTaskQuadrant.All.Contains(req.Quadrant))
            updates.Add(Builders<PaTask>.Update.Set(t => t.Quadrant, req.Quadrant));

        if (!string.IsNullOrWhiteSpace(req.Status) && PaTaskStatus.All.Contains(req.Status))
            updates.Add(Builders<PaTask>.Update.Set(t => t.Status, req.Status));

        if (req.Deadline.HasValue)
            updates.Add(Builders<PaTask>.Update.Set(t => t.Deadline, req.Deadline));

        if (req.SubTasks != null)
            updates.Add(Builders<PaTask>.Update.Set(t => t.SubTasks, req.SubTasks));

        await _db.PaTasks.UpdateOneAsync(
            t => t.Id == id && t.UserId == userId,
            Builders<PaTask>.Update.Combine(updates));

        var updated = await _db.PaTasks.Find(t => t.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<PaTask?>.Ok(updated));
    }

    /// <summary>
    /// 删除任务（软删除：设为 archived）
    /// </summary>
    [HttpDelete("tasks/{id}")]
    public async Task<IActionResult> DeleteTask(string id)
    {
        var userId = GetUserId();
        var result = await _db.PaTasks.UpdateOneAsync(
            t => t.Id == id && t.UserId == userId,
            Builders<PaTask>.Update
                .Set(t => t.Status, PaTaskStatus.Archived)
                .Set(t => t.UpdatedAt, DateTime.UtcNow));

        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "任务不存在"));

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 更新子步骤完成状态
    /// </summary>
    [HttpPatch("tasks/{id}/subtasks/{index}")]
    public async Task<IActionResult> UpdateSubTask(string id, int index, [FromBody] UpdateSubTaskRequest req)
    {
        var userId = GetUserId();
        var task = await _db.PaTasks.Find(t => t.Id == id && t.UserId == userId).FirstOrDefaultAsync();
        if (task == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "任务不存在"));

        if (index < 0 || index >= task.SubTasks.Count)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "子步骤索引越界"));

        task.SubTasks[index].Done = req.Done;
        task.UpdatedAt = DateTime.UtcNow;

        await _db.PaTasks.ReplaceOneAsync(t => t.Id == id && t.UserId == userId, task);
        return Ok(ApiResponse<PaTask>.Ok(task));
    }

    public class UpdateSubTaskRequest
    {
        public bool Done { get; set; }
    }
}
