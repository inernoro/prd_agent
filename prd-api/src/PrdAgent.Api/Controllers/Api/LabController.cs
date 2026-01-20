using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.Tokens;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 实验室（模拟/演示）能力
/// </summary>
[ApiController]
[Route("api/lab")]
[Authorize]
[AdminController("lab", AdminPermissionCatalog.ModelsRead, WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class LabController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IConfiguration _config;
    private readonly ILogger<LabController> _logger;
    private readonly IChatService _chatService;
    private readonly IMessageRepository _messageRepository;
    private readonly IGroupMessageStreamHub _groupMessageStreamHub;
    private readonly ISessionService _sessionService;
    private readonly IGroupMessageSeqService _groupMessageSeqService;
    private readonly IServiceScopeFactory _serviceScopeFactory;

    public LabController(
        MongoDbContext db,
        IConfiguration config,
        ILogger<LabController> logger,
        IChatService chatService,
        IMessageRepository messageRepository,
        IGroupMessageStreamHub groupMessageStreamHub,
        ISessionService sessionService,
        IGroupMessageSeqService groupMessageSeqService,
        IServiceScopeFactory serviceScopeFactory)
    {
        _db = db;
        _config = config;
        _logger = logger;
        _chatService = chatService;
        _messageRepository = messageRepository;
        _groupMessageStreamHub = groupMessageStreamHub;
        _sessionService = sessionService;
        _groupMessageSeqService = groupMessageSeqService;
        _serviceScopeFactory = serviceScopeFactory;
    }

    /// <summary>
    /// 冒充指定用户签发短期 JWT（仅用于实验室演示）
    /// </summary>
    [HttpPost("impersonate")]
    [ProducesResponseType(typeof(ApiResponse<AdminImpersonateResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Impersonate([FromBody] AdminImpersonateRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.UserId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));
        }

        var adminId = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? User.FindFirst("sub")?.Value ?? "unknown";

        var user = await _db.Users.Find(u => u.UserId == request.UserId.Trim()).FirstOrDefaultAsync();
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        if (user.Status == UserStatus.Disabled)
        {
            return BadRequest(ApiResponse<object>.Fail("ACCOUNT_DISABLED", "账号已被禁用"));
        }

        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("JWT Secret not configured");
        var jwtIssuer = _config["Jwt:Issuer"] ?? "prdagent";
        var jwtAudience = _config["Jwt:Audience"] ?? "prdagent";

        var expiresInSeconds = Math.Max(60, Math.Min(3600, request.ExpiresInSeconds ?? 900)); // 默认15分钟，范围 1-60分钟
        var expiresAt = DateTime.UtcNow.AddSeconds(expiresInSeconds);

        var securityKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret));
        var credentials = new SigningCredentials(securityKey, SecurityAlgorithms.HmacSha256);

        // 同时写入 "role" 与 ClaimTypes.Role，最大化兼容性
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.UserId),
            new(JwtRegisteredClaimNames.UniqueName, user.Username),
            new("displayName", user.DisplayName),
            new("role", user.Role.ToString()),
            new(ClaimTypes.Role, user.Role.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("impersonatedBy", adminId)
        };

        var token = new JwtSecurityToken(
            issuer: jwtIssuer,
            audience: jwtAudience,
            claims: claims,
            expires: expiresAt,
            signingCredentials: credentials);

        var accessToken = new JwtSecurityTokenHandler().WriteToken(token);

        _logger.LogInformation("Admin impersonation issued: adminId={AdminId}, userId={UserId}, expiresIn={Expires}s",
            adminId, user.UserId, expiresInSeconds);

        var response = new AdminImpersonateResponse
        {
            AccessToken = accessToken,
            ExpiresIn = expiresInSeconds,
            User = new AdminImpersonateUser
            {
                UserId = user.UserId,
                Username = user.Username,
                DisplayName = user.DisplayName,
                Role = user.Role.ToString()
            }
        };

        return Ok(ApiResponse<AdminImpersonateResponse>.Ok(response));
    }

    /// <summary>
    /// 模拟发送消息到指定群组（用于测试推送功能）
    /// </summary>
    [HttpPost("simulate-message")]
    [ProducesResponseType(typeof(ApiResponse<SimulateMessageResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> SimulateMessage([FromBody] SimulateMessageRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.GroupId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupId 不能为空"));
        }

        if (string.IsNullOrWhiteSpace(request.Content))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "content 不能为空"));
        }

        var adminId = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? User.FindFirst("sub")?.Value ?? "unknown";

        // 查找群组
        var group = await _db.Groups.Find(g => g.GroupId == request.GroupId.Trim()).FirstOrDefaultAsync();
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));
        }

        // 如果需要触发 AI 回复，需要先创建/获取一个会话
        Session? session = null;
        if (request.TriggerAiReply)
        {
            if (string.IsNullOrEmpty(group.PrdDocumentId))
            {
                return BadRequest(ApiResponse<object>.Fail("NO_PRD_DOCUMENT", "群组尚未绑定 PRD 文档，无法触发 AI 回复"));
            }
            // 创建一个临时会话用于触发 AI 回复
            session = await _sessionService.CreateAsync(group.PrdDocumentId, group.GroupId);
        }

        // 查找管理员用户信息
        var adminUser = await _db.Users.Find(u => u.UserId == adminId).FirstOrDefaultAsync();

        // 获取群组的下一个 seq（使用专门的 seq 服务）
        var seq = await _groupMessageSeqService.NextAsync(group.GroupId);

        // 创建模拟的用户消息
        var userMessage = new Message
        {
            Id = Guid.NewGuid().ToString("N"),
            SessionId = session?.SessionId ?? $"admin-simulate-{adminId}",
            GroupId = group.GroupId,
            Role = MessageRole.User,
            Content = request.Content.Trim(),
            Timestamp = DateTime.UtcNow,
            GroupSeq = seq,
            SenderId = adminId,
            ViewRole = UserRole.PM,
        };

        await _messageRepository.InsertManyAsync(new[] { userMessage });

        // 广播到群组（通过 IGroupMessageStreamHub）
        _groupMessageStreamHub.Publish(userMessage);

        _logger.LogInformation("Admin simulated message: adminId={AdminId}, groupId={GroupId}, triggerAi={TriggerAi}, seq={Seq}",
            adminId, group.GroupId, request.TriggerAiReply, seq);

        // 如果需要触发 AI 回复
        if (request.TriggerAiReply && session != null)
        {
            // 异步触发 AI 回复（不阻塞返回）
            _ = Task.Run(async () =>
            {
                try
                {
                    // 注意：SendMessageAsync 会创建新的用户消息并生成 AI 回复
                    // 这里传入相同内容，会导致消息重复；但为了触发 AI，这是必要的
                    // 前端可通过 seq 去重
                    await foreach (var _ in _chatService.SendMessageAsync(
                        session.SessionId,
                        userMessage.Content,
                        userId: adminId,
                        cancellationToken: CancellationToken.None))
                    {
                        // 消费流式事件
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "SimulateMessage AI reply failed: groupId={GroupId}", group.GroupId);
                }
            });
        }

        return Ok(ApiResponse<SimulateMessageResponse>.Ok(new SimulateMessageResponse
        {
            MessageId = userMessage.Id,
            GroupSeq = seq,
            TriggerAiReply = request.TriggerAiReply,
        }));
    }

    /// <summary>
    /// 模拟流式发送：一次性发送3条流消息（带延迟），用于测试多机器人并发场景
    /// </summary>
    [HttpPost("simulate-stream-messages")]
    [ProducesResponseType(typeof(ApiResponse<SimulateStreamMessagesResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> SimulateStreamMessages([FromBody] SimulateStreamMessagesRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.GroupId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupId 不能为空"));
        }

        var adminId = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? User.FindFirst("sub")?.Value ?? "unknown";

        // 查找群组
        var group = await _db.Groups.Find(g => g.GroupId == request.GroupId.Trim()).FirstOrDefaultAsync();
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));
        }

        if (string.IsNullOrEmpty(group.PrdDocumentId))
        {
            return BadRequest(ApiResponse<object>.Fail("NO_PRD_DOCUMENT", "群组尚未绑定 PRD 文档，无法触发 AI 回复"));
        }

        // 获取三个机器人用户
        var botPm = await _db.Users.Find(u => u.Username == "bot_pm").FirstOrDefaultAsync();
        var botDev = await _db.Users.Find(u => u.Username == "bot_dev").FirstOrDefaultAsync();
        var botQa = await _db.Users.Find(u => u.Username == "bot_qa").FirstOrDefaultAsync();

        if (botPm == null || botDev == null || botQa == null)
        {
            return BadRequest(ApiResponse<object>.Fail("BOT_NOT_FOUND", "机器人用户不存在，请先初始化系统"));
        }

        _logger.LogInformation("SimulateStreamMessages: Starting async task for groupId={GroupId}", group.GroupId);

        // 异步执行：依次发送3条流消息（带延迟）
        // 使用 IServiceScopeFactory 创建新的作用域，避免 Scoped 服务被释放
        _ = Task.Run(async () =>
        {
            using var scope = _serviceScopeFactory.CreateScope();
            var seqService = scope.ServiceProvider.GetRequiredService<IGroupMessageSeqService>();
            var messageRepository = scope.ServiceProvider.GetRequiredService<IMessageRepository>();
            var logger = scope.ServiceProvider.GetRequiredService<ILogger<LabController>>();

            logger.LogInformation("SimulateStreamMessages: Async task started for groupId={GroupId}", group.GroupId);

            try
            {
                var bots = new[]
                {
                    new { User = botPm, Role = UserRole.PM, Content = request.Content1 ?? "这是 PM 机器人的测试回复，模拟流式输出场景。" },
                    new { User = botDev, Role = UserRole.DEV, Content = request.Content2 ?? "这是 DEV 机器人的测试回复，模拟并发流式输出。" },
                    new { User = botQa, Role = UserRole.QA, Content = request.Content3 ?? "这是 QA 机器人的测试回复，测试多消息不错乱。" }
                };

                foreach (var bot in bots)
                {
                    // 获取群组的下一个 seq（使用新作用域中的服务）
                    var seq = await seqService.NextAsync(group.GroupId);

                    // 创建 AI 占位消息（空内容）
                    var messageId = Guid.NewGuid().ToString("N");
                    var placeholderMessage = new Message
                    {
                        Id = messageId,
                        SessionId = $"admin-simulate-stream-{adminId}",
                        GroupId = group.GroupId,
                        Role = MessageRole.Assistant,
                        Content = "", // 空内容，标识为占位消息
                        Timestamp = DateTime.UtcNow,
                        GroupSeq = seq,
                        SenderId = bot.User.UserId,
                        ViewRole = bot.Role,
                    };

                    // 保存占位消息到 MongoDB（使用新作用域中的服务）
                    await messageRepository.InsertManyAsync(new[] { placeholderMessage });

                    // 立即广播占位消息（携带完整 sender 信息）
                    // 注意：_groupMessageStreamHub 是 Singleton，可以直接使用
                    _groupMessageStreamHub.Publish(placeholderMessage);

                    logger.LogInformation("Admin simulated stream message (placeholder): adminId={AdminId}, groupId={GroupId}, messageId={MessageId}, bot={Bot}",
                        adminId, group.GroupId, messageId, bot.User.Username);

                    // 模拟流式输出：分块发送内容
                    var content = bot.Content;
                    var chunkSize = Math.Max(5, content.Length / 10); // 每块约 1/10 内容
                    var isFirstChunk = true;
                    for (var i = 0; i < content.Length; i += chunkSize)
                    {
                        var chunk = content.Substring(i, Math.Min(chunkSize, content.Length - i));
                        
                        // 广播 delta 事件（第一个 chunk 标记为 isFirstChunk=true）
                        _groupMessageStreamHub.PublishDelta(group.GroupId, messageId, chunk, blockId: null, isFirstChunk);
                        isFirstChunk = false; // 后续 chunk 不再标记为 first

                        // 延迟 100-300ms，模拟真实流式输出
                        await Task.Delay(Random.Shared.Next(100, 300));
                    }

                    // 更新消息内容（完整内容）
                    placeholderMessage.Content = content;
                    placeholderMessage.Timestamp = DateTime.UtcNow;
                    await messageRepository.ReplaceOneAsync(placeholderMessage);

                    // 广播消息更新事件（用于在线客户端立即更新）
                    // 注意：使用 PublishUpdated 而非 Publish，避免因 seq 去重被跳过
                    _groupMessageStreamHub.PublishUpdated(placeholderMessage);

                    logger.LogInformation("Admin simulated stream message (completed): adminId={AdminId}, groupId={GroupId}, messageId={MessageId}, bot={Bot}",
                        adminId, group.GroupId, messageId, bot.User.Username);

                    // 每个机器人之间延迟 500-1000ms
                    await Task.Delay(Random.Shared.Next(500, 1000));
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "SimulateStreamMessages failed: groupId={GroupId}", group.GroupId);
            }
        });

        return Ok(ApiResponse<SimulateStreamMessagesResponse>.Ok(new SimulateStreamMessagesResponse
        {
            GroupId = group.GroupId,
            Message = "已启动模拟流式发送（3条消息，带延迟）",
        }));
    }
}

