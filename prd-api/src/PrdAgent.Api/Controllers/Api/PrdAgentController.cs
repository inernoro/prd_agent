using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// PRD Agent Controller
/// 用于菜单权限扫描 + PRD Agent 页面需要的只读数据端点。
/// 避免 PRD Agent 页面跨权限调用 /api/prompts（需要 prompts.read）。
/// </summary>
[ApiController]
[Route("api/prd-agent")]
[Authorize]
[AdminController("prd-agent", AdminPermissionCatalog.PrdAgentUse)]
public sealed class PrdAgentController : ControllerBase
{
    private readonly IPromptService _promptService;
    private readonly ISystemPromptService _systemPromptService;

    public PrdAgentController(IPromptService promptService, ISystemPromptService systemPromptService)
    {
        _promptService = promptService;
        _systemPromptService = systemPromptService;
    }

    /// <summary>
    /// 健康检查端点（占位用）
    /// </summary>
    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(ApiResponse<object>.Ok(new { status = "ok", message = "PRD Agent 功能可用" }));
    }

    /// <summary>
    /// 获取提示词列表（只读，供 PRD Agent 页面快捷标签使用）
    /// 等价于 GET /api/prompts 的读取逻辑，但权限为 prd-agent.use
    /// </summary>
    [HttpGet("prompts")]
    public async Task<IActionResult> GetPrompts(CancellationToken ct)
    {
        var effective = await _promptService.GetEffectiveSettingsAsync(ct);
        var defaults = await _promptService.GetDefaultSettingsAsync(ct);

        static string Normalize(string? s) => (s ?? string.Empty).Trim();

        static List<PromptEntry> NormalizePrompts(PromptSettings? settings)
        {
            var list = settings?.Prompts ?? new List<PromptEntry>();
            return list
                .Where(x => x.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
                .Select(x => new PromptEntry
                {
                    Role = x.Role,
                    Order = x.Order,
                    PromptKey = Normalize(x.PromptKey),
                    Title = Normalize(x.Title),
                    PromptTemplate = Normalize(x.PromptTemplate)
                })
                .OrderBy(x => x.Role)
                .ThenBy(x => x.Order)
                .ToList();
        }

        static bool PromptsEqual(PromptSettings? a, PromptSettings? b)
        {
            var aa = NormalizePrompts(a);
            var bb = NormalizePrompts(b);
            if (aa.Count != bb.Count) return false;
            for (var i = 0; i < aa.Count; i++)
            {
                var x = aa[i];
                var y = bb[i];
                if (x.Role != y.Role) return false;
                if (x.Order != y.Order) return false;
                if (!string.Equals(x.PromptKey, y.PromptKey, StringComparison.Ordinal)) return false;
                if (!string.Equals(x.Title, y.Title, StringComparison.Ordinal)) return false;
                if (!string.Equals(x.PromptTemplate, y.PromptTemplate, StringComparison.Ordinal)) return false;
            }
            return true;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            isOverridden = !PromptsEqual(effective, defaults),
            settings = effective
        }));
    }

    /// <summary>
    /// 获取系统提示词（只读，供 PRD Agent 页面显示系统提示词内容）
    /// 等价于 GET /api/prompts/system 的读取逻辑，但权限为 prd-agent.use
    /// </summary>
    [HttpGet("prompts/system")]
    public async Task<IActionResult> GetSystemPrompts(CancellationToken ct)
    {
        var effective = await _systemPromptService.GetEffectiveSettingsAsync(ct);
        var defaults = await _systemPromptService.GetDefaultSettingsAsync(ct);

        static string Normalize(string? s) => (s ?? string.Empty).Trim();

        static List<SystemPromptEntry> NormalizeEntries(SystemPromptSettings? s)
        {
            var list = s?.Entries ?? new List<SystemPromptEntry>();
            return list
                .Where(x => x.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
                .Select(x => new SystemPromptEntry
                {
                    Role = x.Role,
                    SystemPrompt = Normalize(x.SystemPrompt)
                })
                .OrderBy(x => x.Role)
                .ToList();
        }

        static bool EntriesEqual(SystemPromptSettings? a, SystemPromptSettings? b)
        {
            var aa = NormalizeEntries(a);
            var bb = NormalizeEntries(b);
            if (aa.Count != bb.Count) return false;
            for (var i = 0; i < aa.Count; i++)
            {
                if (aa[i].Role != bb[i].Role) return false;
                if (!string.Equals(aa[i].SystemPrompt, bb[i].SystemPrompt, StringComparison.Ordinal)) return false;
            }
            return true;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            isOverridden = !EntriesEqual(effective, defaults),
            settings = effective
        }));
    }
}
