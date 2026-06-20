using System.IO.Compression;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
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
    private static readonly IReadOnlyDictionary<string, string[]> BundledSkillDependencies =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["create-visual-test-to-kb"] =
            [
                "acceptance-test-design",
                "acceptance-scenario-orchestrator",
            ],
            ["acceptance-scenario-orchestrator"] =
            [
                "acceptance-test-design",
            ],
        };

    private readonly IConfiguration _config;
    private readonly ILogger<OfficialSkillsController> _logger;

    public OfficialSkillsController(IConfiguration config, ILogger<OfficialSkillsController> logger)
    {
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// 下载官方技能包 zip。
    /// GET /api/official-skills/{skillKey}/download
    /// </summary>
    [HttpGet("{skillKey}/download")]
    public IActionResult Download(string skillKey)
    {
        var baseUrl = ResolveBaseUrl();

        // 模板类官方技能（findmapskills / ai-defect-resolve）：占位替换 + SKILL.md/README
        if (skillKey == OfficialSkillTemplates.FindMapSkillsKey || skillKey == OfficialSkillTemplates.AiDefectResolveKey)
        {
            var isDefect = skillKey == OfficialSkillTemplates.AiDefectResolveKey;
            var version = isDefect ? OfficialSkillTemplates.AiDefectResolveVersion : OfficialSkillTemplates.FindMapSkillsVersion;
            var releaseDate = isDefect ? OfficialSkillTemplates.AiDefectResolveReleaseDate : OfficialSkillTemplates.FindMapSkillsReleaseDate;
            var skillTemplate = isDefect ? OfficialSkillTemplates.AiDefectResolveSkillMd : OfficialSkillTemplates.FindMapSkillsSkillMd;
            var readmeTemplate = isDefect ? OfficialSkillTemplates.AiDefectResolveReadme : OfficialSkillTemplates.FindMapSkillsReadme;

            string Subst(string template) => template
                .Replace("{{BASE_URL}}", baseUrl)
                .Replace("{{VERSION}}", version)
                .Replace("{{RELEASE_DATE}}", releaseDate);
            var skillMd = Subst(skillTemplate);
            var readme = Subst(readmeTemplate);

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

        // 其余官方技能：从内嵌目录打完整 zip（含 reference/ scripts/ 等全部文本文件）
        var entry = OfficialSkillCatalog.Find(skillKey);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"未找到官方技能: {skillKey}"));

        var entries = new List<OfficialSkillCatalog.SkillEntry> { entry };
        if (BundledSkillDependencies.TryGetValue(entry.Key, out var dependencyKeys))
        {
            foreach (var dependencyKey in dependencyKeys)
            {
                var dependency = OfficialSkillCatalog.Find(dependencyKey);
                if (dependency == null)
                {
                    return StatusCode(500, ApiResponse<object>.Fail(
                        ErrorCodes.INTERNAL_ERROR,
                        $"官方技能 {entry.Key} 缺少依赖技能: {dependencyKey}"));
                }

                entries.Add(dependency);
            }
        }

        using var ms2 = new MemoryStream();
        using (var zip = new ZipArchive(ms2, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var packagedEntry in entries)
            {
                foreach (var f in packagedEntry.Files)
                {
                    // zip 内统一放在 {key}/ 目录下，解压即 ~/.claude/skills/{key}/
                    WriteEntry(zip, $"{packagedEntry.Key}/{f.Path}", f.Content);
                }
            }
        }
        var bytes2 = ms2.ToArray();
        Response.Headers.Append("Cache-Control", "no-store");
        var fileCount = entries.Sum(e => e.Files.Count);
        _logger.LogInformation("[OfficialSkills] 下发 {SkillKey} 技能包 {Files} 文件 {Bytes} bytes", skillKey, fileCount, bytes2.Length);
        return File(bytes2, "application/zip", $"{entry.Key}.zip");
    }

    /// <summary>
    /// 读取请求外部可见 origin，统一走全站共享的 <see cref="HttpRequestExtensions.ResolveServerUrl"/>。
    /// </summary>
    private string ResolveBaseUrl() => Request.ResolveServerUrl(_config);

    private static void WriteEntry(ZipArchive zip, string path, string content)
    {
        var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
        using var stream = entry.Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }
}
