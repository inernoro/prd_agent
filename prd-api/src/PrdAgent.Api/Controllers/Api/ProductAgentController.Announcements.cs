using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    [HttpGet("version-workflow/announcements/records")]
    public async Task<IActionResult> GetAnnouncementRecords([FromServices] ProductAnnouncementSyncService sync,
        [FromQuery] int page = 1, [FromQuery] int pageSize = 20, [FromQuery] bool failedOnly = false, [FromQuery] string? search = null)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        return Ok(ApiResponse<ProductAnnouncementRecords>.Ok(await sync.RecordsAsync(page, pageSize, failedOnly, search)));
    }

    [HttpGet("version-workflow/announcements/status")]
    public async Task<IActionResult> GetAnnouncementSyncStatus([FromServices] ProductAnnouncementSyncService sync)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        return Ok(ApiResponse<ProductAnnouncementSyncStatus>.Ok(await sync.StatusAsync()));
    }

    [HttpPost("version-workflow/announcements/update")]
    public async Task<IActionResult> UpdateAnnouncements([FromServices] ProductAnnouncementSyncService sync,
        [FromServices] IConfiguration configuration)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        if (!DeploymentAuthority.CanRunSharedScheduledWork(configuration))
            return Conflict(ApiResponse<object>.Fail("ANNOUNCEMENT_PRODUCTION_ONLY", "请在正式环境更新全局版本公告，预览环境不会修改共享记录。"));
        return Ok(ApiResponse<ProductAnnouncementSyncStatus>.Ok(await sync.RequestAsync(GetUserId(), DateTime.UtcNow)));
    }
}
