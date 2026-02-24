using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 通道管理后台 API
/// </summary>
[ApiController]
[Authorize]
[Route("api/admin/channels")]
public class ChannelAdminController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IEmailChannelService _emailService;
    private readonly ILogger<ChannelAdminController> _logger;

    public ChannelAdminController(MongoDbContext db, IEmailChannelService emailService, ILogger<ChannelAdminController> logger)
    {
        _db = db;
        _emailService = emailService;
        _logger = logger;
    }

    #region Whitelist APIs

    /// <summary>
    /// 获取白名单列表（分页）
    /// </summary>
    [HttpGet("whitelist")]
    public async Task<IActionResult> GetWhitelistList([FromQuery] ChannelWhitelistQueryParams query, CancellationToken ct)
    {
        var filterBuilder = Builders<ChannelWhitelist>.Filter;
        var filters = new List<FilterDefinition<ChannelWhitelist>>();

        if (!string.IsNullOrWhiteSpace(query.ChannelType))
        {
            filters.Add(filterBuilder.Eq(x => x.ChannelType, query.ChannelType));
        }

        if (query.IsActive.HasValue)
        {
            filters.Add(filterBuilder.Eq(x => x.IsActive, query.IsActive.Value));
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Regex(x => x.IdentifierPattern, new MongoDB.Bson.BsonRegularExpression(query.Search, "i")),
                filterBuilder.Regex(x => x.Note, new MongoDB.Bson.BsonRegularExpression(query.Search, "i"))
            ));
        }

        var filter = filters.Count > 0 ? filterBuilder.And(filters) : filterBuilder.Empty;

        var total = await _db.ChannelWhitelists.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.ChannelWhitelists
            .Find(filter)
            .SortBy(x => x.Priority)
            .ThenByDescending(x => x.CreatedAt)
            .Skip((query.Page - 1) * query.PageSize)
            .Limit(query.PageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<PagedResponse<ChannelWhitelist>>.Ok(new PagedResponse<ChannelWhitelist>
        {
            Items = items,
            Total = (int)total,
            Page = query.Page,
            PageSize = query.PageSize
        }));
    }

    /// <summary>
    /// 获取单个白名单规则
    /// </summary>
    [HttpGet("whitelist/{id}")]
    public async Task<IActionResult> GetWhitelist([FromRoute] string id, CancellationToken ct)
    {
        var item = await _db.ChannelWhitelists.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "白名单规则不存在"));
        }

        return Ok(ApiResponse<ChannelWhitelist>.Ok(item));
    }

    /// <summary>
    /// 创建白名单规则
    /// </summary>
    [HttpPost("whitelist")]
    public async Task<IActionResult> CreateWhitelist([FromBody] UpsertChannelWhitelistRequest request, CancellationToken ct)
    {
        // 验证
        if (string.IsNullOrWhiteSpace(request.IdentifierPattern))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "身份模式不能为空"));
        }

        if (!ChannelTypes.All.Contains(request.ChannelType))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"不支持的通道类型: {request.ChannelType}"));
        }

        // 检查重复
        var existing = await _db.ChannelWhitelists
            .Find(x => x.ChannelType == request.ChannelType && x.IdentifierPattern == request.IdentifierPattern)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE", "该通道已存在相同的身份模式"));
        }

        // 如果绑定用户，获取用户名
        string? boundUserName = null;
        if (!string.IsNullOrWhiteSpace(request.BoundUserId))
        {
            var user = await _db.Users.Find(x => x.Id == request.BoundUserId).FirstOrDefaultAsync(ct);
            boundUserName = user?.DisplayName ?? user?.Username;
        }

        var item = new ChannelWhitelist
        {
            ChannelType = request.ChannelType,
            IdentifierPattern = request.IdentifierPattern,
            BoundUserId = request.BoundUserId,
            BoundUserName = boundUserName,
            AllowedAgents = request.AllowedAgents ?? new List<string>(),
            AllowedOperations = request.AllowedOperations ?? new List<string>(),
            DailyQuota = request.DailyQuota,
            Priority = request.Priority,
            IsActive = request.IsActive,
            Note = request.Note,
            CreatedBy = GetAdminId()
        };

        await _db.ChannelWhitelists.InsertOneAsync(item, cancellationToken: ct);

        _logger.LogInformation("Channel whitelist created: {Id} {Pattern} by {Admin}", item.Id, item.IdentifierPattern, item.CreatedBy);

        return CreatedAtAction(nameof(GetWhitelist), new { id = item.Id }, ApiResponse<ChannelWhitelist>.Ok(item));
    }

    /// <summary>
    /// 更新白名单规则
    /// </summary>
    [HttpPut("whitelist/{id}")]
    public async Task<IActionResult> UpdateWhitelist([FromRoute] string id, [FromBody] UpsertChannelWhitelistRequest request, CancellationToken ct)
    {
        var item = await _db.ChannelWhitelists.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "白名单规则不存在"));
        }

        // 验证
        if (string.IsNullOrWhiteSpace(request.IdentifierPattern))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "身份模式不能为空"));
        }

        // 检查重复（排除自身）
        var existing = await _db.ChannelWhitelists
            .Find(x => x.ChannelType == request.ChannelType && x.IdentifierPattern == request.IdentifierPattern && x.Id != id)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE", "该通道已存在相同的身份模式"));
        }

        // 如果绑定用户，获取用户名
        string? boundUserName = null;
        if (!string.IsNullOrWhiteSpace(request.BoundUserId))
        {
            var user = await _db.Users.Find(x => x.Id == request.BoundUserId).FirstOrDefaultAsync(ct);
            boundUserName = user?.DisplayName ?? user?.Username;
        }

        var update = Builders<ChannelWhitelist>.Update
            .Set(x => x.ChannelType, request.ChannelType)
            .Set(x => x.IdentifierPattern, request.IdentifierPattern)
            .Set(x => x.BoundUserId, request.BoundUserId)
            .Set(x => x.BoundUserName, boundUserName)
            .Set(x => x.AllowedAgents, request.AllowedAgents ?? new List<string>())
            .Set(x => x.AllowedOperations, request.AllowedOperations ?? new List<string>())
            .Set(x => x.DailyQuota, request.DailyQuota)
            .Set(x => x.Priority, request.Priority)
            .Set(x => x.IsActive, request.IsActive)
            .Set(x => x.Note, request.Note)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.ChannelWhitelists.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        _logger.LogInformation("Channel whitelist updated: {Id} by {Admin}", id, GetAdminId());

        var updated = await _db.ChannelWhitelists.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<ChannelWhitelist>.Ok(updated!));
    }

    /// <summary>
    /// 删除白名单规则
    /// </summary>
    [HttpDelete("whitelist/{id}")]
    public async Task<IActionResult> DeleteWhitelist([FromRoute] string id, CancellationToken ct)
    {
        var result = await _db.ChannelWhitelists.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "白名单规则不存在"));
        }

        _logger.LogInformation("Channel whitelist deleted: {Id} by {Admin}", id, GetAdminId());

        return NoContent();
    }

    /// <summary>
    /// 切换白名单启用/禁用状态
    /// </summary>
    [HttpPost("whitelist/{id}/toggle")]
    public async Task<IActionResult> ToggleWhitelist([FromRoute] string id, CancellationToken ct)
    {
        var item = await _db.ChannelWhitelists.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "白名单规则不存在"));
        }

        var newStatus = !item.IsActive;
        var update = Builders<ChannelWhitelist>.Update
            .Set(x => x.IsActive, newStatus)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.ChannelWhitelists.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        _logger.LogInformation("Channel whitelist toggled: {Id} IsActive={Status} by {Admin}", id, newStatus, GetAdminId());

        return Ok(ApiResponse<object>.Ok(new { id, isActive = newStatus }));
    }

    #endregion

    #region Identity Mapping APIs

    /// <summary>
    /// 获取身份映射列表（分页）
    /// </summary>
    [HttpGet("identity-mappings")]
    public async Task<IActionResult> GetIdentityMappingList([FromQuery] ChannelIdentityMappingQueryParams query, CancellationToken ct)
    {
        var filterBuilder = Builders<ChannelIdentityMapping>.Filter;
        var filters = new List<FilterDefinition<ChannelIdentityMapping>>();

        if (!string.IsNullOrWhiteSpace(query.ChannelType))
        {
            filters.Add(filterBuilder.Eq(x => x.ChannelType, query.ChannelType));
        }

        if (!string.IsNullOrWhiteSpace(query.UserId))
        {
            filters.Add(filterBuilder.Eq(x => x.UserId, query.UserId));
        }

        if (query.IsVerified.HasValue)
        {
            filters.Add(filterBuilder.Eq(x => x.IsVerified, query.IsVerified.Value));
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Regex(x => x.ChannelIdentifier, new MongoDB.Bson.BsonRegularExpression(query.Search, "i")),
                filterBuilder.Regex(x => x.UserName, new MongoDB.Bson.BsonRegularExpression(query.Search, "i"))
            ));
        }

        var filter = filters.Count > 0 ? filterBuilder.And(filters) : filterBuilder.Empty;

        var total = await _db.ChannelIdentityMappings.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.ChannelIdentityMappings
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((query.Page - 1) * query.PageSize)
            .Limit(query.PageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<PagedResponse<ChannelIdentityMapping>>.Ok(new PagedResponse<ChannelIdentityMapping>
        {
            Items = items,
            Total = (int)total,
            Page = query.Page,
            PageSize = query.PageSize
        }));
    }

    /// <summary>
    /// 创建身份映射
    /// </summary>
    [HttpPost("identity-mappings")]
    public async Task<IActionResult> CreateIdentityMapping([FromBody] UpsertChannelIdentityMappingRequest request, CancellationToken ct)
    {
        // 验证
        if (string.IsNullOrWhiteSpace(request.ChannelIdentifier))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "通道标识不能为空"));
        }

        if (string.IsNullOrWhiteSpace(request.UserId))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "用户ID不能为空"));
        }

        // 检查用户是否存在
        var user = await _db.Users.Find(x => x.Id == request.UserId).FirstOrDefaultAsync(ct);
        if (user == null)
        {
            return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "用户不存在"));
        }

        // 检查重复
        var existing = await _db.ChannelIdentityMappings
            .Find(x => x.ChannelType == request.ChannelType && x.ChannelIdentifier == request.ChannelIdentifier.ToLowerInvariant())
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE", "该通道标识已存在映射"));
        }

        var item = new ChannelIdentityMapping
        {
            ChannelType = request.ChannelType,
            ChannelIdentifier = request.ChannelIdentifier.ToLowerInvariant(),
            UserId = request.UserId,
            UserName = user.DisplayName ?? user.Username,
            IsVerified = request.IsVerified,
            VerifiedAt = request.IsVerified ? DateTime.UtcNow : null,
            CreatedBy = GetAdminId()
        };

        await _db.ChannelIdentityMappings.InsertOneAsync(item, cancellationToken: ct);

        _logger.LogInformation("Channel identity mapping created: {Id} {Identifier} -> {UserId} by {Admin}",
            item.Id, item.ChannelIdentifier, item.UserId, item.CreatedBy);

        return CreatedAtAction(nameof(GetIdentityMappingList), null, ApiResponse<ChannelIdentityMapping>.Ok(item));
    }

    /// <summary>
    /// 删除身份映射
    /// </summary>
    [HttpDelete("identity-mappings/{id}")]
    public async Task<IActionResult> DeleteIdentityMapping([FromRoute] string id, CancellationToken ct)
    {
        var result = await _db.ChannelIdentityMappings.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "身份映射不存在"));
        }

        _logger.LogInformation("Channel identity mapping deleted: {Id} by {Admin}", id, GetAdminId());

        return NoContent();
    }

    #endregion

    #region Task APIs

    /// <summary>
    /// 获取任务列表（分页）
    /// </summary>
    [HttpGet("tasks")]
    public async Task<IActionResult> GetTaskList([FromQuery] ChannelTaskQueryParams query, CancellationToken ct)
    {
        var filterBuilder = Builders<ChannelTask>.Filter;
        var filters = new List<FilterDefinition<ChannelTask>>();

        if (!string.IsNullOrWhiteSpace(query.ChannelType))
        {
            filters.Add(filterBuilder.Eq(x => x.ChannelType, query.ChannelType));
        }

        if (!string.IsNullOrWhiteSpace(query.Status))
        {
            filters.Add(filterBuilder.Eq(x => x.Status, query.Status));
        }

        if (!string.IsNullOrWhiteSpace(query.TargetAgent))
        {
            filters.Add(filterBuilder.Eq(x => x.TargetAgent, query.TargetAgent));
        }

        if (!string.IsNullOrWhiteSpace(query.SenderIdentifier))
        {
            filters.Add(filterBuilder.Regex(x => x.SenderIdentifier, new MongoDB.Bson.BsonRegularExpression(query.SenderIdentifier, "i")));
        }

        if (!string.IsNullOrWhiteSpace(query.MappedUserId))
        {
            filters.Add(filterBuilder.Eq(x => x.MappedUserId, query.MappedUserId));
        }

        if (query.StartDate.HasValue)
        {
            filters.Add(filterBuilder.Gte(x => x.CreatedAt, query.StartDate.Value));
        }

        if (query.EndDate.HasValue)
        {
            filters.Add(filterBuilder.Lte(x => x.CreatedAt, query.EndDate.Value));
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Regex(x => x.OriginalContent, new MongoDB.Bson.BsonRegularExpression(query.Search, "i")),
                filterBuilder.Regex(x => x.OriginalSubject, new MongoDB.Bson.BsonRegularExpression(query.Search, "i")),
                filterBuilder.Regex(x => x.SenderIdentifier, new MongoDB.Bson.BsonRegularExpression(query.Search, "i"))
            ));
        }

        var filter = filters.Count > 0 ? filterBuilder.And(filters) : filterBuilder.Empty;

        var total = await _db.ChannelTasks.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.ChannelTasks
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((query.Page - 1) * query.PageSize)
            .Limit(query.PageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<PagedResponse<ChannelTask>>.Ok(new PagedResponse<ChannelTask>
        {
            Items = items,
            Total = (int)total,
            Page = query.Page,
            PageSize = query.PageSize
        }));
    }

    /// <summary>
    /// 获取任务统计
    /// </summary>
    [HttpGet("tasks/stats")]
    public async Task<IActionResult> GetTaskStats([FromQuery] string? channelType, CancellationToken ct)
    {
        var filterBuilder = Builders<ChannelTask>.Filter;
        var baseFilter = string.IsNullOrWhiteSpace(channelType)
            ? filterBuilder.Empty
            : filterBuilder.Eq(x => x.ChannelType, channelType);

        var pendingCount = await _db.ChannelTasks.CountDocumentsAsync(
            filterBuilder.And(baseFilter, filterBuilder.Eq(x => x.Status, "pending")), cancellationToken: ct);
        var processingCount = await _db.ChannelTasks.CountDocumentsAsync(
            filterBuilder.And(baseFilter, filterBuilder.Eq(x => x.Status, "processing")), cancellationToken: ct);
        var completedCount = await _db.ChannelTasks.CountDocumentsAsync(
            filterBuilder.And(baseFilter, filterBuilder.Eq(x => x.Status, "completed")), cancellationToken: ct);
        var failedCount = await _db.ChannelTasks.CountDocumentsAsync(
            filterBuilder.And(baseFilter, filterBuilder.Eq(x => x.Status, "failed")), cancellationToken: ct);
        var cancelledCount = await _db.ChannelTasks.CountDocumentsAsync(
            filterBuilder.And(baseFilter, filterBuilder.Eq(x => x.Status, "cancelled")), cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            Pending = (int)pendingCount,
            Processing = (int)processingCount,
            Completed = (int)completedCount,
            Failed = (int)failedCount,
            Cancelled = (int)cancelledCount,
            Total = (int)(pendingCount + processingCount + completedCount + failedCount + cancelledCount)
        }));
    }

    /// <summary>
    /// 获取任务详情
    /// </summary>
    [HttpGet("tasks/{id}")]
    public async Task<IActionResult> GetTask([FromRoute] string id, CancellationToken ct)
    {
        var item = await _db.ChannelTasks.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "任务不存在"));
        }

        return Ok(ApiResponse<ChannelTask>.Ok(item));
    }

    /// <summary>
    /// 重试失败任务
    /// </summary>
    [HttpPost("tasks/{id}/retry")]
    public async Task<IActionResult> RetryTask([FromRoute] string id, CancellationToken ct)
    {
        var original = await _db.ChannelTasks.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (original == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "任务不存在"));
        }

        if (original.Status != ChannelTaskStatus.Failed && original.Status != ChannelTaskStatus.Cancelled)
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATUS", "只能重试失败或已取消的任务"));
        }

        if (original.RetryCount >= original.MaxRetries)
        {
            return BadRequest(ApiResponse<object>.Fail("MAX_RETRIES", "已达到最大重试次数"));
        }

        // 创建新任务
        var newTask = new ChannelTask
        {
            Id = GenerateTaskId(),
            ChannelType = original.ChannelType,
            ChannelMessageId = original.ChannelMessageId,
            SenderIdentifier = original.SenderIdentifier,
            SenderDisplayName = original.SenderDisplayName,
            MappedUserId = original.MappedUserId,
            MappedUserName = original.MappedUserName,
            WhitelistId = original.WhitelistId,
            Intent = original.Intent,
            TargetAgent = original.TargetAgent,
            OriginalContent = original.OriginalContent,
            OriginalSubject = original.OriginalSubject,
            ParsedParameters = original.ParsedParameters,
            Attachments = original.Attachments,
            Status = ChannelTaskStatus.Pending,
            RetryCount = original.RetryCount + 1,
            MaxRetries = original.MaxRetries,
            ParentTaskId = original.Id,
            Metadata = original.Metadata
        };

        newTask.StatusHistory.Add(new ChannelTaskStatusChange
        {
            Status = ChannelTaskStatus.Pending,
            At = DateTime.UtcNow,
            Note = $"Retry from {original.Id}"
        });

        await _db.ChannelTasks.InsertOneAsync(newTask, cancellationToken: ct);

        _logger.LogInformation("Channel task retried: {OriginalId} -> {NewId} by {Admin}", id, newTask.Id, GetAdminId());

        return Ok(ApiResponse<ChannelTask>.Ok(newTask));
    }

    /// <summary>
    /// 取消任务
    /// </summary>
    [HttpPost("tasks/{id}/cancel")]
    public async Task<IActionResult> CancelTask([FromRoute] string id, CancellationToken ct)
    {
        var task = await _db.ChannelTasks.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (task == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "任务不存在"));
        }

        if (task.Status != ChannelTaskStatus.Pending && task.Status != ChannelTaskStatus.Processing)
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATUS", "只能取消待处理或处理中的任务"));
        }

        var update = Builders<ChannelTask>.Update
            .Set(x => x.Status, ChannelTaskStatus.Cancelled)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .Push(x => x.StatusHistory, new ChannelTaskStatusChange
            {
                Status = ChannelTaskStatus.Cancelled,
                At = DateTime.UtcNow,
                Note = "Cancelled by admin"
            });

        await _db.ChannelTasks.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        _logger.LogInformation("Channel task cancelled: {Id} by {Admin}", id, GetAdminId());

        return Ok(ApiResponse<object>.Ok(new { id, status = ChannelTaskStatus.Cancelled }));
    }

    #endregion

    #region Stats API

    /// <summary>
    /// 获取通道统计数据
    /// </summary>
    [HttpGet("stats")]
    public async Task<IActionResult> GetStats(CancellationToken ct)
    {
        var today = DateTime.UtcNow.Date;
        var tomorrow = today.AddDays(1);

        // 各通道状态
        var channels = new List<ChannelStatusInfo>();
        foreach (var channelType in ChannelTypes.All)
        {
            var whitelistFilter = Builders<ChannelWhitelist>.Filter.And(
                Builders<ChannelWhitelist>.Filter.Eq(x => x.ChannelType, channelType),
                Builders<ChannelWhitelist>.Filter.Eq(x => x.IsActive, true)
            );
            var whitelistCount = await _db.ChannelWhitelists
                .CountDocumentsAsync(whitelistFilter, cancellationToken: ct);

            var todayTasks = await _db.ChannelTasks
                .Find(x => x.ChannelType == channelType && x.CreatedAt >= today && x.CreatedAt < tomorrow)
                .ToListAsync(ct);

            channels.Add(new ChannelStatusInfo
            {
                ChannelType = channelType,
                DisplayName = ChannelTypes.GetDisplayName(channelType),
                IsEnabled = whitelistCount > 0,
                TodayRequestCount = todayTasks.Count,
                TodaySuccessCount = todayTasks.Count(t => t.Status == ChannelTaskStatus.Completed),
                TodayFailCount = todayTasks.Count(t => t.Status == ChannelTaskStatus.Failed)
            });
        }

        // 今日任务统计
        var allTodayTasks = await _db.ChannelTasks
            .Find(x => x.CreatedAt >= today && x.CreatedAt < tomorrow)
            .ToListAsync(ct);

        var completedTasks = allTodayTasks.Where(t => t.Status == ChannelTaskStatus.Completed).ToList();
        var successRate = allTodayTasks.Count > 0
            ? (double)completedTasks.Count / allTodayTasks.Count * 100
            : 0;
        var avgDuration = completedTasks.Count > 0 && completedTasks.Any(t => t.DurationMs.HasValue)
            ? completedTasks.Where(t => t.DurationMs.HasValue).Average(t => t.DurationMs!.Value) / 1000.0
            : 0;

        // 总计数
        var totalWhitelistCount = await _db.ChannelWhitelists.CountDocumentsAsync(FilterDefinition<ChannelWhitelist>.Empty, cancellationToken: ct);
        var identityMappingCount = await _db.ChannelIdentityMappings.CountDocumentsAsync(FilterDefinition<ChannelIdentityMapping>.Empty, cancellationToken: ct);

        return Ok(ApiResponse<ChannelStatsResponse>.Ok(new ChannelStatsResponse
        {
            Channels = channels,
            TodayTaskCount = allTodayTasks.Count,
            ProcessingCount = allTodayTasks.Count(t => t.Status == ChannelTaskStatus.Processing),
            SuccessRate = Math.Round(successRate, 1),
            AvgDurationSeconds = Math.Round(avgDuration, 1),
            WhitelistCount = (int)totalWhitelistCount,
            IdentityMappingCount = (int)identityMappingCount
        }));
    }

    #endregion

    #region Settings API

    /// <summary>
    /// 获取邮箱配置
    /// </summary>
    [HttpGet("settings")]
    public async Task<IActionResult> GetSettings(CancellationToken ct)
    {
        var settings = await _db.ChannelSettings
            .Find(x => x.Id == "default")
            .FirstOrDefaultAsync(ct);

        if (settings == null)
        {
            // 返回默认配置
            settings = new ChannelSettings { Id = "default" };
        }

        // 不返回密码
        return Ok(ApiResponse<object>.Ok(new
        {
            settings.Id,
            settings.ImapHost,
            settings.ImapPort,
            settings.ImapUsername,
            ImapPassword = string.IsNullOrEmpty(settings.ImapPassword) ? null : "********",
            settings.ImapUseSsl,
            settings.ImapFolder,
            settings.SmtpHost,
            settings.SmtpPort,
            settings.SmtpUsername,
            SmtpPassword = string.IsNullOrEmpty(settings.SmtpPassword) ? null : "********",
            settings.SmtpUseSsl,
            settings.SmtpFromName,
            settings.SmtpFromAddress,
            settings.PollIntervalMinutes,
            settings.IsEnabled,
            settings.LastPollAt,
            settings.LastPollResult,
            settings.LastPollError,
            settings.LastPollEmailCount,
            settings.AcceptedDomains,
            settings.AutoAcknowledge,
            settings.MarkAsReadAfterProcess,
            settings.ProcessedFolder,
            settings.CreatedAt,
            settings.UpdatedAt
        }));
    }

    /// <summary>
    /// 更新邮箱配置
    /// </summary>
    [HttpPut("settings")]
    public async Task<IActionResult> UpdateSettings([FromBody] UpdateChannelSettingsRequest request, CancellationToken ct)
    {
        var existing = await _db.ChannelSettings
            .Find(x => x.Id == "default")
            .FirstOrDefaultAsync(ct);

        if (existing == null)
        {
            existing = new ChannelSettings { Id = "default" };
        }

        // 更新字段（只更新非空值）
        if (request.ImapHost != null) existing.ImapHost = request.ImapHost;
        if (request.ImapPort.HasValue) existing.ImapPort = request.ImapPort.Value;
        if (request.ImapUsername != null) existing.ImapUsername = request.ImapUsername;
        if (!string.IsNullOrEmpty(request.ImapPassword)) existing.ImapPassword = request.ImapPassword; // TODO: 加密存储
        if (request.ImapUseSsl.HasValue) existing.ImapUseSsl = request.ImapUseSsl.Value;
        if (request.ImapFolder != null) existing.ImapFolder = request.ImapFolder;

        if (request.SmtpHost != null) existing.SmtpHost = request.SmtpHost;
        if (request.SmtpPort.HasValue) existing.SmtpPort = request.SmtpPort.Value;
        if (request.SmtpUsername != null) existing.SmtpUsername = request.SmtpUsername;
        if (!string.IsNullOrEmpty(request.SmtpPassword)) existing.SmtpPassword = request.SmtpPassword; // TODO: 加密存储
        if (request.SmtpUseSsl.HasValue) existing.SmtpUseSsl = request.SmtpUseSsl.Value;
        if (request.SmtpFromName != null) existing.SmtpFromName = request.SmtpFromName;
        if (request.SmtpFromAddress != null) existing.SmtpFromAddress = request.SmtpFromAddress;

        if (request.PollIntervalMinutes.HasValue) existing.PollIntervalMinutes = request.PollIntervalMinutes.Value;
        if (request.IsEnabled.HasValue) existing.IsEnabled = request.IsEnabled.Value;

        if (request.AcceptedDomains != null) existing.AcceptedDomains = request.AcceptedDomains;
        if (request.AutoAcknowledge.HasValue) existing.AutoAcknowledge = request.AutoAcknowledge.Value;
        if (request.MarkAsReadAfterProcess.HasValue) existing.MarkAsReadAfterProcess = request.MarkAsReadAfterProcess.Value;
        if (request.ProcessedFolder != null) existing.ProcessedFolder = request.ProcessedFolder;

        existing.UpdatedAt = DateTime.UtcNow;

        await _db.ChannelSettings.ReplaceOneAsync(
            x => x.Id == "default",
            existing,
            new ReplaceOptions { IsUpsert = true },
            ct);

        _logger.LogInformation("Channel settings updated by {Admin}", GetAdminId());

        return Ok(ApiResponse<object>.Ok(new { message = "配置已更新" }));
    }

    /// <summary>
    /// 测试 IMAP 连接
    /// </summary>
    [HttpPost("settings/test")]
    public async Task<IActionResult> TestConnection([FromBody] TestConnectionRequest request, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(request.ImapHost) || string.IsNullOrEmpty(request.ImapUsername))
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                Success = false,
                Message = "请填写 IMAP 服务器地址和用户名"
            }));
        }

        _logger.LogInformation("Testing IMAP connection to {Host}:{Port}", request.ImapHost, request.ImapPort);

        var (success, message) = await _emailService.TestImapConnectionAsync(
            request.ImapHost,
            request.ImapPort,
            request.ImapUsername,
            request.ImapPassword,
            request.ImapUseSsl,
            ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            Success = success,
            Message = message
        }));
    }

    /// <summary>
    /// 手动触发邮件拉取
    /// </summary>
    [HttpPost("settings/poll")]
    public async Task<IActionResult> TriggerPoll(CancellationToken ct)
    {
        var settings = await _db.ChannelSettings
            .Find(x => x.Id == "default")
            .FirstOrDefaultAsync(ct);

        if (settings == null || !settings.IsEnabled)
        {
            return BadRequest(ApiResponse<object>.Fail("NOT_ENABLED", "邮件通道未启用"));
        }

        if (string.IsNullOrEmpty(settings.ImapHost) || string.IsNullOrEmpty(settings.ImapUsername))
        {
            return BadRequest(ApiResponse<object>.Fail("NOT_CONFIGURED", "请先配置 IMAP 服务器"));
        }

        _logger.LogInformation("Manual email poll triggered by {Admin}", GetAdminId());

        try
        {
            var emailCount = await _emailService.PollEmailsAsync(ct);
            return Ok(ApiResponse<object>.Ok(new
            {
                Success = true,
                Message = $"邮件轮询完成，处理了 {emailCount} 封邮件",
                EmailCount = emailCount
            }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Manual email poll failed");
            return Ok(ApiResponse<object>.Ok(new
            {
                Success = false,
                Message = $"邮件轮询失败：{ex.Message}",
                EmailCount = 0
            }));
        }
    }

    #endregion

    #region Workflow APIs

    /// <summary>
    /// 获取工作流邮箱列表
    /// </summary>
    [HttpGet("workflows")]
    public async Task<IActionResult> GetWorkflows(CancellationToken ct)
    {
        var workflows = await _db.EmailWorkflows
            .Find(_ => true)
            .SortBy(w => w.Priority)
            .ToListAsync(ct);

        // 获取配置的域名
        var settings = await _db.ChannelSettings.Find(s => s.Id == "default").FirstOrDefaultAsync(ct);
        var domain = settings?.AcceptedDomains.FirstOrDefault() ?? "example.com";

        var result = workflows.Select(w => new
        {
            w.Id,
            w.AddressPrefix,
            FullAddress = $"{w.AddressPrefix}@{domain}",
            w.DisplayName,
            w.Description,
            w.Icon,
            IntentType = w.IntentType.ToString(),
            w.TargetAgent,
            w.CustomPrompt,
            w.ReplyTemplate,
            w.IsActive,
            w.Priority,
            w.CreatedAt,
            w.UpdatedAt
        });

        return Ok(ApiResponse<object>.Ok(new { domain, workflows = result }));
    }

    /// <summary>
    /// 获取单个工作流
    /// </summary>
    [HttpGet("workflows/{id}")]
    public async Task<IActionResult> GetWorkflow([FromRoute] string id, CancellationToken ct)
    {
        var workflow = await _db.EmailWorkflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "工作流不存在"));
        }

        return Ok(ApiResponse<EmailWorkflow>.Ok(workflow));
    }

    /// <summary>
    /// 创建工作流邮箱
    /// </summary>
    [HttpPost("workflows")]
    public async Task<IActionResult> CreateWorkflow([FromBody] UpsertEmailWorkflowRequest request, CancellationToken ct)
    {
        // 验证前缀格式
        if (string.IsNullOrWhiteSpace(request.AddressPrefix))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "邮箱前缀不能为空"));
        }

        var prefix = request.AddressPrefix.ToLowerInvariant().Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(prefix, @"^[a-z0-9][a-z0-9._-]*$"))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "邮箱前缀只能包含小写字母、数字、点、下划线和连字符"));
        }

        // 检查重复
        var existing = await _db.EmailWorkflows.Find(w => w.AddressPrefix == prefix).FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE", $"前缀 '{prefix}' 已被使用"));
        }

        var workflow = new EmailWorkflow
        {
            AddressPrefix = prefix,
            DisplayName = request.DisplayName ?? prefix,
            Description = request.Description,
            Icon = request.Icon,
            IntentType = ParseIntentType(request.IntentType),
            TargetAgent = request.TargetAgent,
            CustomPrompt = request.CustomPrompt,
            ReplyTemplate = request.ReplyTemplate,
            IsActive = request.IsActive ?? true,
            Priority = request.Priority ?? 100,
            CreatedBy = GetAdminId()
        };

        await _db.EmailWorkflows.InsertOneAsync(workflow, cancellationToken: ct);

        _logger.LogInformation("Email workflow created: {Id} {Prefix} by {Admin}", workflow.Id, prefix, workflow.CreatedBy);

        return CreatedAtAction(nameof(GetWorkflow), new { id = workflow.Id }, ApiResponse<EmailWorkflow>.Ok(workflow));
    }

    /// <summary>
    /// 更新工作流邮箱
    /// </summary>
    [HttpPut("workflows/{id}")]
    public async Task<IActionResult> UpdateWorkflow([FromRoute] string id, [FromBody] UpsertEmailWorkflowRequest request, CancellationToken ct)
    {
        var workflow = await _db.EmailWorkflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "工作流不存在"));
        }

        // 如果修改前缀，检查重复
        if (!string.IsNullOrEmpty(request.AddressPrefix))
        {
            var prefix = request.AddressPrefix.ToLowerInvariant().Trim();
            if (prefix != workflow.AddressPrefix)
            {
                var existing = await _db.EmailWorkflows.Find(w => w.AddressPrefix == prefix && w.Id != id).FirstOrDefaultAsync(ct);
                if (existing != null)
                {
                    return BadRequest(ApiResponse<object>.Fail("DUPLICATE", $"前缀 '{prefix}' 已被使用"));
                }
            }
        }

        var update = Builders<EmailWorkflow>.Update
            .Set(w => w.UpdatedAt, DateTime.UtcNow);

        if (!string.IsNullOrEmpty(request.AddressPrefix))
            update = update.Set(w => w.AddressPrefix, request.AddressPrefix.ToLowerInvariant().Trim());
        if (request.DisplayName != null)
            update = update.Set(w => w.DisplayName, request.DisplayName);
        if (request.Description != null)
            update = update.Set(w => w.Description, request.Description);
        if (request.Icon != null)
            update = update.Set(w => w.Icon, request.Icon);
        if (!string.IsNullOrEmpty(request.IntentType))
            update = update.Set(w => w.IntentType, ParseIntentType(request.IntentType));
        if (request.TargetAgent != null)
            update = update.Set(w => w.TargetAgent, request.TargetAgent);
        if (request.CustomPrompt != null)
            update = update.Set(w => w.CustomPrompt, request.CustomPrompt);
        if (request.ReplyTemplate != null)
            update = update.Set(w => w.ReplyTemplate, request.ReplyTemplate);
        if (request.IsActive.HasValue)
            update = update.Set(w => w.IsActive, request.IsActive.Value);
        if (request.Priority.HasValue)
            update = update.Set(w => w.Priority, request.Priority.Value);

        await _db.EmailWorkflows.UpdateOneAsync(w => w.Id == id, update, cancellationToken: ct);

        _logger.LogInformation("Email workflow updated: {Id} by {Admin}", id, GetAdminId());

        var updated = await _db.EmailWorkflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<EmailWorkflow>.Ok(updated!));
    }

    /// <summary>
    /// 删除工作流邮箱
    /// </summary>
    [HttpDelete("workflows/{id}")]
    public async Task<IActionResult> DeleteWorkflow([FromRoute] string id, CancellationToken ct)
    {
        var result = await _db.EmailWorkflows.DeleteOneAsync(w => w.Id == id, ct);
        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "工作流不存在"));
        }

        _logger.LogInformation("Email workflow deleted: {Id} by {Admin}", id, GetAdminId());

        return NoContent();
    }

    /// <summary>
    /// 切换工作流启用状态
    /// </summary>
    [HttpPost("workflows/{id}/toggle")]
    public async Task<IActionResult> ToggleWorkflow([FromRoute] string id, CancellationToken ct)
    {
        var workflow = await _db.EmailWorkflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
        {
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "工作流不存在"));
        }

        var newStatus = !workflow.IsActive;
        await _db.EmailWorkflows.UpdateOneAsync(
            w => w.Id == id,
            Builders<EmailWorkflow>.Update
                .Set(w => w.IsActive, newStatus)
                .Set(w => w.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation("Email workflow toggled: {Id} IsActive={Status} by {Admin}", id, newStatus, GetAdminId());

        return Ok(ApiResponse<object>.Ok(new { id, isActive = newStatus }));
    }

    /// <summary>
    /// 初始化默认工作流
    /// </summary>
    [HttpPost("workflows/init-defaults")]
    public async Task<IActionResult> InitDefaultWorkflows(CancellationToken ct)
    {
        var existing = await _db.EmailWorkflows.CountDocumentsAsync(_ => true, cancellationToken: ct);
        if (existing > 0)
        {
            return BadRequest(ApiResponse<object>.Fail("ALREADY_EXISTS", "已存在工作流配置，请手动管理"));
        }

        var defaults = EmailWorkflowTemplates.GetDefaults();
        foreach (var workflow in defaults)
        {
            workflow.CreatedBy = GetAdminId();
        }

        await _db.EmailWorkflows.InsertManyAsync(defaults, cancellationToken: ct);

        _logger.LogInformation("Default email workflows initialized by {Admin}", GetAdminId());

        return Ok(ApiResponse<object>.Ok(new { message = $"已创建 {defaults.Count} 个默认工作流", count = defaults.Count }));
    }

    /// <summary>
    /// 获取可用的意图类型
    /// </summary>
    [HttpGet("workflows/intent-types")]
    public IActionResult GetIntentTypes()
    {
        var types = Enum.GetValues<EmailIntentType>()
            .Where(t => t != EmailIntentType.Unknown && t != EmailIntentType.FYI)
            .Select(t => new
            {
                Value = t.ToString(),
                DisplayName = GetIntentDisplayName(t)
            });

        return Ok(ApiResponse<object>.Ok(types));
    }

    private static EmailIntentType ParseIntentType(string? intentType)
    {
        if (string.IsNullOrEmpty(intentType)) return EmailIntentType.Unknown;
        return Enum.TryParse<EmailIntentType>(intentType, true, out var result) ? result : EmailIntentType.Unknown;
    }

    private static string GetIntentDisplayName(EmailIntentType type) => type switch
    {
        EmailIntentType.Classify => "邮件分类",
        EmailIntentType.CreateTodo => "创建待办",
        EmailIntentType.Summarize => "内容摘要",
        EmailIntentType.FollowUp => "需要跟进",
        _ => type.ToString()
    };

    #endregion

    #region Helper Methods

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
