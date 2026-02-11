using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 总裁面板 - 全景数据控制器
/// </summary>
[ApiController]
[Route("api/executive")]
[Authorize]
[AdminController("executive", AdminPermissionCatalog.ExecutiveRead)]
public class ExecutiveController : ControllerBase
{
    private readonly MongoDbContext _db;

    public ExecutiveController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 全局概览 KPI
    /// </summary>
    [HttpGet("overview")]
    public async Task<IActionResult> GetOverview([FromQuery] int days = 7)
    {
        days = Math.Clamp(days, 1, 30);
        var now = DateTime.UtcNow;
        var today = now.Date;
        var periodStart = today.AddDays(-days + 1);
        var prevPeriodStart = periodStart.AddDays(-days);

        // 用户统计
        var totalUsers = await _db.Users.CountDocumentsAsync(_ => true);
        var activeUsers = await _db.Users.CountDocumentsAsync(u => u.LastActiveAt >= periodStart);
        var prevActiveUsers = await _db.Users.CountDocumentsAsync(u => u.LastActiveAt >= prevPeriodStart && u.LastActiveAt < periodStart);

        // 本期消息数
        var periodMessages = await _db.Messages.CountDocumentsAsync(m => m.Timestamp >= periodStart);
        var prevMessages = await _db.Messages.CountDocumentsAsync(m => m.Timestamp >= prevPeriodStart && m.Timestamp < periodStart);

        // 本期 Token 用量 (from messages)
        var tokenFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, periodStart) &
                          Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                          Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
        var tokenItems = await _db.Messages
            .Find(tokenFilter)
            .Project(m => new { input = m.TokenUsage!.Input, output = m.TokenUsage!.Output })
            .ToListAsync();
        var periodTokens = tokenItems.Sum(t => (long)t.input + t.output);

