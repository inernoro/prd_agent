using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 统计数据控制器
/// </summary>
[ApiController]
[Route("api/v1/admin/stats")]
[Authorize(Roles = "ADMIN")]
public class AdminStatsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AdminStatsController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 获取概览统计
    /// </summary>
    [HttpGet("overview")]
    public async Task<IActionResult> GetOverview()
    {
        var today = DateTime.UtcNow.Date;
        var weekAgo = today.AddDays(-7);

        var totalUsers = await _db.Users.CountDocumentsAsync(_ => true);
        var activeUsers = await _db.Users.CountDocumentsAsync(u => u.Status == UserStatus.Active);
        var totalGroups = await _db.Groups.CountDocumentsAsync(_ => true);
        var totalMessages = await _db.Messages.CountDocumentsAsync(_ => true);
        var todayMessages = await _db.Messages.CountDocumentsAsync(m => m.Timestamp >= today);

        var newUsersThisWeek = await _db.Users.CountDocumentsAsync(u => u.CreatedAt >= weekAgo);

        // 按角色统计用户
        var usersByRole = new
        {
            pm = await _db.Users.CountDocumentsAsync(u => u.Role == UserRole.PM),
            dev = await _db.Users.CountDocumentsAsync(u => u.Role == UserRole.DEV),
            qa = await _db.Users.CountDocumentsAsync(u => u.Role == UserRole.QA),
            admin = await _db.Users.CountDocumentsAsync(u => u.Role == UserRole.ADMIN)
        };

        return Ok(ApiResponse<object>.Ok(new
        {
            totalUsers,
            activeUsers,
            newUsersThisWeek,
            totalGroups,
            totalMessages,
            todayMessages,
            usersByRole
        }));
    }

    /// <summary>
    /// 获取消息趋势（最近30天）
    /// </summary>
    [HttpGet("message-trend")]
    public async Task<IActionResult> GetMessageTrend([FromQuery] int days = 30)
    {
        var startDate = DateTime.UtcNow.Date.AddDays(-days + 1);
        var messages = await _db.Messages.Find(m => m.Timestamp >= startDate).ToListAsync();

        var trend = Enumerable.Range(0, days)
            .Select(i => startDate.AddDays(i))
            .Select(date => new
            {
                date = date.ToString("yyyy-MM-dd"),
                count = messages.Count(m => m.Timestamp.Date == date)
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(trend));
    }

    /// <summary>
    /// 获取Token使用统计
    /// </summary>
    [HttpGet("token-usage")]
    public async Task<IActionResult> GetTokenUsage([FromQuery] int days = 7)
    {
        var startDate = DateTime.UtcNow.Date.AddDays(-days + 1);
        days = Math.Clamp(days, 1, 30);

        // 1) Chat 用量：来自 messages（长期保留）
        var messageFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, startDate) &
                           Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                           Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
        var chatItems = await _db.Messages
            .Find(messageFilter)
            .Project(m => new { m.Timestamp, input = m.TokenUsage!.Input, output = m.TokenUsage!.Output })
            .ToListAsync();

        // 2) 系统级用量补全：来自 llmrequestlogs（用于覆盖非 chat 的 LLM 调用；注意该集合默认 TTL=7天）
        //    为避免 chat 调用被重复计入，排除 RequestPurpose 以 "chat." 开头的日志。
        var logFilter = Builders<LlmRequestLog>.Filter.Gte(x => x.StartedAt, startDate) &
                        Builders<LlmRequestLog>.Filter.Ne(x => x.InputTokens, null) &
                        Builders<LlmRequestLog>.Filter.Ne(x => x.OutputTokens, null) &
                        Builders<LlmRequestLog>.Filter.Ne(x => x.Status, "running") &
                        Builders<LlmRequestLog>.Filter.Not(
                            Builders<LlmRequestLog>.Filter.Regex(
                                x => x.RequestPurpose,
                                new MongoDB.Bson.BsonRegularExpression("^chat\\.", "i")));
        var nonChatItems = await _db.LlmRequestLogs
            .Find(logFilter)
            .Project(x => new { x.StartedAt, input = x.InputTokens ?? 0, output = x.OutputTokens ?? 0 })
            .ToListAsync();

        var totalInput = chatItems.Sum(x => x.input) + nonChatItems.Sum(x => x.input);
        var totalOutput = chatItems.Sum(x => x.output) + nonChatItems.Sum(x => x.output);

        var dailyUsage = Enumerable.Range(0, days)
            .Select(i => startDate.AddDays(i))
            .Select(date =>
            {
                var dayChat = chatItems.Where(m => m.Timestamp.Date == date);
                var dayNonChat = nonChatItems.Where(l => l.StartedAt.Date == date);
                return new
                {
                    date = date.ToString("yyyy-MM-dd"),
                    input = dayChat.Sum(m => m.input) + dayNonChat.Sum(l => l.input),
                    output = dayChat.Sum(m => m.output) + dayNonChat.Sum(l => l.output)
                };
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            totalInput,
            totalOutput,
            totalTokens = totalInput + totalOutput,
            dailyUsage
        }));
    }

    /// <summary>
    /// 获取活跃群组统计
    /// </summary>
    [HttpGet("active-groups")]
    public async Task<IActionResult> GetActiveGroups([FromQuery] int limit = 10)
    {
        var groups = await _db.Groups.Find(_ => true).ToListAsync();
        var result = new List<object>();

        foreach (var group in groups)
        {
            var memberCount = await _db.GroupMembers.CountDocumentsAsync(m => m.GroupId == group.GroupId);
            var messageCount = await _db.Messages.CountDocumentsAsync(m => m.GroupId == group.GroupId);
            var gapCount = await _db.ContentGaps.CountDocumentsAsync(g => g.GroupId == group.GroupId);

            result.Add(new
            {
                group.GroupId,
                group.GroupName,
                memberCount,
                messageCount,
                gapCount,
                group.CreatedAt
            });
        }

        var sorted = result
            .OrderByDescending(g => ((dynamic)g).messageCount)
            .Take(limit)
            .ToList();

        return Ok(ApiResponse<object>.Ok(sorted));
    }

    /// <summary>
    /// 获取内容缺失统计
    /// </summary>
    [HttpGet("gap-stats")]
    public async Task<IActionResult> GetGapStats()
    {
        var gaps = await _db.ContentGaps.Find(_ => true).ToListAsync();

        var byStatus = new
        {
            pending = gaps.Count(g => g.Status == GapStatus.Pending),
            resolved = gaps.Count(g => g.Status == GapStatus.Resolved),
            ignored = gaps.Count(g => g.Status == GapStatus.Ignored)
        };

        var byType = new
        {
            flowMissing = gaps.Count(g => g.GapType == GapType.FlowMissing),
            boundaryUndefined = gaps.Count(g => g.GapType == GapType.BoundaryUndefined),
            exceptionUnhandled = gaps.Count(g => g.GapType == GapType.ExceptionUnhandled),
            dataFormatUnclear = gaps.Count(g => g.GapType == GapType.DataFormatUnclear),
            other = gaps.Count(g => g.GapType == GapType.Other)
        };

        return Ok(ApiResponse<object>.Ok(new
        {
            total = gaps.Count,
            byStatus,
            byType
        }));
    }
}
