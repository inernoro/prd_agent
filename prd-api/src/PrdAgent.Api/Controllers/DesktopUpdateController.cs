using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 桌面客户端更新加速端点（匿名访问）。
/// 客户端优先请求此端点，3 秒超时后回退 GitHub。
/// </summary>
[ApiController]
[Route("api/v1/desktop/update")]
[AllowAnonymous]
public class DesktopUpdateController : ControllerBase
{
    private readonly DesktopUpdateAccelerator _accelerator;
    private readonly ILogger<DesktopUpdateController> _logger;

    public DesktopUpdateController(DesktopUpdateAccelerator accelerator, ILogger<DesktopUpdateController> logger)
    {
        _accelerator = accelerator;
        _logger = logger;
    }

    /// <summary>
    /// 获取加速后的 Tauri updater manifest。
    /// 如果 COS 缓存就绪则返回加速 manifest；否则触发异步缓存并返回 404（客户端回退 GitHub）。
    /// </summary>
    [HttpGet("latest-{target}.json")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetAcceleratedManifest(string target, CancellationToken ct)
    {
        try
        {
            var manifest = await _accelerator.TryGetAcceleratedManifestAsync(target, ct);

            if (manifest != null)
            {
                _logger.LogInformation("Serving accelerated manifest for {Target}", target);
                return Content(manifest, "application/json");
            }

            // 缓存未就绪，返回 404 让客户端回退 GitHub
            return NotFound(new { message = "缓存未就绪，请使用 GitHub 源" });
        }
        catch (OperationCanceledException)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Accelerated manifest error for {Target}", target);
            return NotFound(new { message = "加速服务异常，请使用 GitHub 源" });
        }
    }
}
