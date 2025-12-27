using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 阶段提示词（客户端只取阶段枚举/标题，不返回 promptTemplate）
/// </summary>
[ApiController]
[Route("api/v1/prompt-stages")]
[Authorize]
public class PromptStagesController : ControllerBase
{
    private readonly IPromptStageService _promptStageService;

    public PromptStagesController(IPromptStageService promptStageService)
    {
        _promptStageService = promptStageService;
    }

    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<PromptStagesClientResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStages(CancellationToken ct)
    {
        var resp = await _promptStageService.GetStagesForClientAsync(ct);
        return Ok(ApiResponse<PromptStagesClientResponse>.Ok(resp));
    }
}


