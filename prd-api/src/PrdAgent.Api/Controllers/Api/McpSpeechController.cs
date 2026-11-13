using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Services;

namespace PrdAgent.Api.Controllers.Api;

public sealed class SpeechExceptionFilter : IExceptionFilter
{
    public void OnException(ExceptionContext context)
    {
        if (context.Exception is not SpeechException ex) return;
        context.Result = new ObjectResult(ApiResponse<object>.Fail(ex.Code, ex.Message)) { StatusCode = ex.StatusCode };
        context.ExceptionHandled = true;
    }
}

[ApiController]
[Route("api/mcp-speech")]
[Authorize]
[TypeFilter(typeof(SpeechExceptionFilter))]
public sealed class McpSpeechController(SpeechGenerationService speech, IAdminPermissionService permissions) : ControllerBase
{
    private async Task<IReadOnlyList<string>> PermissionsAsync() => await permissions.GetEffectivePermissionsAsync(
        this.GetRequiredUserId(), User.FindFirst("isRoot")?.Value == "1", CancellationToken.None);

    private async Task RequireAsync(string permission)
    {
        var grants = await PermissionsAsync();
        var super = grants.Contains(AdminPermissionCatalog.Super);
        if ((!grants.Contains(AdminPermissionCatalog.Access) && !super)
            || (!super && !grants.Contains(permission) && !grants.Contains(AdminPermissionCatalog.McpSpeechManage)
                && !(permission == AdminPermissionCatalog.McpSpeechRead && grants.Contains(AdminPermissionCatalog.McpSpeechGenerate))))
            throw new SpeechException("PERMISSION_DENIED", "当前账号没有该语音操作权限，请联系管理员授权。", 403);
    }

    [HttpGet("capabilities")]
    public async Task<IActionResult> Capabilities()
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechRead);
        return Ok(ApiResponse<object>.Ok(await speech.GetCapabilitiesAsync()));
    }

    [HttpGet("settings")]
    public async Task<IActionResult> Settings()
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechRead);
        var settings = await speech.GetSettingsAsync();
        var granted = await PermissionsAsync();
        var manage = granted.Contains(AdminPermissionCatalog.McpSpeechManage) || granted.Contains(AdminPermissionCatalog.Super);
        List<PrdAgent.Core.LlmGateway.AvailableModelPool> pools = new();
        string? directoryError = null;
        if (manage)
        {
            try { pools = await speech.GetModelPoolsAsync(); }
            catch (HttpRequestException) { directoryError = "网关模型目录暂不可用，请检查模型网关连接后刷新。"; }
        }
        return Ok(ApiResponse<object>.Ok(new { settings.Environment, settings.Revision, settings.Profiles, canManage = manage,
            modelPools = pools.Select(x => new { id = x.Code, name = x.Name }), directoryError }));
    }

    public sealed class SaveSettingsRequest
    {
        public long Revision { get; set; }
        public List<SpeechProfile> Profiles { get; set; } = new();
    }

    [HttpPut("settings")]
    public async Task<IActionResult> SaveSettings([FromBody] SaveSettingsRequest request)
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechManage);
        return Ok(ApiResponse<object>.Ok(await speech.SaveSettingsAsync(request.Revision, request.Profiles)));
    }

    [HttpGet("presets")]
    public async Task<IActionResult> Presets()
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechRead);
        return Ok(ApiResponse<object>.Ok(new { items = await speech.GetPresetsAsync(this.GetRequiredUserId()) }));
    }

    [HttpPost("presets")]
    public async Task<IActionResult> SavePreset([FromBody] SpeechPresetRequest request)
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechGenerate);
        return Ok(ApiResponse<object>.Ok(await speech.SavePresetAsync(this.GetRequiredUserId(), request)));
    }

    [HttpPost("runs")]
    public async Task<IActionResult> Create([FromBody] SpeechCreateRequest request)
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechGenerate);
        var (run, replay) = await speech.CreateAsync(this.GetRequiredUserId(), null, request);
        return Ok(ApiResponse<object>.Ok(speech.ToResult(run, deduplicated: replay)));
    }

    [HttpGet("runs")]
    public async Task<IActionResult> Runs([FromQuery] int limit = 30)
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechRead);
        return Ok(ApiResponse<object>.Ok(new { items = (await speech.ListRunsAsync(this.GetRequiredUserId(), limit)).Select(x => speech.ToResult(x)) }));
    }

    [HttpGet("runs/{id}")]
    public async Task<IActionResult> Run(string id)
    {
        await RequireAsync(AdminPermissionCatalog.McpSpeechRead);
        var run = await speech.GetRunAsync(this.GetRequiredUserId(), id) ?? throw new SpeechException("RUN_NOT_FOUND", "语音任务不存在。", 404);
        return Ok(ApiResponse<object>.Ok(speech.ToResult(run)));
    }

    [HttpGet("runs/{id}/audio")]
    public async Task<IActionResult> Audio(string id)
    {
        // 历史资产按归属访问；撤回生成权限不删除已拥有的成品。
        var result = await speech.ReadAudioAsync(this.GetRequiredUserId(), id);
        Response.Headers.CacheControl = "private, no-store";
        return File(result.Bytes, result.Mime, result.FileName, enableRangeProcessing: true);
    }
}
