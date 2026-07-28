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

        // 模板类官方技能（当前只剩 ai-defect-resolve）：占位替换 + SKILL.md/README。
        // findmapskills 已于 2026-07-28 迁到 catalog 通道 —— 它的技能文件是唯一事实源，
        // 后端不再内嵌第二份（原先两处内容靠人工同步，实测已开始漂移）。
        if (skillKey == OfficialSkillTemplates.AiDefectResolveKey)
        {
            var version = OfficialSkillTemplates.AiDefectResolveVersion;
            var releaseDate = OfficialSkillTemplates.AiDefectResolveReleaseDate;
            var skillTemplate = OfficialSkillTemplates.AiDefectResolveSkillMd;
            var readmeTemplate = OfficialSkillTemplates.AiDefectResolveReadme;

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

        // 角色套装：一条 curl 装齐一个角色的全部技能（成员技能各自的 Requires 一并展开）
        var bundle = OfficialSkillCatalog.FindBundle(skillKey);
        if (bundle != null)
            return BuildBundleZip(bundle);

        // 其余官方技能：从内嵌目录打完整 zip（含 reference/ scripts/ 等全部文本文件）
        var entry = OfficialSkillCatalog.Find(skillKey);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"未找到官方技能: {skillKey}"));

        var entries = OfficialSkillCatalog.ExpandWithRequires([entry.Key], out var missing);
        if (missing.Count > 0)
        {
            return StatusCode(500, ApiResponse<object>.Fail(
                ErrorCodes.INTERNAL_ERROR,
                $"官方技能 {entry.Key} 缺少依赖技能: {string.Join(", ", missing)}"));
        }

        // findmapskills 的技能文件用 $PRD_AGENT_BASE 写成（本地开发可直接跑）。
        // 下发时把它的默认值设成本实例地址，用户拿到即用、又保留 env 覆盖能力。
        // 这是「唯一事实源 + 一处替换」的全部内容 —— 不再有第二份需要同步的正文。
        var bytes2 = entry.Key == OfficialSkillTemplates.FindMapSkillsKey
            ? PackSkills(entries, extraFiles: null, transform: text => text.Replace(
                "${PRD_AGENT_BASE:?缺 base URL。导出 PRD_AGENT_BASE=https://your-platform}",
                $"${{PRD_AGENT_BASE:={baseUrl}}}"))
            : PackSkills(entries, extraFiles: null);
        Response.Headers.Append("Cache-Control", "no-store");
        var fileCount = entries.Sum(e => e.Files.Count);
        _logger.LogInformation("[OfficialSkills] 下发 {SkillKey} 技能包 {Files} 文件 {Bytes} bytes", skillKey, fileCount, bytes2.Length);
        return File(bytes2, "application/zip", $"{entry.Key}.zip");
    }

    /// <summary>
    /// 列出角色套装（匿名可访问）。
    /// GET /api/official-skills/bundles[?role=pm]
    ///
    /// 这是「还没有账号的人」的入口：拿到 downloadUrl 就能一条 curl 装齐，
    /// 不需要注册、不需要 AgentApiKey（那只在往市场上传时才需要）。
    /// </summary>
    [HttpGet("bundles")]
    public IActionResult ListBundles([FromQuery] string? role)
    {
        var baseUrl = ResolveBaseUrl().TrimEnd('/');
        var bundles = OfficialSkillCatalog.AllBundles.AsEnumerable();
        if (!string.IsNullOrWhiteSpace(role))
        {
            var r = role.Trim();
            bundles = bundles.Where(b => b.Roles.Any(x => string.Equals(x, r, StringComparison.OrdinalIgnoreCase)));
        }

        var items = bundles.Select(b =>
        {
            var expanded = OfficialSkillCatalog.ExpandWithRequires(b.Includes, out _);
            return new
            {
                key = b.Key,
                title = b.Title,
                version = b.Version,
                description = b.Description,
                tags = b.Tags,
                roles = b.Roles,
                roleLabels = b.Roles
                    .Select(x => OfficialSkillCatalog.RoleLabels.TryGetValue(x, out var label) ? label : x)
                    .ToList(),
                firstStep = b.FirstStep,
                skillCount = expanded.Count,
                skills = expanded.Select(e => new { key = e.Key, title = e.Title, description = e.Description }).ToList(),
                downloadUrl = $"{baseUrl}/api/official-skills/{b.Key}/download",
                // 项目级 + 三宿主探测：与 findmapskills 和 CDS 初始化脚本同一套约定。
                // 装到用户主目录的话技能不跟项目走，团队 clone 下来少一半。
                installCommand = SkillInstallContract.BuildInstallCommand(
                    $"{baseUrl}/api/official-skills/{b.Key}/download", $"{b.Key}.zip"),
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            roleLabels = OfficialSkillCatalog.RoleLabels,
            items,
        }));
    }

    private IActionResult BuildBundleZip(OfficialSkillCatalog.BundleEntry bundle)
    {
        var entries = OfficialSkillCatalog.ExpandWithRequires(bundle.Includes, out var missing);
        if (missing.Count > 0)
        {
            return StatusCode(500, ApiResponse<object>.Fail(
                ErrorCodes.INTERNAL_ERROR,
                $"角色套装 {bundle.Key} 缺少技能: {string.Join(", ", missing)}"));
        }

        var manifest = System.Text.Json.JsonSerializer.Serialize(new
        {
            kind = "bundle",
            key = bundle.Key,
            title = bundle.Title,
            version = bundle.Version,
            roles = bundle.Roles,
            skills = entries.Select(e => new { key = e.Key, title = e.Title, version = e.Version }).ToList(),
        }, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });

        var extra = new Dictionary<string, string>
        {
            ["INSTALL.md"] = BuildBundleInstallMd(bundle, entries),
            ["bundle.manifest.json"] = manifest,
        };

        var bytes = PackSkills(entries, extra);
        Response.Headers.Append("Cache-Control", "no-store");
        _logger.LogInformation(
            "[OfficialSkills] 下发角色套装 {BundleKey} 含 {Skills} 个技能 {Bytes} bytes",
            bundle.Key, entries.Count, bytes.Length);
        return File(bytes, "application/zip", $"{bundle.Key}.zip");
    }

    /// <summary>
    /// 套装 zip 顶层的 INSTALL.md —— 解压后用户看到的第一份说明。
    /// 必须回答三件事：装到哪了、下一句说什么、这套东西都有什么。
    /// </summary>
    private static string BuildBundleInstallMd(
        OfficialSkillCatalog.BundleEntry bundle,
        IReadOnlyList<OfficialSkillCatalog.SkillEntry> entries)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {bundle.Title}");
        sb.AppendLine();
        sb.AppendLine($"> {bundle.Description}");
        sb.AppendLine();
        sb.AppendLine("## 解压到哪");
        sb.AppendLine();
        sb.AppendLine("装到**项目级**技能目录，不是用户主目录 —— 技能跟着项目的版本库走，团队每个人 clone 下来都有。");
        sb.AppendLine();
        sb.AppendLine("项目里存在几个 Agent 宿主目录（`.claude` / `.cursor` / `.agents`）就装几份：");
        sb.AppendLine("只装其中一个的话，从另一个 Agent 打开这个项目会一个技能都看不见。");
        sb.AppendLine();
        sb.AppendLine("```bash");
        sb.AppendLine(SkillInstallContract.DetectSnippet);
        sb.AppendLine("for d in $SKILLS_DIRS; do unzip -o <本 zip> -d \"$d\"; done");
        sb.AppendLine("```");
        sb.AppendLine();
        sb.AppendLine($"解压后每个技能目录下会多出 {entries.Count} 个技能，重开 AI 编程工具即可识别。");
        sb.AppendLine();
        sb.AppendLine("## 下一步");
        sb.AppendLine();
        sb.AppendLine(string.IsNullOrWhiteSpace(bundle.FirstStep)
            ? "打开 Claude Code，输入 `/sdd-init`。"
            : bundle.FirstStep);
        sb.AppendLine();
        sb.AppendLine("## 这套里都有什么");
        sb.AppendLine();
        sb.AppendLine("| 技能 | 用途 |");
        sb.AppendLine("|---|---|");
        foreach (var e in entries)
        {
            var desc = (e.Description ?? string.Empty).Replace("|", "/").Replace("\n", " ");
            if (desc.Length > 120) desc = desc[..117] + "...";
            sb.AppendLine($"| `{e.Key}` | {desc} |");
        }
        sb.AppendLine();
        return sb.ToString();
    }

    /// <summary>把技能目录打成 zip：每个技能落在 `{key}/` 下，解压到宿主目录即 `<宿主>/skills/{key}/`。</summary>
    private static byte[] PackSkills(
        IReadOnlyList<OfficialSkillCatalog.SkillEntry> entries,
        IReadOnlyDictionary<string, string>? extraFiles,
        Func<string, string>? transform = null)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var packagedEntry in entries)
            {
                foreach (var f in packagedEntry.Files)
                    WriteEntry(zip, $"{packagedEntry.Key}/{f.Path}", transform?.Invoke(f.Content) ?? f.Content);
            }
            foreach (var kv in extraFiles ?? new Dictionary<string, string>())
                WriteEntry(zip, kv.Key, kv.Value);
        }
        return ms.ToArray();
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
