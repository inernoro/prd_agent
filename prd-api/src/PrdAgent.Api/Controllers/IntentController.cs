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

    public IntentController(IModelDomainService modelDomain)
    {
        _modelDomain = modelDomain;
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

        // 严格限制输入长度，避免被误用为“全文存储/转发”
        var snippet = request.Snippet.Trim();
        if (snippet.Length > 2000) snippet = snippet[..2000];

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


