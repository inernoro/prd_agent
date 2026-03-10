using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 苹果快捷指令 API — 通过 API Key 认证，支持一键收藏链接/视频/文章
/// </summary>
[ApiController]
[Route("api/shortcuts")]
public class ShortcutsController : ControllerBase
{
    private const string AppKey = "shortcuts-agent";

    private readonly MongoDbContext _db;
    private readonly IUrlParserService _urlParser;
    private readonly ILogger<ShortcutsController> _logger;

    public ShortcutsController(MongoDbContext db, IUrlParserService urlParser, ILogger<ShortcutsController> logger)
    {
        _db = db;
        _urlParser = urlParser;
        _logger = logger;
    }

    /// <summary>
    /// 收藏内容（快捷指令主入口）
    /// </summary>
    [Authorize(AuthenticationSchemes = "apikey")]
    [HttpPost("collect")]
    public async Task<IActionResult> Collect([FromBody] CollectRequest request, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "无效的 API Key"));

        if (string.IsNullOrWhiteSpace(request.Url) && string.IsNullOrWhiteSpace(request.Text))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "url 和 text 不能同时为空"));

        var urlToParse = request.Url ?? request.Text!;

        // 解析 URL
        var parseResult = await _urlParser.ParseAsync(urlToParse, ct);

        // 创建收藏记录
        var collection = new UserCollection
        {
            UserId = userId,
            ContentType = parseResult.Success ? parseResult.ContentType : ContentTypes.Link,
            Platform = parseResult.Success ? parseResult.Platform : Platforms.Other,
            SourceUrl = parseResult.SourceUrl,
            ResolvedUrl = parseResult.ResolvedUrl,
            Title = parseResult.Title,
            Description = parseResult.Description,
            CoverUrl = parseResult.CoverUrl,
            Author = parseResult.Author,
            Tags = request.Tags ?? new List<string>(),
            Source = "shortcuts",
            Note = request.Text != null && request.Url != null ? request.Text : null,
        };

        await _db.UserCollections.InsertOneAsync(collection, cancellationToken: ct);

        _logger.LogInformation(
            "Shortcut collect: {UserId} saved {ContentType} from {Platform} - {Title}",
            userId, collection.ContentType, collection.Platform, collection.Title ?? "(无标题)");

        // 同时创建 ChannelTask 记录（用于统一管理和追踪）
        var task = new ChannelTask
        {
            Id = GenerateTaskId(),
            ChannelType = ChannelTypes.Shortcuts,
            SenderIdentifier = userId,
            MappedUserId = userId,
            Intent = ChannelTaskIntent.SaveLink,
            TargetAgent = AppKey,
            OriginalContent = urlToParse,
            Status = ChannelTaskStatus.Completed,
            CompletedAt = DateTime.UtcNow,
            Result = new ChannelTaskResult
            {
                Type = "text",
                TextContent = collection.Title ?? "已收藏",
                Data = new Dictionary<string, object>
                {
                    ["collectionId"] = collection.Id,
                    ["contentType"] = collection.ContentType,
                    ["platform"] = collection.Platform
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

        return Ok(ApiResponse<object>.Ok(new
        {
            collection.Id,
            collection.ContentType,
            collection.Platform,
            collection.Title,
            collection.CoverUrl,
            collection.Author,
            collection.SourceUrl,
            Message = parseResult.Success
                ? $"已收藏: {collection.Title ?? collection.SourceUrl}"
                : $"已保存链接（{parseResult.Error}）"
        }));
    }

    /// <summary>
    /// 仅解析 URL 不保存（预览用）
    /// </summary>
    [Authorize(AuthenticationSchemes = "apikey")]
    [HttpPost("parse")]
    public async Task<IActionResult> Parse([FromBody] ParseRequest request, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "无效的 API Key"));

        if (string.IsNullOrWhiteSpace(request.Url))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "url 不能为空"));

        var result = await _urlParser.ParseAsync(request.Url, ct);

        return Ok(ApiResponse<UrlParseResult>.Ok(result));
    }

    /// <summary>
    /// 查询收藏列表（分页）
    /// </summary>
    [Authorize(AuthenticationSchemes = "apikey")]
    [HttpGet("collections")]
    public async Task<IActionResult> GetCollections(
        [FromQuery] string? contentType,
        [FromQuery] string? platform,
        [FromQuery] string? keyword,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetBoundUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "无效的 API Key"));

        var filterBuilder = Builders<UserCollection>.Filter;
        var filters = new List<FilterDefinition<UserCollection>>
        {
            filterBuilder.Eq(x => x.UserId, userId)
        };

        if (!string.IsNullOrWhiteSpace(contentType))
            filters.Add(filterBuilder.Eq(x => x.ContentType, contentType));

        if (!string.IsNullOrWhiteSpace(platform))
            filters.Add(filterBuilder.Eq(x => x.Platform, platform));

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                filterBuilder.Regex(x => x.Description, new MongoDB.Bson.BsonRegularExpression(keyword, "i")),
                filterBuilder.Regex(x => x.SourceUrl, new MongoDB.Bson.BsonRegularExpression(keyword, "i"))
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
            PageSize = pageSize,
            TotalPages = (int)Math.Ceiling((double)total / pageSize)
        }));
    }

    /// <summary>
    /// 删除收藏
    /// </summary>
    [Authorize(AuthenticationSchemes = "apikey")]
    [HttpDelete("collections/{id}")]
    public async Task<IActionResult> DeleteCollection([FromRoute] string id, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "无效的 API Key"));

        var result = await _db.UserCollections.DeleteOneAsync(
            x => x.Id == id && x.UserId == userId, ct);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "收藏不存在或无权限"));

        return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
    }

    /// <summary>
    /// 获取快捷指令模板列表（公开，无需认证）
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

    #region Admin API（管理员管理模板）

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

    private string? GetBoundUserId()
    {
        return User.FindFirst("boundUserId")?.Value;
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

public class CollectRequest
{
    /// <summary>要收藏的 URL</summary>
    public string? Url { get; set; }

    /// <summary>附加文字（或纯文本收藏）</summary>
    public string? Text { get; set; }

    /// <summary>标签</summary>
    public List<string>? Tags { get; set; }
}

public class ParseRequest
{
    /// <summary>要解析的 URL</summary>
    public string Url { get; set; } = string.Empty;
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
