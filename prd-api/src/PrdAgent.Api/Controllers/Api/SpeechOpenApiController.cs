using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/open/speech")]
[Authorize(AuthenticationSchemes = "ApiKey")]
[TypeFilter(typeof(SpeechExceptionFilter))]
public sealed class SpeechOpenApiController(SpeechGenerationService speech) : ControllerBase
{
    private string Owner => User.FindFirst("boundUserId")?.Value ?? throw new SpeechException("UNAUTHORIZED", "接入凭据没有绑定用户。", 401);
    private string KeyId => McpIdempotency.KeyIdOf(User);

    [HttpGet("capabilities")]
    [RequireScope(McpCapabilityCatalog.ScopeSpeechRead, McpCapabilityCatalog.ScopeSpeechGenerate)]
    public async Task<IActionResult> Capabilities() => Ok(ApiResponse<object>.Ok(await speech.GetCapabilitiesAsync()));

    [HttpGet("presets")]
    [RequireScope(McpCapabilityCatalog.ScopeSpeechRead, McpCapabilityCatalog.ScopeSpeechGenerate)]
    public async Task<IActionResult> Presets() => Ok(ApiResponse<object>.Ok(new { items = await speech.GetPresetsAsync(Owner) }));

    [HttpPost("presets")]
    [RequireScope(McpCapabilityCatalog.ScopeSpeechGenerate)]
    public async Task<IActionResult> SavePreset([FromBody] SpeechPresetRequest request)
        => Ok(ApiResponse<object>.Ok(await speech.SavePresetAsync(Owner, request)));

    [HttpPost("runs")]
    [RequireScope(McpCapabilityCatalog.ScopeSpeechGenerate)]
    public async Task<IActionResult> Create([FromBody] SpeechCreateRequest request)
    {
        var (run, replay) = await speech.CreateAsync(Owner, KeyId, request);
        return Ok(ApiResponse<object>.Ok(speech.ToResult(run, openApi: true, deduplicated: replay)));
    }

    [HttpGet("runs")]
    [RequireScope(McpCapabilityCatalog.ScopeSpeechRead, McpCapabilityCatalog.ScopeSpeechGenerate)]
    public async Task<IActionResult> Runs([FromQuery] int limit = 30)
        => Ok(ApiResponse<object>.Ok(new { items = (await speech.ListRunsAsync(Owner, limit)).Select(x => speech.ToResult(x, openApi: true)) }));

    [HttpGet("runs/{runId}")]
    [RequireScope(McpCapabilityCatalog.ScopeSpeechRead, McpCapabilityCatalog.ScopeSpeechGenerate)]
    public async Task<IActionResult> Run(string runId)
    {
        var run = await speech.GetRunAsync(Owner, runId) ?? throw new SpeechException("RUN_NOT_FOUND", "语音任务不存在。", 404);
        return Ok(ApiResponse<object>.Ok(speech.ToResult(run, openApi: true)));
    }

    [HttpGet("runs/{runId}/audio")]
    [RequireScope(McpCapabilityCatalog.ScopeSpeechRead, McpCapabilityCatalog.ScopeSpeechGenerate)]
    public async Task<IActionResult> Audio(string runId)
    {
        var result = await speech.ReadAudioAsync(Owner, runId);
        Response.Headers.CacheControl = "private, no-store";
        return File(result.Bytes, result.Mime, result.FileName, enableRangeProcessing: true);
    }
}
