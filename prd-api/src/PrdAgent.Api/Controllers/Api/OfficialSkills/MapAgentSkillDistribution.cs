using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api.OfficialSkills;

public partial class OfficialSkillsController
{
    private const string MapAgentKey = "map-agent";
    private const string MapAgentInstallerPath = "scripts/skill_manager.py";

    /// <summary>匿名分发契约：浏览器不能推断本机已装版本，安装器据此检查、验证和更新。</summary>
    [AllowAnonymous]
    [HttpGet("map-agent/manifest")]
    public IActionResult MapAgentManifest()
    {
        var entry = OfficialSkillCatalog.Find(MapAgentKey);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "MAP 配套技能尚未发布"));

        var baseUrl = Request.ResolveExternalBaseUrl().TrimEnd('/');
        var prefix = $"{baseUrl}/api/official-skills/{MapAgentKey}";
        var bytes = PackMapAgent(entry);
        var installer = entry.Files.Single(f => f.Path == MapAgentInstallerPath);
        Response.Headers.CacheControl = "no-store";
        return Ok(ApiResponse<object>.Ok(new
        {
            key = entry.Key,
            version = entry.Version,
            title = entry.Title,
            description = entry.Description,
            sha256 = Digest(bytes),
            downloadUrl = $"{prefix}/download",
            workBuddyDownloadUrl = $"{prefix}/download?client=workbuddy",
            workBuddySha256 = Digest(PackMapAgent(entry, workBuddy: true)),
            manifestUrl = $"{prefix}/manifest",
            installerUrl = $"{prefix}/installer",
            installerSha256 = Digest(Encoding.UTF8.GetBytes(installer.Content)),
            supportedHosts = new[] { ".agents/skills", ".claude/skills" },
            workBuddyInstall = "download-import",
            files = entry.Files.OrderBy(f => f.Path, StringComparer.Ordinal).Select(f => new
            {
                path = f.Path,
                sha256 = Digest(Encoding.UTF8.GetBytes(f.Content)),
            }),
        }));
    }

    /// <summary>安装、检查和更新共用同一脚本，正文仍来自技能目录的唯一源。</summary>
    [AllowAnonymous]
    [HttpGet("map-agent/installer")]
    public IActionResult MapAgentInstaller()
    {
        var installer = OfficialSkillCatalog.Find(MapAgentKey)?.Files
            .SingleOrDefault(f => f.Path == MapAgentInstallerPath);
        if (installer == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "MAP 技能安装器尚未发布"));
        Response.Headers.CacheControl = "no-store";
        return File(Encoding.UTF8.GetBytes(installer.Content), "text/x-python; charset=utf-8", "map-agent-installer.py");
    }

    // 固定元数据与排序，使 manifest 摘要和下一次 download 的实际 ZIP 字节一致。
    private static byte[] PackMapAgent(OfficialSkillCatalog.SkillEntry entry, bool workBuddy = false)
    {
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var file in entry.Files.OrderBy(f => f.Path, StringComparer.Ordinal))
            {
                var item = zip.CreateEntry($"{entry.Key}/{file.Path}", CompressionLevel.Optimal);
                item.LastWriteTime = new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);
                using var stream = item.Open();
                var content = workBuddy && file.Path == "SKILL.md" ? WorkBuddySkillMd(entry, file.Content) : file.Content;
                var bytes = Encoding.UTF8.GetBytes(content);
                stream.Write(bytes);
            }
        }
        return output.ToArray();
    }

    private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    // WorkBuddy 市场要求的展示字段只在交付适配层补齐；两种包共用同一段技能正文。
    private static string WorkBuddySkillMd(OfficialSkillCatalog.SkillEntry entry, string skillMd)
    {
        var metadata = entry.Files.Single(f => f.Path == "workbuddy.metadata.json");
        var fields = JsonSerializer.Deserialize<Dictionary<string, string>>(metadata.Content)!;
        fields["version"] = entry.Version ?? "1.0.0";
        var end = skillMd.IndexOf("\n---", 3, StringComparison.Ordinal);
        if (!skillMd.StartsWith("---\n", StringComparison.Ordinal) || end < 0)
            throw new InvalidOperationException("MAP 技能头部格式无效");
        var header = string.Join("\n", fields.Select(pair => $"{pair.Key}: {JsonSerializer.Serialize(pair.Value)}"));
        return skillMd.Insert(end, "\n" + header);
    }
}
