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
        var messages = await _db.Messages.Find(
            m => m.Timestamp >= startDate && 
                 m.Role == MessageRole.Assistant && 
                 m.TokenUsage != null)
            .ToListAsync();

        var totalInput = messages.Sum(m => m.TokenUsage?.Input ?? 0);
        var totalOutput = messages.Sum(m => m.TokenUsage?.Output ?? 0);

        var dailyUsage = Enumerable.Range(0, days)
            .Select(i => startDate.AddDays(i))
            .Select(date =>
            {
                var dayMessages = messages.Where(m => m.Timestamp.Date == date);
                return new
                {
                    date = date.ToString("yyyy-MM-dd"),
                    input = dayMessages.Sum(m => m.TokenUsage?.Input ?? 0),
                    output = dayMessages.Sum(m => m.TokenUsage?.Output ?? 0)
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





