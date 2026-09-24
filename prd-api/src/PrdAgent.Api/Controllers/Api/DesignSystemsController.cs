using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 风格目录与真实样张：OpenDesign 设计系统快照（版本钉在 cds/open-design-runtime/Dockerfile）。
/// 鉴权与网页生成的其它接口一致：网页托管读权限。样张是纯展示内容，只读、无副作用。
/// </summary>
[ApiController]
[Route("api/design-artifacts/design-systems")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class DesignSystemsController : ControllerBase
{
    /// <summary>样张只随快照版本变化；一小时私有缓存足够让画廊来回翻不重复取，又不会把换版后的旧样张留太久。</summary>
    internal const string SampleCacheControl = "private, max-age=3600";

    /// <summary>
    /// 样张被直接打开（不在 iframe srcdoc 里）时的兜底：不许执行脚本、不许加载任何外部资源、不许被表单或 base 劫持。
    /// </summary>
    internal const string SampleContentSecurityPolicy =
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

    private readonly IDesignSystemCatalog _catalog;

    public DesignSystemsController(IDesignSystemCatalog catalog)
    {
        _catalog = catalog;
    }

    /// <summary>全部设计系统的目录：按 id 排序；分组所需的 category 与按数量排好的分类表一并给出。</summary>
    [HttpGet]
    public IActionResult List() => Ok(ApiResponse<object>.Ok(ToCatalogView(_catalog)));

    /// <summary>
    /// 某套设计系统的真实样张（text/html）：它自己的 tokens.css + 所有设计系统共用的样张模板。
    /// title 替换大标题（HTML 转义、截到 60 字）；format = page（默认）或 slides（16:9 封面）。
    /// </summary>
    [HttpGet("{id}/sample")]
    public IActionResult Sample(string id, [FromQuery] string? title, [FromQuery] string? format)
    {
        // 只认快照目录里真实存在的编号（字典精确匹配），任何别的输入一律 404，不拼路径、不读文件。
        var system = _catalog.Find(id);
        if (system == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND,
                $"没有编号为「{Truncate(id, 64)}」的设计系统。当前风格目录来自 OpenDesign {_catalog.EngineVersion}，共 {_catalog.All.Count} 套，请从目录里选一套。"));
        }
        if (!DesignSystemSampleRenderer.IsKnownFormat(format))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"样张格式「{Truncate(format, 20)}」不支持，只能是 page（网页）或 slides（16:9 封面）。"));
        }

        Response.Headers.CacheControl = SampleCacheControl;
        Response.Headers["Content-Security-Policy"] = SampleContentSecurityPolicy;
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Content(DesignSystemSampleRenderer.Render(system, title, format), "text/html; charset=utf-8");
    }

    internal static object ToCatalogView(IDesignSystemCatalog catalog)
    {
        var items = catalog.All.Select(system => new
        {
            id = system.Id,
            name = system.Name,
            category = system.Category,
            summary = system.Summary,
            swatches = new { bg = system.Swatches.Bg, fg = system.Swatches.Fg, accent = system.Swatches.Accent },
            fonts = new { display = system.Fonts.Display, body = system.Fonts.Body },
            sampleUrl = DesignSystemSampleRenderer.SamplePath(system.Id),
        }).ToList();
        var categories = catalog.All
            .GroupBy(system => system.Category, StringComparer.Ordinal)
            .Select(group => new { name = group.Key, count = group.Count() })
            .OrderByDescending(group => group.count)
            .ThenBy(group => group.name, StringComparer.Ordinal)
            .ToList();
        return new
        {
            engine = new
            {
                name = "open-design",
                version = catalog.EngineVersion,
                image = catalog.EngineImage,
                generatedAt = catalog.GeneratedAt,
            },
            count = items.Count,
            categories,
            items,
        };
    }

    private static string Truncate(string? value, int max)
    {
        var text = value ?? string.Empty;
        return text.Length <= max ? text : text[..max] + "…";
    }
}
