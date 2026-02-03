using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 文学创作提示词管理（私有配置 + 海鲜市场公开共享）
/// </summary>
[ApiController]
[Route("api/literary-agent/prompts")]
[Authorize]
[AdminController("literary-agent", AdminPermissionCatalog.LiteraryAgentUse)]
public class LiteraryPromptsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public LiteraryPromptsController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    /// <summary>
    /// 获取当前用户信息（用于海鲜市场展示）
    /// </summary>
    private async Task<(string userId, string userName, string? avatarUrl)> GetCurrentUserInfoAsync(CancellationToken ct)
    {
        var adminId = GetAdminId();
        var user = await _db.Users.Find(u => u.UserId == adminId).FirstOrDefaultAsync(ct);
        var userName = user?.DisplayName ?? user?.Username ?? "未知用户";
        var avatarUrl = user?.AvatarFileName;
        return (adminId, userName, avatarUrl);
    }

    /// <summary>
    /// 获取当前用户的提示词列表（私有配置）
    /// </summary>
    /// <param name="scenarioType">场景类型（可选）：null/"global"=全局，"article-illustration"=文章配图，"image-gen"=图片生成</param>
    /// <param name="ct"></param>
    /// <returns></returns>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? scenarioType, CancellationToken ct)
    {
        var adminId = GetAdminId();

        // 基础过滤：只返回当前用户的配置
        var filterBuilder = Builders<LiteraryPrompt>.Filter;
        var filter = filterBuilder.Eq(x => x.OwnerUserId, adminId);

        // 场景筛选：支持全局共享（scenarioType=null/"global"）+ 指定场景
        if (!string.IsNullOrWhiteSpace(scenarioType) && scenarioType != "global")
        {
            // 查询：scenarioType == 指定值 OR scenarioType == null/"global"（全局共享）
            var scenarioFilter = filterBuilder.Or(
                filterBuilder.Eq(x => x.ScenarioType, scenarioType),
                filterBuilder.Eq(x => x.ScenarioType, null),
                filterBuilder.Eq(x => x.ScenarioType, "global")
            );
            filter = filterBuilder.And(filter, scenarioFilter);
        }

        var items = await _db.LiteraryPrompts
            .Find(filter)
            .SortBy(x => x.ScenarioType)
            .ThenBy(x => x.Order)
            .ThenByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 创建提示词
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateLiteraryPromptRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "title 不能为空"));
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "content 不能为空"));

        var scenarioType = string.IsNullOrWhiteSpace(request.ScenarioType) || request.ScenarioType == "global"
            ? null
            : request.ScenarioType.Trim();

        // 自动计算 order：同一场景下最大 order + 1
        var maxOrder = await _db.LiteraryPrompts
            .Find(x => x.ScenarioType == scenarioType)
            .SortByDescending(x => x.Order)
            .Project(x => x.Order)
            .FirstOrDefaultAsync(ct);

        var prompt = new LiteraryPrompt
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = adminId,
            Title = request.Title.Trim(),
            Content = request.Content.Trim(),
            ScenarioType = scenarioType,
            Order = maxOrder + 1,
            IsSystem = false,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.LiteraryPrompts.InsertOneAsync(prompt, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { prompt }));
    }

    /// <summary>
    /// 更新提示词
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateLiteraryPromptRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var prompt = await _db.LiteraryPrompts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (prompt == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提示词不存在"));

        // 只有创建者可以编辑
        if (prompt.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限编辑此提示词"));

        if (!string.IsNullOrWhiteSpace(request.Title))
            prompt.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Content))
            prompt.Content = request.Content.Trim();
        if (request.ScenarioType != null)
        {
            prompt.ScenarioType = string.IsNullOrWhiteSpace(request.ScenarioType) || request.ScenarioType == "global"
                ? null
                : request.ScenarioType.Trim();
        }
        if (request.Order.HasValue && request.Order.Value > 0)
            prompt.Order = request.Order.Value;

        // 如果是从海鲜市场下载的配置，修改后清除来源标记
        if (prompt.ForkedFromId != null)
        {
            prompt.IsModifiedAfterFork = true;
            // 清除来源信息（用户修改后不再显示来源）
            prompt.ForkedFromId = null;
            prompt.ForkedFromUserId = null;
            prompt.ForkedFromUserName = null;
            prompt.ForkedFromUserAvatar = null;
        }

        prompt.UpdatedAt = DateTime.UtcNow;

        await _db.LiteraryPrompts.ReplaceOneAsync(x => x.Id == id, prompt, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { prompt }));
    }

    /// <summary>
    /// 删除提示词
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var prompt = await _db.LiteraryPrompts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (prompt == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提示词不存在"));

        // 只有创建者可以删除
        if (prompt.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限删除此提示词"));

        // 系统预置不可删除
        if (prompt.IsSystem)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "系统预置提示词不可删除"));

        await _db.LiteraryPrompts.DeleteOneAsync(x => x.Id == id, ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    #region 海鲜市场 API

    /// <summary>
    /// 获取海鲜市场公开的提示词列表
    /// </summary>
    /// <param name="scenarioType">场景类型筛选（可选）</param>
    /// <param name="keyword">搜索关键词（按名称搜索）</param>
    /// <param name="sort">排序方式：hot=热门（按下载次数）, new=最新（按发布时间）</param>
    /// <param name="ct"></param>
    [HttpGet("marketplace")]
    public async Task<IActionResult> ListMarketplace(
        [FromQuery] string? scenarioType,
        [FromQuery] string? keyword,
        [FromQuery] string? sort,
        CancellationToken ct)
    {
        var filterBuilder = Builders<LiteraryPrompt>.Filter;
        var filter = filterBuilder.Eq(x => x.IsPublic, true);

        // 场景筛选
        if (!string.IsNullOrWhiteSpace(scenarioType) && scenarioType != "all")
        {
            var scenarioFilter = scenarioType == "global"
                ? filterBuilder.Or(
                    filterBuilder.Eq(x => x.ScenarioType, null),
                    filterBuilder.Eq(x => x.ScenarioType, "global"))
                : filterBuilder.Eq(x => x.ScenarioType, scenarioType);
            filter = filterBuilder.And(filter, scenarioFilter);
        }

        // 关键词搜索（按标题）
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            filter = filterBuilder.And(filter, filterBuilder.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(keyword, "i")));
        }

        var query = _db.LiteraryPrompts.Find(filter);

        // 排序
        query = sort switch
        {
            "hot" => query.SortByDescending(x => x.ForkCount).ThenByDescending(x => x.CreatedAt),
            "new" => query.SortByDescending(x => x.CreatedAt),
            _ => query.SortByDescending(x => x.ForkCount).ThenByDescending(x => x.CreatedAt) // 默认热门
        };

        var items = await query.ToListAsync(ct);

        // 获取所有作者信息
        var ownerIds = items.Select(x => x.OwnerUserId).Distinct().ToList();
        var owners = await _db.Users
            .Find(u => ownerIds.Contains(u.UserId))
            .ToListAsync(ct);
        var ownerMap = owners.ToDictionary(u => u.UserId, u => new { name = u.DisplayName ?? u.Username, avatar = u.AvatarFileName });

        var result = items.Select(x => new
        {
            x.Id,
            x.Title,
            x.Content,
            x.ScenarioType,
            x.ForkCount,
            x.CreatedAt,
            ownerUserId = x.OwnerUserId,
            ownerUserName = ownerMap.TryGetValue(x.OwnerUserId, out var o) ? o.name : "未知用户",
            ownerUserAvatar = ownerMap.TryGetValue(x.OwnerUserId, out var o2) ? o2.avatar : null,
        });

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 发布提示词到海鲜市场
    /// </summary>
    [HttpPost("{id}/publish")]
    public async Task<IActionResult> Publish(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var prompt = await _db.LiteraryPrompts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (prompt == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提示词不存在"));

        if (prompt.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限发布此提示词"));

        prompt.IsPublic = true;
        prompt.UpdatedAt = DateTime.UtcNow;

        await _db.LiteraryPrompts.ReplaceOneAsync(x => x.Id == id, prompt, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { prompt }));
    }

    /// <summary>
    /// 取消发布（从海鲜市场下架）
    /// </summary>
    [HttpPost("{id}/unpublish")]
    public async Task<IActionResult> Unpublish(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var prompt = await _db.LiteraryPrompts.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (prompt == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提示词不存在"));

        if (prompt.OwnerUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限操作此提示词"));

        prompt.IsPublic = false;
        prompt.UpdatedAt = DateTime.UtcNow;

        await _db.LiteraryPrompts.ReplaceOneAsync(x => x.Id == id, prompt, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { prompt }));
    }

    /// <summary>
    /// 免费下载（Fork）海鲜市场的配置
    /// </summary>
    [HttpPost("{id}/fork")]
    public async Task<IActionResult> Fork(string id, CancellationToken ct)
    {
        var (userId, userName, avatarUrl) = await GetCurrentUserInfoAsync(ct);

        var source = await _db.LiteraryPrompts.Find(x => x.Id == id && x.IsPublic).FirstOrDefaultAsync(ct);
        if (source == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "配置不存在或未公开"));

        // 获取原作者信息
        var sourceOwner = await _db.Users.Find(u => u.UserId == source.OwnerUserId).FirstOrDefaultAsync(ct);
        var sourceOwnerName = sourceOwner?.DisplayName ?? sourceOwner?.Username ?? "未知用户";
        var sourceOwnerAvatar = sourceOwner?.AvatarFileName;

        // 自动计算 order
        var maxOrder = await _db.LiteraryPrompts
            .Find(x => x.OwnerUserId == userId && x.ScenarioType == source.ScenarioType)
            .SortByDescending(x => x.Order)
            .Project(x => x.Order)
            .FirstOrDefaultAsync(ct);

        // 创建副本
        var forked = new LiteraryPrompt
        {
            Id = Guid.NewGuid().ToString("N"),
            OwnerUserId = userId,
            Title = source.Title,
            Content = source.Content,
            ScenarioType = source.ScenarioType,
            Order = maxOrder + 1,
            IsSystem = false,
            IsPublic = false, // 下载的配置默认不公开
            ForkCount = 0,
            ForkedFromId = source.Id,
            ForkedFromUserId = source.OwnerUserId,
            ForkedFromUserName = sourceOwnerName,
            ForkedFromUserAvatar = sourceOwnerAvatar,
            IsModifiedAfterFork = false,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.LiteraryPrompts.InsertOneAsync(forked, cancellationToken: ct);

        // 更新原配置的 ForkCount
        await _db.LiteraryPrompts.UpdateOneAsync(
            x => x.Id == id,
            Builders<LiteraryPrompt>.Update.Inc(x => x.ForkCount, 1),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { prompt = forked }));
    }

    #endregion
}

public class CreateLiteraryPromptRequest
{
    public string Title { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string? ScenarioType { get; set; }
}

public class UpdateLiteraryPromptRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? ScenarioType { get; set; }
    public int? Order { get; set; }
}
