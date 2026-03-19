using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 桌面更新加速缓存管理
/// </summary>
[ApiController]
[Route("api/desktop-update-cache")]
[Authorize]
[AdminController("settings", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public class DesktopUpdateCacheController : ControllerBase
{
    private readonly DesktopUpdateAccelerator _accelerator;
    private readonly MongoDbContext _db;
    private readonly ILogger<DesktopUpdateCacheController> _logger;

    public DesktopUpdateCacheController(
        DesktopUpdateAccelerator accelerator,
        MongoDbContext db,
        ILogger<DesktopUpdateCacheController> logger)
    {
        _accelerator = accelerator;
        _db = db;
        _logger = logger;
    }

    /// <summary>获取所有缓存记录</summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<List<DesktopUpdateCacheDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var list = await _accelerator.GetCacheStatusAsync(ct);
        var dto = list.Select(x => new DesktopUpdateCacheDto
        {
            Id = x.Id,
            Version = x.Version,
            Target = x.Target,
            Status = x.Status,
            CosPackageUrl = x.CosPackageUrl,
            ErrorMessage = x.ErrorMessage,
            PackageSizeBytes = x.PackageSizeBytes,
            GithubPackageUrl = x.GithubPackageUrl,
            CreatedAt = x.CreatedAt,
            UpdatedAt = x.UpdatedAt,
        }).ToList();

        return Ok(ApiResponse<List<DesktopUpdateCacheDto>>.Ok(dto));
    }

    /// <summary>手动触发缓存指定目标平台</summary>
    [HttpPost("trigger")]
    [ProducesResponseType(typeof(ApiResponse<string>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Trigger([FromBody] TriggerCacheRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request?.Target))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "target 不能为空"));

        var adminId = User.FindFirst("sub")?.Value ?? "unknown";
        _logger.LogWarning("Admin {AdminId} triggered update cache for {Target}", adminId, request.Target);

        var msg = await _accelerator.TriggerCacheAsync(request.Target, ct);
        return Ok(ApiResponse<string>.Ok(msg));
    }

    /// <summary>删除指定缓存记录</summary>
    [HttpDelete("{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var adminId = User.FindFirst("sub")?.Value ?? "unknown";
        _logger.LogWarning("Admin {AdminId} deleted update cache {Id}", adminId, id);

        await _db.DesktopUpdateCaches.DeleteOneAsync(x => x.Id == id, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }
}

public class TriggerCacheRequest
{
    public string Target { get; set; } = string.Empty;
}

public class DesktopUpdateCacheDto
{
    public string Id { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public string Target { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string? CosPackageUrl { get; set; }
    public string? ErrorMessage { get; set; }
    public long? PackageSizeBytes { get; set; }
    public string? GithubPackageUrl { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
