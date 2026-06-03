using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 准星前台问答接口（员工侧）。
/// </summary>
[ApiController]
[Route("zhunxing")]
[Authorize]
public class ZhunxingController : ControllerBase
{
    private readonly IZhunxingKnowledgeService _knowledgeService;

    public ZhunxingController(IZhunxingKnowledgeService knowledgeService)
    {
        _knowledgeService = knowledgeService;
    }

    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(ApiResponse<object>.Ok(new
        {
            appKey = "zhunxing-agent",
            status = "ok",
        }));
    }

    /// <summary>
    /// 规范问答（MVP）：检索条款并返回依据引用。
    /// </summary>
    [HttpPost("ask")]
    public async Task<IActionResult> Ask([FromBody] ZhunxingAskRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Question))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "question 不能为空"));

        var userId = this.GetRequiredUserId();
        var response = await _knowledgeService.AskAsync(userId, request, ct);
        return Ok(ApiResponse<object>.Ok(response));
    }
}