        var prevTokenFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, prevPeriodStart) &
                              Builders<Message>.Filter.Lt(m => m.Timestamp, periodStart) &
                              Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                              Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
        var prevTokenItems = await _db.Messages
            .Find(prevTokenFilter)
            .Project(m => new { input = m.TokenUsage!.Input, output = m.TokenUsage!.Output })
            .ToListAsync();
        var prevTokens = prevTokenItems.Sum(t => (long)t.input + t.output);

        // LLM 调用数 (from llm_request_logs, TTL aware)
        var llmCalls = await _db.LlmRequestLogs.CountDocumentsAsync(l => l.StartedAt >= periodStart);

        // 缺陷统计
        var totalDefects = await _db.DefectReports.CountDocumentsAsync(_ => true);
        var resolvedDefects = await _db.DefectReports.CountDocumentsAsync(d => d.Status == DefectStatus.Resolved || d.Status == DefectStatus.Closed);
        var defectResolutionRate = totalDefects > 0 ? Math.Round((double)resolvedDefects / totalDefects * 100, 1) : 0;

        // 图片生成数
        var periodImages = await _db.ImageGenRuns.CountDocumentsAsync(r => r.CreatedAt >= periodStart);

        return Ok(ApiResponse<object>.Ok(new
        {
            totalUsers,
            activeUsers,
            prevActiveUsers,
            periodMessages,
            prevMessages,
            periodTokens,
            prevTokens,
            llmCalls,
            totalDefects,
            resolvedDefects,
            defectResolutionRate,
            periodImages,
            days,
        }));
    }

    /// <summary>
    /// 每日使用趋势
    /// </summary>
    [HttpGet("trends")]
    public async Task<IActionResult> GetTrends([FromQuery] int days = 30)
    {
        days = Math.Clamp(days, 7, 90);
        var startDate = DateTime.UtcNow.Date.AddDays(-days + 1);

        // 消息按天
        var messages = await _db.Messages.Find(m => m.Timestamp >= startDate)
            .Project(m => new { m.Timestamp })
            .ToListAsync();

        // Token 按天
        var tokenFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, startDate) &
                          Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                          Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
        var tokens = await _db.Messages.Find(tokenFilter)
            .Project(m => new { m.Timestamp, input = m.TokenUsage!.Input, output = m.TokenUsage!.Output })
            .ToListAsync();

        var trend = Enumerable.Range(0, days)
            .Select(i => startDate.AddDays(i))
            .Select(date => new
            {
                date = date.ToString("yyyy-MM-dd"),
                messages = messages.Count(m => m.Timestamp.Date == date),
                tokens = tokens.Where(t => t.Timestamp.Date == date).Sum(t => t.input + t.output),
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(trend));
    }

    /// <summary>
    /// 团队成员洞察
    /// </summary>
    [HttpGet("team")]
    public async Task<IActionResult> GetTeam([FromQuery] int days = 7)
    {
        days = Math.Clamp(days, 1, 30);
        var periodStart = DateTime.UtcNow.Date.AddDays(-days + 1);

        var users = await _db.Users.Find(_ => true).ToListAsync();
        var result = new List<object>();

        foreach (var user in users)
        {
            if (user.UserType == UserType.Bot) continue;

            // 消息数 + Token
            var msgFilter = Builders<Message>.Filter.Eq(m => m.SenderId, user.UserId) &
                            Builders<Message>.Filter.Gte(m => m.Timestamp, periodStart);
            var userMessages = await _db.Messages.CountDocumentsAsync(msgFilter);

            // 助手消息的 Token (用户发的消息产生的助手回复)
            var assistantTokenFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, periodStart) &
                                       Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                                       Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
            // 通过 session 关联用户 — 简化处理：取所有助手消息
            // 更精确的做法需要 session->owner 关联，这里先按消息数反映活跃度

            // 会话数
            var sessionCount = await _db.Sessions.CountDocumentsAsync(s => s.OwnerUserId == user.UserId && s.CreatedAt >= periodStart);

            // 缺陷
            var defectsCreated = await _db.DefectReports.CountDocumentsAsync(d => d.ReporterId == user.UserId && d.CreatedAt >= periodStart);
            var defectsResolved = await _db.DefectReports.CountDocumentsAsync(d => d.ResolvedById == user.UserId && d.ResolvedAt >= periodStart);

            // 图片生成
            var imageRuns = await _db.ImageGenRuns.CountDocumentsAsync(r => r.OwnerAdminId == user.UserId && r.CreatedAt >= periodStart);

            // 活跃天数 (简化: 取 LastActiveAt)
            var isActive = user.LastActiveAt >= periodStart;

            result.Add(new
            {
                userId = user.UserId,
                username = user.Username,
                displayName = user.DisplayName ?? user.Username,
                role = user.Role.ToString(),
                avatarFileName = user.AvatarFileName,
                lastActiveAt = user.LastActiveAt,
                isActive,
                messages = userMessages,
                sessions = sessionCount,
                defectsCreated,
                defectsResolved,
                imageRuns,
            });
        }

        var sorted = result.OrderByDescending(u => ((dynamic)u).messages).ToList();
        return Ok(ApiResponse<object>.Ok(sorted));
    }

    /// <summary>
    /// Agent 使用统计
    /// </summary>
    [HttpGet("agents")]
    public async Task<IActionResult> GetAgents([FromQuery] int days = 7)
    {
        days = Math.Clamp(days, 1, 30);
        var periodStart = DateTime.UtcNow.Date.AddDays(-days + 1);

        // 从 llm_request_logs 的 RequestPurpose (AppCallerCode) 聚合
        var logs = await _db.LlmRequestLogs
            .Find(l => l.StartedAt >= periodStart && l.RequestPurpose != null)
            .Project(l => new
            {
                l.RequestPurpose,
                l.RequestPurposeDisplayName,
                l.UserId,
                l.InputTokens,
                l.OutputTokens,
                l.DurationMs,
            })
            .ToListAsync();

        // 按 appKey 聚合 (RequestPurpose 的第一个 . 前缀)
        var agentGroups = logs
            .GroupBy(l =>
            {
                var rp = l.RequestPurpose ?? "";
                var dotIndex = rp.IndexOf('.');
                return dotIndex > 0 ? rp[..dotIndex] : rp;
            })
            .Where(g => !string.IsNullOrEmpty(g.Key))
            .Select(g => new
            {
                appKey = g.Key,
                name = ResolveAgentName(g.Key),
                calls = g.Count(),
                users = g.Select(l => l.UserId).Where(u => u != null).Distinct().Count(),
                tokens = g.Sum(l => (long)(l.InputTokens ?? 0) + (l.OutputTokens ?? 0)),
                avgDurationMs = g.Average(l => l.DurationMs ?? 0),
            })
            .OrderByDescending(a => a.calls)
            .ToList();

        return Ok(ApiResponse<object>.Ok(agentGroups));
    }

    /// <summary>
    /// 模型使用统计
    /// </summary>
    [HttpGet("models")]
    public async Task<IActionResult> GetModels([FromQuery] int days = 7)
    {
        days = Math.Clamp(days, 1, 30);
        var periodStart = DateTime.UtcNow.Date.AddDays(-days + 1);

        var logs = await _db.LlmRequestLogs
            .Find(l => l.StartedAt >= periodStart && l.Model != null)
            .Project(l => new { l.Model, l.InputTokens, l.OutputTokens, l.DurationMs })
            .ToListAsync();

        var modelGroups = logs
            .GroupBy(l => l.Model ?? "unknown")
            .Select(g => new
            {
                model = g.Key,
                calls = g.Count(),
                inputTokens = g.Sum(l => (long)(l.InputTokens ?? 0)),
                outputTokens = g.Sum(l => (long)(l.OutputTokens ?? 0)),
                totalTokens = g.Sum(l => (long)(l.InputTokens ?? 0) + (l.OutputTokens ?? 0)),
                avgDurationMs = Math.Round(g.Average(l => l.DurationMs ?? 0), 1),
            })
            .OrderByDescending(m => m.calls)
            .ToList();

        return Ok(ApiResponse<object>.Ok(modelGroups));
    }

    /// <summary>
    /// 排行榜矩阵 — 每个用户在每个维度的使用量
    /// </summary>
    [HttpGet("leaderboard")]
    public async Task<IActionResult> GetLeaderboard([FromQuery] int days = 7)
    {
        days = Math.Clamp(days, 1, 30);
        var periodStart = DateTime.UtcNow.Date.AddDays(-days + 1);

        // 所有非 Bot 用户
        var allUsers = await _db.Users.Find(_ => true).ToListAsync();
        var humanUsers = allUsers.Where(u => u.UserType != UserType.Bot).ToList();
        var userIds = humanUsers.Select(u => u.UserId).ToHashSet();

        // --- Agent 使用量 (llm_request_logs 按 appKey + userId 聚合) ---
        var logs = await _db.LlmRequestLogs
            .Find(l => l.StartedAt >= periodStart && l.RequestPurpose != null && l.UserId != null)
            .Project(l => new { l.UserId, l.RequestPurpose })
            .ToListAsync();

        var agentUserCounts = logs
            .Where(l => l.UserId != null && userIds.Contains(l.UserId))
            .GroupBy(l =>
            {
                var rp = l.RequestPurpose ?? "";
                var dotIndex = rp.IndexOf('.');
                return dotIndex > 0 ? rp[..dotIndex] : rp;
            })
            .Where(g => !string.IsNullOrEmpty(g.Key))
            .ToDictionary(
                g => g.Key,
                g => g.GroupBy(x => x.UserId!).ToDictionary(ug => ug.Key, ug => ug.Count())
            );

        // --- 消息数 ---
        var msgItems = await _db.Messages
            .Find(m => m.Timestamp >= periodStart)
            .Project(m => new { m.SenderId })
            .ToListAsync();
        var msgByUser = msgItems
            .Where(m => m.SenderId != null && userIds.Contains(m.SenderId))
            .GroupBy(m => m.SenderId!)
            .ToDictionary(g => g.Key, g => g.Count());

        // --- 会话数 ---
        var sessionItems = await _db.Sessions
            .Find(s => s.CreatedAt >= periodStart)
            .Project(s => new { s.OwnerUserId })
            .ToListAsync();
        var sessionByUser = sessionItems
            .Where(s => s.OwnerUserId != null && userIds.Contains(s.OwnerUserId))
            .GroupBy(s => s.OwnerUserId!)
            .ToDictionary(g => g.Key, g => g.Count());

        // --- 缺陷提交 ---
        var dcItems = await _db.DefectReports
            .Find(d => d.CreatedAt >= periodStart)
            .Project(d => new { d.ReporterId })
            .ToListAsync();
        var defectsCreatedByUser = dcItems
            .Where(d => d.ReporterId != null && userIds.Contains(d.ReporterId))
            .GroupBy(d => d.ReporterId!)
            .ToDictionary(g => g.Key, g => g.Count());

        // --- 缺陷解决 ---
        var drItems = await _db.DefectReports
            .Find(d => d.ResolvedAt >= periodStart)
            .Project(d => new { d.ResolvedById })
            .ToListAsync();
        var defectsResolvedByUser = drItems
            .Where(d => d.ResolvedById != null && userIds.Contains(d.ResolvedById))
            .GroupBy(d => d.ResolvedById!)
            .ToDictionary(g => g.Key, g => g.Count());

        // --- 图片生成 ---
        var imgItems = await _db.ImageGenRuns
            .Find(r => r.CreatedAt >= periodStart)
            .Project(r => new { r.OwnerAdminId })
            .ToListAsync();
        var imageByUser = imgItems
            .Where(r => r.OwnerAdminId != null && userIds.Contains(r.OwnerAdminId))
            .GroupBy(r => r.OwnerAdminId!)
            .ToDictionary(g => g.Key, g => g.Count());

        // --- 加入群组数 (总量, 不受时间范围限制) ---
        var gmItems = await _db.GroupMembers
            .Find(_ => true)
            .Project(gm => new { gm.UserId })
            .ToListAsync();
        var groupsByUser = gmItems
            .Where(gm => userIds.Contains(gm.UserId))
            .GroupBy(gm => gm.UserId)
            .ToDictionary(g => g.Key, g => g.Count());

        // 用户列表 (按活跃度排序)
        var userList = humanUsers
            .OrderByDescending(u => u.LastActiveAt)
            .Select(u => new
            {
                userId = u.UserId,
                username = u.Username,
                displayName = u.DisplayName ?? u.Username,
                role = u.Role.ToString(),
                avatarFileName = u.AvatarFileName,
                lastActiveAt = u.LastActiveAt,
                isActive = u.LastActiveAt >= periodStart,
            })
            .ToList();

        // 构建维度
        var knownAgents = new[] { "prd-agent", "visual-agent", "literary-agent", "defect-agent", "ai-toolbox", "chat", "open-platform" };
        var dimensions = new List<object>();

        foreach (var appKey in knownAgents)
        {
            if (!agentUserCounts.TryGetValue(appKey, out var vals)) continue;
            dimensions.Add(new { key = appKey, name = ResolveAgentName(appKey), category = "agent", values = vals });
        }
        foreach (var kv in agentUserCounts.Where(kv => !knownAgents.Contains(kv.Key)))
        {
            dimensions.Add(new { key = kv.Key, name = ResolveAgentName(kv.Key), category = "agent", values = kv.Value });
        }

        dimensions.Add(new { key = "messages", name = "对话消息", category = "activity", values = msgByUser });
        dimensions.Add(new { key = "sessions", name = "会话数", category = "activity", values = sessionByUser });
        dimensions.Add(new { key = "defects-created", name = "缺陷提交", category = "activity", values = defectsCreatedByUser });
        dimensions.Add(new { key = "defects-resolved", name = "缺陷解决", category = "activity", values = defectsResolvedByUser });
        dimensions.Add(new { key = "images", name = "图片生成", category = "activity", values = imageByUser });
        dimensions.Add(new { key = "groups", name = "加入群组", category = "activity", values = groupsByUser });

        return Ok(ApiResponse<object>.Ok(new { users = userList, dimensions }));
    }

    private static string ResolveAgentName(string appKey) => appKey switch
    {
        "prd-agent" => "PRD Agent",
        "visual-agent" => "视觉创作 Agent",
        "literary-agent" => "文学创作 Agent",
        "defect-agent" => "缺陷管理 Agent",
        "ai-toolbox" => "AI 百宝箱",
        "open-platform" => "开放平台",
        "chat" => "对话",
        _ => appKey,
    };
}
