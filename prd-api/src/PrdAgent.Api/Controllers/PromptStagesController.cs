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
public class PromptsController : ControllerBase
{
    private readonly IPromptService _promptService;

    public PromptsController(IPromptService promptService)
    {
        _promptService = promptService;
    }

    [HttpGet]
    // Desktop 侧“提示词按钮”仅需枚举与标题，不涉及敏感内容；为避免桌面端因 token 同步/环境差异导致 401/403，
    // 这里允许匿名访问（仍返回统一 ApiResponse 结构）。
    [AllowAnonymous]
    [ProducesResponseType(typeof(ApiResponse<PromptsClientResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStages(CancellationToken ct)
    {
        var resp = await _promptService.GetPromptsForClientAsync(ct);
        return Ok(ApiResponse<PromptsClientResponse>.Ok(resp));
    }
}


