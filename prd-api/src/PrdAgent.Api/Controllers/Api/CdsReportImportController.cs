using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// CDS 验收报告导入 —— 复用「系统互联」已授权的 CDS 全局连接（一次鉴权，无需 peer-sync 握手），
/// 把 CDS 验收中心的报告增量同步进当前用户的知识库。
/// </summary>
[ApiController]
[Route("api/document-store")]
[Authorize]
public class CdsReportImportController : ControllerBase
{
    private readonly CdsReportImportService _importer;
    private readonly ILogger<CdsReportImportController> _logger;

    public CdsReportImportController(CdsReportImportService importer, ILogger<CdsReportImportController> logger)
    {
        _importer = importer;
        _logger = logger;
    }

    /// <summary>
    /// 触发一次导入。可重复调用（按 contentHash + updatedSince 增量）。
    /// 鉴权来源优先级：显式 cdsBaseUrl+cdsAccessKey &gt; connectionId &gt; 最近活跃的 CDS 连接。
    /// </summary>
    [HttpPost("import-cds-reports")]
    public async Task<IActionResult> ImportCdsReports([FromBody] CdsReportImportOptions? request, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var opts = request ?? new CdsReportImportOptions();
        // SSRF 防护：HTTP 入口禁止信任调用方自带的 CDS base/key。否则任意登录用户都能让后端
        // 用默认 HttpClient 探测内网任意主机的 /api/reports，观测状态/错误行为（Codex P2）。
        // 生产导入一律走「系统互联」已授权的存储连接（connectionId / 最近活跃的 CDS 连接）；
        // 显式 base/key 仅保留给单元测试直接调用 service（不经此 HTTP 端点）。
        opts.CdsBaseUrl = null;
        opts.CdsAccessKey = null;
        try
        {
            var result = await _importer.ImportAsync(userId, opts, ct);
            return Ok(ApiResponse<CdsReportImportResult>.Ok(result));
        }
        catch (InvalidOperationException ex)
        {
            // 配置/凭据类问题（无连接、令牌失效、目标库不存在）→ 400 + 明确原因
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[cds-report-import] 导入异常 userId={UserId}", userId);
            return StatusCode(502, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, $"导入 CDS 报告失败：{ex.Message}"));
        }
    }
}
