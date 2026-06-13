using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 行为信号采集端点（任意登录用户可上报，与管理端只读的洞察分析分离）。
/// 前端 behaviorTracker 批量上报路由级信号；写入失败静默，绝不影响业务。
/// </summary>
[ApiController]
[Route("api/behavior")]
[Authorize]
public class BehaviorController : ControllerBase
{
    private const int MaxBatch = 100;
    private const int MaxRouteLength = 200;

    private static readonly HashSet<string> AllowedTypes = new(StringComparer.Ordinal)
    {
        "route-dwell",
        "route-transition",
    };

    private readonly MongoDbContext _db;

    public BehaviorController(MongoDbContext db)
    {
        _db = db;
    }

    public record BehaviorEventDto(string Type, string Route, string? FromRoute, long? DwellMs, DateTime? OccurredAt);

    public record IngestRequest(List<BehaviorEventDto> Events);

    /// <summary>批量上报行为事件（超限截断、非法类型丢弃，永远 200）。</summary>
    [HttpPost("events")]
    public async Task<IActionResult> Ingest([FromBody] IngestRequest request)
    {
        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;
        var docs = (request.Events ?? new List<BehaviorEventDto>())
            .Where(e => e != null
                && AllowedTypes.Contains(e.Type ?? string.Empty)
                && !string.IsNullOrWhiteSpace(e.Route)
                && e.Route.Length <= MaxRouteLength
                && (e.FromRoute == null || e.FromRoute.Length <= MaxRouteLength)
                // dwell 上限 4 小时：防御客户端时钟异常产出脏数据
                && (e.DwellMs == null || (e.DwellMs >= 0 && e.DwellMs <= 4 * 3600_000L)))
            .Take(MaxBatch)
            .Select(e => new BehaviorEvent
            {
                UserId = userId,
                Type = e.Type!,
                Route = e.Route!,
                FromRoute = e.FromRoute,
                DwellMs = e.DwellMs,
                // 客户端时间只在合理偏移内采信，否则用服务端时间
                OccurredAt = e.OccurredAt.HasValue && Math.Abs((now - e.OccurredAt.Value.ToUniversalTime()).TotalHours) < 24
                    ? e.OccurredAt.Value.ToUniversalTime()
                    : now,
                CreatedAt = now,
            })
            .ToList();

        if (docs.Count > 0)
        {
            try
            {
                await _db.BehaviorEvents.InsertManyAsync(docs);
            }
            catch
            {
                // 行为采集失败不影响任何业务，静默
            }
        }

        return Ok(ApiResponse<object>.Ok(new { accepted = docs.Count }));
    }
}