public class SimulateMessageRequest
{
    public string GroupId { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public bool TriggerAiReply { get; set; } = false;
}

public class SimulateMessageResponse
{
    public string MessageId { get; set; } = string.Empty;
    public long GroupSeq { get; set; }
    public bool TriggerAiReply { get; set; }
}

public class SimulateStreamMessagesRequest
{
    public string GroupId { get; set; } = string.Empty;
    
    /// <summary>PM 机器人的消息内容（可选，默认使用预设内容）</summary>
    public string? Content1 { get; set; }
    
    /// <summary>DEV 机器人的消息内容（可选，默认使用预设内容）</summary>
    public string? Content2 { get; set; }
    
    /// <summary>QA 机器人的消息内容（可选，默认使用预设内容）</summary>
    public string? Content3 { get; set; }
}

public class SimulateStreamMessagesResponse
{
    public string GroupId { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
}

public class AdminImpersonateRequest
{
    public string UserId { get; set; } = string.Empty;

    /// <summary>可选：有效期秒数（默认 900；范围 60-3600）</summary>
    public int? ExpiresInSeconds { get; set; }
}

public class AdminImpersonateResponse
{
    public string AccessToken { get; set; } = string.Empty;
    public int ExpiresIn { get; set; }
    public AdminImpersonateUser User { get; set; } = new();
}

public class AdminImpersonateUser
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
}


