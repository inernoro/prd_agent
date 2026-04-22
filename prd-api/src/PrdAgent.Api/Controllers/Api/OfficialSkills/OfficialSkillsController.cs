using System.IO.Compression;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api.OfficialSkills;

/// <summary>
/// 平台官方技能包动态下载端点。
///
/// 与海鲜市场用户上传的技能包不同，这些技能是平台一等公民：
/// - 匿名可访问（帮助"还没有 Key 的用户"也能先拿技能包）
/// - 内容从代码嵌入，动态生成 zip，保证跟当前 API 契约版本一致
/// - 路径占位符 {{BASE_URL}} 运行时替换为请求来源，让 AI 拷贝即用
///
/// 为什么和 MarketplaceSkillsOpenApiController 分开？
/// 后者是 scope 受控的 AI 接口；前者是用户"下载即用"的静态分发，职责不同。
/// </summary>
[ApiController]
[Route("api/official-skills")]
public class OfficialSkillsController : ControllerBase
{
    private readonly ILogger<OfficialSkillsController> _logger;

    public OfficialSkillsController(ILogger<OfficialSkillsController> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// 下载官方技能包 zip。
    /// GET /api/official-skills/{skillKey}/download
    /// </summary>
    [HttpGet("{skillKey}/download")]
    public IActionResult Download(string skillKey)
    {
        if (skillKey != OfficialSkillTemplates.MarketplaceOpenApiSkillKey)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"未找到官方技能: {skillKey}"));

        var baseUrl = ResolveBaseUrl();
        var skillMd = OfficialSkillTemplates.MarketplaceOpenApiSkillMd.Replace("{{BASE_URL}}", baseUrl);
        var readme = OfficialSkillTemplates.MarketplaceOpenApiReadme.Replace("{{BASE_URL}}", baseUrl);

        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteEntry(zip, $"{skillKey}/SKILL.md", skillMd);
            WriteEntry(zip, $"{skillKey}/README.md", readme);
        }
        var bytes = ms.ToArray();

        Response.Headers.Append("Cache-Control", "no-store");
        _logger.LogInformation("[OfficialSkills] 下发 {SkillKey} 技能包 {Bytes} bytes", skillKey, bytes.Length);

        return File(bytes, "application/zip", $"{skillKey}.zip");
    }

    /// <summary>
    /// 读取请求源头的 origin，作为 SKILL.md 内嵌示例的默认 base URL。
    /// 优先级：X-Client-Base-Url（admin 前端注入）&gt; Origin 头 &gt; Scheme+Host 兜底。
    /// </summary>
    private string ResolveBaseUrl()
    {
        string? baseUrl = Request.Headers["X-Client-Base-Url"].ToString();
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = Request.Headers["Origin"].ToString();
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = $"{Request.Scheme}://{Request.Host}";
        return baseUrl.TrimEnd('/');
    }

    private static void WriteEntry(ZipArchive zip, string path, string content)
    {
        var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
        using var stream = entry.Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }
}
