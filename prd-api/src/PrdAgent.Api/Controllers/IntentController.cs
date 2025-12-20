using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

[ApiController]
[Route("api/v1/intent")]
[Authorize]
public class IntentController : ControllerBase
{
    private readonly IModelDomainService _modelDomain;
    private readonly IAppSettingsService _settingsService;

    public IntentController(IModelDomainService modelDomain, IAppSettingsService settingsService)
    {
        _modelDomain = modelDomain;
        _settingsService = settingsService;
    }

    [HttpPost("group-name")]
    [ProducesResponseType(typeof(ApiResponse<SuggestGroupNameResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> SuggestGroupName([FromBody] SuggestGroupNameRequest request, CancellationToken ct)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.Snippet))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "snippet 不能为空"));
        }

        // 使用系统配置的字符限制（默认 200k，所有大模型请求输入的字符限制统一来源）
        var snippet = request.Snippet.Trim();
        var settings = await _settingsService.GetSettingsAsync(ct);
        var maxChars = LlmLogLimits.GetRequestBodyMaxChars(settings);
        if (snippet.Length > maxChars)
        {
            snippet = snippet[..maxChars];
        }

        try
        {
            var name = await _modelDomain.SuggestGroupNameAsync(request.FileName, snippet, ct);
            return Ok(ApiResponse<SuggestGroupNameResponse>.Ok(new SuggestGroupNameResponse { Name = name }));
        }
        catch
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "意图模型调用失败"));
        }
    }
}

public class SuggestGroupNameRequest
{
    public string? FileName { get; set; }
    public string Snippet { get; set; } = string.Empty;
}

public class SuggestGroupNameResponse
{
    public string Name { get; set; } = string.Empty;
}


