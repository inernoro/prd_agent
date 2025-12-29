using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 提示词（客户端只取枚举/标题，不返回 promptTemplate）
/// </summary>
[ApiController]
[Route("api/v1/prompts")]
[Authorize]
public class PromptsController : ControllerBase
{
    private readonly IPromptService _promptService;

    public PromptsController(IPromptService promptService)
    {
        _promptService = promptService;
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<PromptsClientResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStages(CancellationToken ct)
    {
        var resp = await _promptService.GetPromptsForClientAsync(ct);
        return Ok(ApiResponse<PromptsClientResponse>.Ok(resp));
    }
}


