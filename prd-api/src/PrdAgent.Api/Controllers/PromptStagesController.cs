using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 提示词（客户端只取枚举/标题，不返回 promptTemplate）
/// 合并后从 skills 集合读取系统技能，保持接口向后兼容
/// </summary>
[ApiController]
[Route("api/v1/prompts")]
public class PromptsController : ControllerBase
{
    private readonly ISkillService _skillService;

    public PromptsController(ISkillService skillService)
    {
        _skillService = skillService;
    }

    [HttpGet]
    // Desktop 侧"提示词按钮"仅需枚举与标题，不涉及敏感内容；为避免桌面端因 token 同步/环境差异导致 401/403，
    // 这里允许匿名访问（仍返回统一 ApiResponse 结构）。
    [AllowAnonymous]
    [ProducesResponseType(typeof(ApiResponse<PromptsClientResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStages(CancellationToken ct)
    {
        // 从 skills 集合读取系统技能，转换为客户端 PromptsClientResponse 格式
        // 使用空 userId 仅获取系统+公共技能（不含个人技能）
        var skills = await _skillService.GetVisibleSkillsAsync("", null, ct);

        // 只返回系统内置技能（与旧 promptstages 行为一致）
        var prompts = skills
            .Where(s => s.Visibility == SkillVisibility.System && s.IsBuiltIn)
            .Select(s => new PromptClientItem(
                PromptKey: s.SkillKey,
                Order: s.Order,
                Role: s.Roles.FirstOrDefault(),
                Title: s.Title))
            .Where(p => p.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
            .OrderBy(p => p.Role)
            .ThenBy(p => p.Order)
            .ToList();

        var resp = new PromptsClientResponse(DateTime.UtcNow, prompts);
        return Ok(ApiResponse<PromptsClientResponse>.Ok(resp));
    }
}
