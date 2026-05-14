using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// MAP 端基础设施连接管理接口（剪贴板配对密钥）。
/// 详见 spec.cds-map-pairing-protocol.md。
///
/// 鉴权：标准用户 JWT —— 调用方为登录的运营/开发用户，不是机器对机器。
/// 机器调用通道（DynamicSidecarRegistry / ClaudeSidecarRouter）走
/// <see cref="IInfraConnectionService.GetRawAsync"/> + 服务内解密，不经此 Controller。
/// </summary>
[ApiController]
[Route("api/infra-connections")]
[Authorize]
public class InfraConnectionsController : ControllerBase
{
    private readonly IInfraConnectionService _service;

    public InfraConnectionsController(IInfraConnectionService service)
    {
        _service = service;
    }

    public class PasteRequest
    {
        public string ClipboardText { get; set; } = string.Empty;
    }

    public class CdsAuthorizeStartRequest
    {
        public string CdsBaseUrl { get; set; } = string.Empty;
        public string MapBaseUrl { get; set; } = string.Empty;
    }

    public class CdsAuthorizeCompleteRequest
    {
        public string Code { get; set; } = string.Empty;
        public string State { get; set; } = string.Empty;
    }

    /// <summary>
    /// 粘贴 CDS 密钥 → 解析 → 调对端 accept → 加密落库。
    /// 成功返回 201 + 脱敏视图。失败返回 spec §3.3 错误码。
    /// </summary>
    [HttpPost("paste")]
    public async Task<IActionResult> Paste([FromBody] PasteRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.ClipboardText))
        {
            return BadRequest(ApiResponse<object>.Fail(
                InfraConnectionErrorCodes.ClipboardInvalidFormat,
                "剪贴板内容为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var view = await _service.PasteAsync(req.ClipboardText, userId, ct);
            return StatusCode(StatusCodes.Status201Created, ApiResponse<object>.Ok(new { item = view }));
        }
        catch (InfraConnectionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    /// <summary>
    /// 输入 CDS 地址 → 生成 CDS 授权页跳转 URL。
    /// 用户在 CDS 授权后会回跳到 MAP /infra-services?cds_code=...&state=...
    /// </summary>
    [HttpPost("cds/authorize/start")]
    public async Task<IActionResult> StartCdsAuthorization(
        [FromBody] CdsAuthorizeStartRequest req,
        CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.CdsBaseUrl))
        {
            return BadRequest(ApiResponse<object>.Fail(
                InfraConnectionErrorCodes.CdsBaseUrlInvalid,
                "CDS 地址不能为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var view = await _service.StartCdsAuthorizationAsync(req.CdsBaseUrl, req.MapBaseUrl, userId, ct);
            return Ok(ApiResponse<object>.Ok(new
            {
                authorizeUrl = view.AuthorizeUrl,
                state = view.State,
                cdsBaseUrl = view.CdsBaseUrl,
                expiresAt = view.ExpiresAt
            }));
        }
        catch (InfraConnectionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    /// <summary>
    /// CDS 授权回跳后，MAP 用一次性 code 换 longToken 并保存连接。
    /// </summary>
    [HttpPost("cds/authorize/complete")]
    public async Task<IActionResult> CompleteCdsAuthorization(
        [FromBody] CdsAuthorizeCompleteRequest req,
        CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Code) || string.IsNullOrWhiteSpace(req.State))
        {
            return BadRequest(ApiResponse<object>.Fail(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                "授权参数不完整"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var view = await _service.CompleteCdsAuthorizationAsync(req.Code, req.State, userId, ct);
            return StatusCode(StatusCodes.Status201Created, ApiResponse<object>.Ok(new { item = view }));
        }
        catch (InfraConnectionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    /// <summary>列出所有连接（脱敏）。任意已登录用户均可查看。</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var items = await _service.ListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        var view = await _service.GetAsync(id, ct);
        if (view == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                InfraConnectionErrorCodes.ConnectionNotFound,
                "连接不存在"));
        }
        return Ok(ApiResponse<object>.Ok(new { item = view }));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var deleted = await _service.DeleteAsync(id, ct);
        if (!deleted)
        {
            return NotFound(ApiResponse<object>.Fail(
                InfraConnectionErrorCodes.ConnectionNotFound,
                "连接不存在"));
        }
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 触发探活：GET 对端 InstanceDiscoveryUrl，更新 LastProbedAt / LastProbeOk。
    /// 探活成功的连接如曾被标记 unreachable 会自动恢复 active；反之亦然。
    /// </summary>
    [HttpPost("{id}/probe")]
    public async Task<IActionResult> Probe(string id, CancellationToken ct)
    {
        var view = await _service.ProbeAsync(id, ct);
        if (view == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                InfraConnectionErrorCodes.ConnectionNotFound,
                "连接不存在"));
        }
        return Ok(ApiResponse<object>.Ok(new { item = view }));
    }
}
