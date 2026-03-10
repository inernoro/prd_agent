using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 苹果快捷指令 API — 支持创建个人快捷指令、扫码安装、一键收藏
/// </summary>
[ApiController]
[Route("api/shortcuts")]
public class ShortcutsController : ControllerBase
{
    private const string AppKey = "shortcuts-agent";

    private readonly MongoDbContext _db;
    private readonly ILogger<ShortcutsController> _logger;
    private readonly IConfiguration _config;

    public ShortcutsController(MongoDbContext db, ILogger<ShortcutsController> logger, IConfiguration config)
    {
        _db = db;
        _logger = logger;
        _config = config;
    }

    #region 快捷指令管理（JWT 认证）

    /// <summary>
    /// 创建快捷指令（生成 scs- token，仅返回一次）
    /// </summary>
    [Authorize]
    [HttpPost]
    public async Task<IActionResult> CreateShortcut([FromBody] CreateShortcutRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "名称不能为空"));

        // 生成 token
        var (token, hash, prefix) = UserShortcut.GenerateToken();

        var shortcut = new UserShortcut
        {
            UserId = userId,
            Name = request.Name.Trim(),
            TokenHash = hash,
            TokenPrefix = prefix,
            DeviceType = request.DeviceType ?? "ios"
        };

        await _db.UserShortcuts.InsertOneAsync(shortcut, cancellationToken: ct);

        _logger.LogInformation("Shortcut created: {Id} {Name} for user {UserId}", shortcut.Id, shortcut.Name, userId);

        // token 明文仅在创建时返回一次
        return Ok(ApiResponse<object>.Ok(new
        {
            shortcut.Id,
            shortcut.Name,
            shortcut.TokenPrefix,
            shortcut.DeviceType,
            Token = token, // 仅此一次
            shortcut.CreatedAt
        }));
    }

    /// <summary>
    /// 列出我的快捷指令
    /// </summary>
    [Authorize]
    [HttpGet]
    public async Task<IActionResult> ListMyShortcuts(CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var shortcuts = await _db.UserShortcuts
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        // 不返回 tokenHash
        var items = shortcuts.Select(s => new
        {
            s.Id,
            s.Name,
            s.TokenPrefix,
            s.DeviceType,
            s.IsActive,
            s.LastUsedAt,
            s.CollectCount,
            s.CreatedAt
        });

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 删除快捷指令（吊销 token）
    /// </summary>
    [Authorize]
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteShortcut([FromRoute] string id, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var result = await _db.UserShortcuts.DeleteOneAsync(
            x => x.Id == id && x.UserId == userId, ct);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "快捷指令不存在或无权限"));

        _logger.LogInformation("Shortcut deleted: {Id} by user {UserId}", id, userId);

        return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
    }

    /// <summary>
    /// 获取安装信息（供前端生成 QR 码）
    /// </summary>
    [Authorize]
    [HttpGet("{id}/setup")]
    public async Task<IActionResult> GetSetupInfo([FromRoute] string id, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var shortcut = await _db.UserShortcuts
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (shortcut == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "快捷指令不存在"));

        // 获取默认模板的 iCloud 链接
        var template = await _db.ShortcutTemplates
            .Find(x => x.IsDefault && x.IsActive)
            .FirstOrDefaultAsync(ct);

        var serverUrl = _config["ServerUrl"] ?? $"{Request.Scheme}://{Request.Host}";

        return Ok(ApiResponse<object>.Ok(new
        {
            shortcut.Id,
            shortcut.Name,
            shortcut.TokenPrefix,
            shortcut.DeviceType,
            ServerUrl = serverUrl,
            CollectEndpoint = $"{serverUrl}/api/shortcuts/collect",
            ICloudUrl = template?.ICloudUrl,
            TemplateName = template?.Name,
            TemplateVersion = template?.Version,
            Instructions = new
            {
                Ios = new[]
                {
                    "打开 iPhone 相机扫描二维码",
                    "在弹出的页面中点击「添加快捷指令」",
                    "授权允许快捷指令访问网络",
                    "回到任意 App，点击分享 → 选择此快捷指令即可收藏"
                },
                Android = new[]
                {
                    "安装 HTTP Shortcuts 应用（Google Play 可下载）",
                    "在应用中新建快捷方式",
                    $"设置 URL 为: {serverUrl}/api/shortcuts/collect",
                    "设置请求方式为 POST，添加 Authorization 头",
                    "保存后即可从分享菜单使用"
                }
            }
        }));
    }

    #endregion

    #region 收藏操作（scs- token 认证）

    /// <summary>
    /// 收藏链接/文本（快捷指令主入口）
    /// </summary>
    [AllowAnonymous]
    [HttpPost("collect")]
    public async Task<IActionResult> Collect([FromBody] CollectRequest request, CancellationToken ct)
    {
        // 手动校验 scs- token
        var shortcut = await ValidateShortcutTokenAsync(ct);
        if (shortcut == null)
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "无效的 token"));

        if (!shortcut.IsActive)
            return Unauthorized(ApiResponse<object>.Fail("DISABLED", "快捷指令已禁用"));

        if (string.IsNullOrWhiteSpace(request.Url) && string.IsNullOrWhiteSpace(request.Text))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "url 和 text 不能同时为空"));

        // 创建收藏
        var collection = new UserCollection
        {
            UserId = shortcut.UserId,
            ShortcutId = shortcut.Id,
            Url = request.Url?.Trim(),
            Text = request.Text?.Trim(),
            Tags = request.Tags ?? new List<string>(),
            Source = "shortcuts",
            Status = CollectionStatus.Saved
        };

        await _db.UserCollections.InsertOneAsync(collection, cancellationToken: ct);

        // 更新快捷指令使用统计
        await _db.UserShortcuts.UpdateOneAsync(
            x => x.Id == shortcut.Id,
            Builders<UserShortcut>.Update
                .Set(x => x.LastUsedAt, DateTime.UtcNow)
                .Inc(x => x.CollectCount, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        // 记录 ChannelTask（用于渠道管理统一追踪）
        var task = new ChannelTask
        {
            Id = GenerateTaskId(),
            ChannelType = ChannelTypes.Shortcuts,
            SenderIdentifier = shortcut.TokenPrefix,
            MappedUserId = shortcut.UserId,
            Intent = ChannelTaskIntent.SaveLink,
            TargetAgent = AppKey,
            OriginalContent = request.Url ?? request.Text ?? "",
            Status = ChannelTaskStatus.Completed,
            CompletedAt = DateTime.UtcNow,
            Result = new ChannelTaskResult
            {
                Type = "text",
                TextContent = "已收藏",
                Data = new Dictionary<string, object>
                {
                    ["collectionId"] = collection.Id,
                    ["shortcutId"] = shortcut.Id
                }
            }
        };
        task.StatusHistory.Add(new ChannelTaskStatusChange
        {
            Status = ChannelTaskStatus.Completed,
            At = DateTime.UtcNow,
            Note = "直接完成"
        });

        await _db.ChannelTasks.InsertOneAsync(task, cancellationToken: ct);

        _logger.LogInformation(
            "Shortcut collect: user {UserId} via {ShortcutName} saved {Url}",
            shortcut.UserId, shortcut.Name, request.Url ?? "(text)");

        return Ok(ApiResponse<object>.Ok(new
        {
            collection.Id,
            collection.Url,
            collection.Status,
            Message = "已收藏"
        }));
    }

    /// <summary>
    /// 查询我的收藏（分页，支持 JWT 或 scs- token）
    /// </summary>
    [AllowAnonymous]
    [HttpGet("collections")]
    public async Task<IActionResult> GetCollections(
        [FromQuery] string? keyword,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        // 支持两种认证方式
        string? userId = GetUserId(); // JWT
        if (string.IsNullOrEmpty(userId))
        {
            var shortcut = await ValidateShortcutTokenAsync(ct);
            userId = shortcut?.UserId;
        }

        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录或 token 无效"));

        var filterBuilder = Builders<UserCollection>.Filter;
        var filters = new List<FilterDefinition<UserCollection>>
        {
            filterBuilder.Eq(x => x.UserId, userId)
        };

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Regex(x => x.Url, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                filterBuilder.Regex(x => x.Text, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))
            ));
        }

        var filter = filterBuilder.And(filters);

        if (page < 1) page = 1;
        if (pageSize < 1) pageSize = 20;
        if (pageSize > 100) pageSize = 100;

        var total = await _db.UserCollections.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.UserCollections
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            Items = items,
            Total = (int)total,
            Page = page,
            PageSize = pageSize
        }));
    }

    /// <summary>
    /// 删除收藏
    /// </summary>
    [AllowAnonymous]
    [HttpDelete("collections/{id}")]
    public async Task<IActionResult> DeleteCollection([FromRoute] string id, CancellationToken ct)
    {
        // 支持两种认证方式
        string? userId = GetUserId();
        if (string.IsNullOrEmpty(userId))
        {
            var shortcut = await ValidateShortcutTokenAsync(ct);
            userId = shortcut?.UserId;
        }

        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录或 token 无效"));

        var result = await _db.UserCollections.DeleteOneAsync(
            x => x.Id == id && x.UserId == userId, ct);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "收藏不存在或无权限"));

        return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
    }

    #endregion

    #region 模板管理

    /// <summary>
    /// 获取快捷指令模板列表（公开）
    /// </summary>
    [AllowAnonymous]
    [HttpGet("templates")]
    public async Task<IActionResult> GetTemplates(CancellationToken ct)
    {
        var templates = await _db.ShortcutTemplates
            .Find(x => x.IsActive)
            .SortByDescending(x => x.IsDefault)
            .ThenByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { templates }));
    }

    /// <summary>
    /// 创建快捷指令模板（管理员）
    /// </summary>
    [Authorize]
    [HttpPost("admin/templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] CreateTemplateRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "名称不能为空"));

        if (string.IsNullOrWhiteSpace(request.ICloudUrl))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "iCloud 链接不能为空"));

        var template = new ShortcutTemplate
        {
            Name = request.Name,
            Description = request.Description,
            ICloudUrl = request.ICloudUrl,
            Version = request.Version ?? "1.0",
            IsDefault = request.IsDefault,
            CreatedBy = GetAdminId()
        };

        await _db.ShortcutTemplates.InsertOneAsync(template, cancellationToken: ct);

        _logger.LogInformation("Shortcut template created: {Id} {Name}", template.Id, template.Name);

        return Ok(ApiResponse<ShortcutTemplate>.Ok(template));
    }

    /// <summary>
    /// 删除快捷指令模板（管理员）
    /// </summary>
    [Authorize]
    [HttpDelete("admin/templates/{id}")]
    public async Task<IActionResult> DeleteTemplate([FromRoute] string id, CancellationToken ct)
    {
        var result = await _db.ShortcutTemplates.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "模板不存在"));

        return NoContent();
    }

    #endregion

    #region Helper Methods

    /// <summary>
    /// 从 Authorization: Bearer scs-xxx 中校验 token，返回对应 UserShortcut
    /// </summary>
    private async Task<UserShortcut?> ValidateShortcutTokenAsync(CancellationToken ct)
    {
        var authHeader = Request.Headers.Authorization.FirstOrDefault();
        if (string.IsNullOrEmpty(authHeader))
            return null;

        string? token = null;
        if (authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            token = authHeader["Bearer ".Length..].Trim();

        if (string.IsNullOrEmpty(token) || !token.StartsWith("scs-"))
            return null;

        var hash = UserShortcut.HashToken(token);

        return await _db.UserShortcuts
            .Find(x => x.TokenHash == hash)
            .FirstOrDefaultAsync(ct);
    }

    private string? GetUserId()
    {
        return User.FindFirst("sub")?.Value ?? User.FindFirst("userId")?.Value;
    }

    private string? GetAdminId()
    {
        return User.FindFirst("sub")?.Value ?? User.FindFirst("userId")?.Value;
    }

    private static string GenerateTaskId()
    {
        var date = DateTime.UtcNow.ToString("yyyyMMdd");
        var seq = Guid.NewGuid().ToString("N")[..6].ToUpper();
        return $"TASK-{date}-{seq}";
    }

    #endregion
}

#region Request DTOs

public class CreateShortcutRequest
{
    /// <summary>快捷指令名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>设备类型：ios / android / other</summary>
    public string? DeviceType { get; set; }
}

public class CollectRequest
{
    /// <summary>要收藏的 URL</summary>
    public string? Url { get; set; }

    /// <summary>附加文字（或纯文本收藏）</summary>
    public string? Text { get; set; }

    /// <summary>标签</summary>
    public List<string>? Tags { get; set; }
}

public class CreateTemplateRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string ICloudUrl { get; set; } = string.Empty;
    public string? Version { get; set; }
    public bool IsDefault { get; set; } = false;
}

#endregion
