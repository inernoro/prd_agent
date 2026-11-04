using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    [HttpGet("overview/version-workflow/release-backup")]
    public async Task<IActionResult> ExportReleaseBackup([FromServices] IDataProtectionProvider protection, CancellationToken token)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        Response.Headers.CacheControl = "no-store";
        try
        {
            var file = await new ProductReleaseBackup(_db, protection).ExportAsync(token);
            return Ok(ApiResponse<ProductReleaseBackupFile>.Ok(file));
        }
        catch (InvalidDataException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpPost("overview/version-workflow/release-backup/restore")]
    [RequestSizeLimit(ProductReleaseBackup.RequestLimit)]
    public async Task<IActionResult> RestoreReleaseBackup([FromBody] ProductReleaseBackupFile file, [FromQuery] bool? preview,
        [FromServices] IDataProtectionProvider protection, [FromServices] IConfiguration configuration, CancellationToken token)
    {
        var denied = await RequireProductApplicationAdminAsync();
        if (denied != null) return denied;
        var dryRun = preview != false;
        if (!dryRun && !DeploymentAuthority.CanRunSharedScheduledWork(configuration))
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "请在正式环境恢复备份。"));
        try
        {
            var result = await new ProductReleaseBackup(_db, protection).RestoreAsync(file, dryRun, token);
            if (!dryRun && result.Restored > 0)
                _logger.LogInformation("正式版本备份恢复，用户 {UserId}，恢复 {Restored} 条，保留 {Existing} 条。",
                    GetUserId(), result.Restored, result.Existing);
            return Ok(ApiResponse<ProductReleaseRestoreResult>.Ok(result));
        }
        catch (InvalidDataException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }
}
