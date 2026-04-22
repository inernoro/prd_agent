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
        if (skillKey != OfficialSkillTemplates.FindMapSkillsKey)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"未找到官方技能: {skillKey}"));

        var baseUrl = ResolveBaseUrl();
        string Subst(string template) => template
            .Replace("{{BASE_URL}}", baseUrl)
            .Replace("{{VERSION}}", OfficialSkillTemplates.FindMapSkillsVersion)
            .Replace("{{RELEASE_DATE}}", OfficialSkillTemplates.FindMapSkillsReleaseDate);
        var skillMd = Subst(OfficialSkillTemplates.FindMapSkillsSkillMd);
        var readme = Subst(OfficialSkillTemplates.FindMapSkillsReadme);

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
    ///
    /// 优先级：
    ///   1. `X-Client-Base-Url`（admin 前端显式注入，永远用户可见 origin）
    ///   2. `Origin` 头（浏览器 CORS 请求自动带）
    ///   3. `X-Forwarded-Host` + `X-Forwarded-Proto`（CDS / Cloudflare / K8s Ingress
    ///      反代层注入的外部 host —— 给 curl 裸调用时兜底）
    ///   4. Scheme + Host（容器内部地址；只有前三个都没有时才会走到这里）
    ///
    /// 为什么不直接 `Scheme + Host`：CDS 容器里 Host 被反代重写为内部 `127.0.0.1:PORT`，
    /// 把它嵌到 SKILL.md 发给用户是灾难（用户的 curl 根本连不上）。
    /// </summary>
    private string ResolveBaseUrl() => OfficialMarketplaceSkillInjector.ResolveBaseUrl(Request);

    private static void WriteEntry(ZipArchive zip, string path, string content)
    {
        var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
        using var stream = entry.Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }
}
