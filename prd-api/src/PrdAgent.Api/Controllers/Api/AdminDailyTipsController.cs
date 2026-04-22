using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 小技巧管理 — 管理后台 CRUD。
/// 读需要 daily-tips.read 权限，写需要 daily-tips.write 权限。
/// </summary>
[ApiController]
[Route("api/admin/daily-tips")]
[Authorize]
[AdminController("daily-tips", AdminPermissionCatalog.DailyTipsRead, WritePermission = AdminPermissionCatalog.DailyTipsWrite)]
public sealed class AdminDailyTipsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AdminDailyTipsController(MongoDbContext db)
    {
        _db = db;
    }

    public sealed class TipUpsertRequest
    {
        public string Kind { get; set; } = "text";
        public string Title { get; set; } = string.Empty;
        public string? Body { get; set; }
        public string? CoverImageUrl { get; set; }
        public string ActionUrl { get; set; } = "/";
        public string? CtaText { get; set; }
        public string? TargetSelector { get; set; }
        public DailyTipAutoAction? AutoAction { get; set; }
        public string? TargetUserId { get; set; }
        public List<string>? TargetRoles { get; set; }
        public int DisplayOrder { get; set; } = 0;
        public bool IsActive { get; set; } = true;
        public DateTime? StartAt { get; set; }
        public DateTime? EndAt { get; set; }
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> List(CancellationToken ct = default)
    {
        var items = await _db.DailyTips
            .Find(Builders<DailyTip>.Filter.Empty)
            .SortBy(x => x.DisplayOrder)
            .ThenByDescending(x => x.CreatedAt)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Create([FromBody] TipUpsertRequest req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));
        if (!IsValidKind(req.Kind))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "kind 必须为 text / card / spotlight"));
        if (string.IsNullOrWhiteSpace(req.ActionUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "actionUrl 不能为空"));

        var now = DateTime.UtcNow;
        var tip = new DailyTip
        {
            Kind = req.Kind.Trim(),
            Title = req.Title.Trim(),
            Body = req.Body,
            CoverImageUrl = req.CoverImageUrl,
            ActionUrl = req.ActionUrl.Trim(),
            CtaText = string.IsNullOrWhiteSpace(req.CtaText) ? "去看看" : req.CtaText.Trim(),
            TargetSelector = req.TargetSelector,
            AutoAction = NormalizeAutoAction(req.AutoAction),
            TargetUserId = req.TargetUserId,
            TargetRoles = req.TargetRoles,
            DisplayOrder = req.DisplayOrder,
            IsActive = req.IsActive,
            StartAt = req.StartAt,
            EndAt = req.EndAt,
            SourceType = "manual",
            CreatedBy = this.GetRequiredUserId(),
            CreatedAt = now,
            UpdatedAt = now
        };
        await _db.DailyTips.InsertOneAsync(tip, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { item = tip }));
    }

    [HttpPut("{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Update([FromRoute] string id, [FromBody] TipUpsertRequest req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));
        if (!IsValidKind(req.Kind))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "kind 必须为 text / card / spotlight"));

        var update = Builders<DailyTip>.Update
            .Set(x => x.Kind, req.Kind.Trim())
            .Set(x => x.Title, req.Title.Trim())
            .Set(x => x.Body, req.Body)
            .Set(x => x.CoverImageUrl, req.CoverImageUrl)
            .Set(x => x.ActionUrl, req.ActionUrl?.Trim() ?? "/")
            .Set(x => x.CtaText, string.IsNullOrWhiteSpace(req.CtaText) ? "去看看" : req.CtaText!.Trim())
            .Set(x => x.TargetSelector, req.TargetSelector)
            .Set(x => x.AutoAction, NormalizeAutoAction(req.AutoAction))
            .Set(x => x.TargetUserId, req.TargetUserId)
            .Set(x => x.TargetRoles, req.TargetRoles)
            .Set(x => x.DisplayOrder, req.DisplayOrder)
            .Set(x => x.IsActive, req.IsActive)
            .Set(x => x.StartAt, req.StartAt)
            .Set(x => x.EndAt, req.EndAt)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var result = await _db.DailyTips.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "tip 不存在"));

        var tip = await _db.DailyTips.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { item = tip }));
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Delete([FromRoute] string id, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        var result = await _db.DailyTips.DeleteOneAsync(x => x.Id == id, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = result.DeletedCount > 0 }));
    }

    public sealed class PushRequest
    {
        public List<string> UserIds { get; set; } = new();
        public int MaxViews { get; set; } = 3;
        /// <summary>true 时覆盖重置已有投递的状态(count 归 0 / status -> pending)</summary>
        public bool Reset { get; set; } = false;
    }

    /// <summary>
    /// 将 tip 推送给指定用户(内嵌 Deliveries)。同一用户重复推送:
    /// - Reset=false(默认):若已有记录则保留已发生的统计(ViewCount / LastSeenAt),仅更新 MaxViews
    /// - Reset=true:把记录重置为 pending、计数归零(用于"再推一次")
    /// </summary>
    [HttpPost("{id}/push")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Push([FromRoute] string id, [FromBody] PushRequest req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        var userIds = (req.UserIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct()
            .ToList();
        if (userIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userIds 不能为空"));

        var maxViews = req.MaxViews <= 0 && req.MaxViews != -1 ? 3 : req.MaxViews;

        var tip = await _db.DailyTips.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (tip == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "tip 不存在"));

        var now = DateTime.UtcNow;
        var deliveries = tip.Deliveries ?? new List<DailyTipDelivery>();
        foreach (var uid in userIds)
        {
            var existing = deliveries.FirstOrDefault(d => d.UserId == uid);
            if (existing == null)
            {
                deliveries.Add(new DailyTipDelivery
                {
                    UserId = uid,
                    Status = "pending",
                    ViewCount = 0,
                    MaxViews = maxViews,
                    PushedAt = now,
                });
            }
            else if (req.Reset)
            {
                existing.Status = "pending";
                existing.ViewCount = 0;
                existing.MaxViews = maxViews;
                existing.PushedAt = now;
                existing.LastSeenAt = null;
                existing.ClickedAt = null;
                existing.DismissedAt = null;
            }
            else
            {
                existing.MaxViews = maxViews;
            }
        }

        var update = Builders<DailyTip>.Update
            .Set(x => x.Deliveries, deliveries)
            .Set(x => x.UpdatedAt, now);
        await _db.DailyTips.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            pushedCount = userIds.Count,
            totalDeliveries = deliveries.Count,
            deliveries,
        }));
    }

    /// <summary>
    /// 查看该 tip 的推送统计:每个用户的状态 + 汇总数字。
    /// </summary>
    [HttpGet("{id}/stats")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Stats([FromRoute] string id, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var tip = await _db.DailyTips.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (tip == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "tip 不存在"));

        var deliveries = tip.Deliveries ?? new List<DailyTipDelivery>();
        var userIds = deliveries.Select(d => d.UserId).Distinct().ToList();

        // 一次性查出所有用户的显示名,便于前端展示
        var nameMap = new Dictionary<string, string>();
        if (userIds.Count > 0)
        {
            var users = await _db.Users.Find(Builders<User>.Filter.In(x => x.UserId, userIds))
                .ToListAsync(ct);
            foreach (var u in users)
            {
                nameMap[u.UserId] = !string.IsNullOrEmpty(u.DisplayName) ? u.DisplayName : u.Username;
            }
        }

        var items = deliveries
            .Select(d => new
            {
                d.UserId,
                userDisplayName = nameMap.TryGetValue(d.UserId, out var name) ? name : (string?)null,
                d.Status,
                d.ViewCount,
                d.MaxViews,
                d.PushedAt,
                d.LastSeenAt,
                d.ClickedAt,
                d.DismissedAt,
            })
            .OrderByDescending(x => x.PushedAt)
            .ToList();

        var summary = new
        {
            total = deliveries.Count,
            pending = deliveries.Count(d => d.Status == "pending"),
            seen = deliveries.Count(d => d.Status == "seen"),
            clicked = deliveries.Count(d => d.Status == "clicked"),
            dismissed = deliveries.Count(d => d.Status == "dismissed"),
        };

        return Ok(ApiResponse<object>.Ok(new { summary, items }));
    }

    /// <summary>
    /// 一键植入内置默认 tip。幂等:按 SourceId 去重,已存在的不动。
    /// 用于 DailyTips 集合为空时让管理员一次性把 seed 变成真实数据,之后可以随便编辑 / 删除。
    /// </summary>
    [HttpPost("seed")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Seed(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var defaults = DailyTipsController.BuildDefaultTips(now);

        // 已有记录(按 SourceId 判重,SourceId 非空)
        var existingSourceIds = await _db.DailyTips
            .Find(Builders<DailyTip>.Filter.Ne<string?>(x => x.SourceId, null))
            .Project(x => x.SourceId)
            .ToListAsync(ct);
        var skip = existingSourceIds.Where(x => !string.IsNullOrEmpty(x)).ToHashSet();

        var toInsert = new List<DailyTip>();
        foreach (var seed in defaults)
        {
            if (!string.IsNullOrEmpty(seed.SourceId) && skip.Contains(seed.SourceId))
                continue;

            // 从 seed 克隆出真正入库用的记录:新 Id、CreatedBy 记录当前管理员、SourceType 仍保留 seed 便于后续识别
            toInsert.Add(new DailyTip
            {
                Kind = seed.Kind,
                Title = seed.Title,
                Body = seed.Body,
                CoverImageUrl = seed.CoverImageUrl,
                ActionUrl = seed.ActionUrl,
                CtaText = seed.CtaText,
                TargetSelector = seed.TargetSelector,
                AutoAction = seed.AutoAction,
                TargetUserId = null,
                TargetRoles = null,
                DisplayOrder = seed.DisplayOrder,
                IsActive = true,
                SourceType = "seed",
                SourceId = seed.SourceId,
                CreatedBy = this.GetRequiredUserId(),
                CreatedAt = now,
                UpdatedAt = now,
            });
        }

        if (toInsert.Count > 0)
        {
            await _db.DailyTips.InsertManyAsync(toInsert, cancellationToken: ct);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            insertedCount = toInsert.Count,
            skippedCount = defaults.Count - toInsert.Count,
            totalDefaults = defaults.Count,
        }));
    }

    /// <summary>
    /// 「清空并重新植入」:删除所有 DailyTip + 用 BuildDefaultTips 重新写入。
    /// 用于用户迭代规则后(例如「一步 tip 全部删掉」)一次性同步所有环境的 seed。
    /// 危险操作,前端点击时需二次确认。
    /// </summary>
    [HttpPost("reset")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Reset(CancellationToken ct = default)
    {
        var deleted = await _db.DailyTips.DeleteManyAsync(Builders<DailyTip>.Filter.Empty, ct);

        var now = DateTime.UtcNow;
        var defaults = DailyTipsController.BuildDefaultTips(now);
        var toInsert = defaults.Select(seed => new DailyTip
        {
            Kind = seed.Kind,
            Title = seed.Title,
            Body = seed.Body,
            CoverImageUrl = seed.CoverImageUrl,
            ActionUrl = seed.ActionUrl,
            CtaText = seed.CtaText,
            TargetSelector = seed.TargetSelector,
            AutoAction = seed.AutoAction,
            TargetUserId = null,
            TargetRoles = null,
            DisplayOrder = seed.DisplayOrder,
            IsActive = true,
            SourceType = "seed",
            SourceId = seed.SourceId,
            CreatedBy = this.GetRequiredUserId(),
            CreatedAt = now,
            UpdatedAt = now,
        }).ToList();

        if (toInsert.Count > 0)
        {
            await _db.DailyTips.InsertManyAsync(toInsert, cancellationToken: ct);
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            deletedCount = deleted.DeletedCount,
            insertedCount = toInsert.Count,
        }));
    }

    private static bool IsValidKind(string? kind)
        => kind is "text" or "card" or "spotlight";

    /// <summary>
    /// 归一化 AutoAction：全字段为空则返回 null（存成 null 比空对象好查询）；
    /// 否则修剪字符串、过滤无效 Step，给 Scroll 一个默认值。
    /// </summary>
    private static DailyTipAutoAction? NormalizeAutoAction(DailyTipAutoAction? a)
    {
        if (a == null) return null;
        var scroll = string.IsNullOrWhiteSpace(a.Scroll) ? null : a.Scroll.Trim();
        var expand = string.IsNullOrWhiteSpace(a.Expand) ? null : a.Expand.Trim();
        var autoClick = string.IsNullOrWhiteSpace(a.AutoClick) ? null : a.AutoClick.Trim();
        DailyTipPrefill? prefill = null;
        if (a.Prefill != null
            && !string.IsNullOrWhiteSpace(a.Prefill.Selector)
            && a.Prefill.Value != null)
        {
            prefill = new DailyTipPrefill
            {
                Selector = a.Prefill.Selector.Trim(),
                Value = a.Prefill.Value,
            };
        }
        var steps = a.Steps?
            .Where(s => s != null
                        && !string.IsNullOrWhiteSpace(s.Selector)
                        && !string.IsNullOrWhiteSpace(s.Title))
            .Select(s => new DailyTipTourStep
            {
                Selector = s.Selector.Trim(),
                Title = s.Title.Trim(),
                Body = string.IsNullOrWhiteSpace(s.Body) ? null : s.Body!.Trim(),
            })
            .ToList();
        if (steps != null && steps.Count == 0) steps = null;

        var allEmpty = scroll == null && expand == null && autoClick == null
                       && prefill == null && (steps == null || steps.Count == 0);
        if (allEmpty) return null;

        return new DailyTipAutoAction
        {
            Scroll = scroll,
            Expand = expand,
            AutoClick = autoClick,
            AutoClickDelayMs = a.AutoClickDelayMs is > 0 ? a.AutoClickDelayMs : null,
            Prefill = prefill,
            Steps = steps,
        };
    }
}
