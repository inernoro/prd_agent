using System.IO.Compression;
using System.Text;

namespace PrdAgent.Infrastructure.Services.MarketplaceSkills;

/// <summary>
/// 从 zip 技能包里读取 SKILL.md 等元数据。
/// v1 仅用于展示：读内容 → 上交给 LLM 生成 30 字摘要。
/// 未来接执行引擎时复用此 service 做 manifest 解析。
/// </summary>
public sealed class SkillZipMetadataExtractor
{
    public record ExtractResult(
        bool HasSkillMd,
        string? SkillMdContent,
        string? SkillMdPreview,
        string? ManifestVersion,
        string? EntryPoint,
        string? Error,
        // SKILL.md frontmatter 提取的字段（2026-05-01 加入）：
        // 用户上传时若未显式指定 slug / version，从这里兜底拿。
        string? FrontmatterName,
        string? FrontmatterVersion);

    /// <summary>SKILL.md 预览最多存多少字（同时也是上交 LLM 做摘要的上限）</summary>
    private const int PreviewMaxChars = 2000;

    public ExtractResult Extract(byte[] zipBytes)
    {
        if (zipBytes == null || zipBytes.Length == 0)
            return new ExtractResult(false, null, null, null, null, "空文件", null, null);

        try
        {
            using var ms = new MemoryStream(zipBytes);
            using var archive = new ZipArchive(ms, ZipArchiveMode.Read, leaveOpen: false);

            // 找 SKILL.md（不区分大小写，取第一个匹配；允许深层）
            var skillMd = archive.Entries.FirstOrDefault(e =>
                string.Equals(
                    Path.GetFileName(e.FullName),
                    "SKILL.md",
                    StringComparison.OrdinalIgnoreCase));

            string? content = null;
            string? preview = null;
            string? frontmatterName = null;
            string? frontmatterVersion = null;
            if (skillMd != null)
            {
                using var stream = skillMd.Open();
                using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                content = reader.ReadToEnd();
                preview = content.Length > PreviewMaxChars
                    ? content[..PreviewMaxChars]
                    : content;
                (frontmatterName, frontmatterVersion) = ParseFrontmatter(content);
            }

            // 预留：未来如果约定 manifest 文件，从这里解析
            string? manifestVersion = null;
            string? entryPoint = null;

            return new ExtractResult(
                HasSkillMd: skillMd != null,
                SkillMdContent: content,
                SkillMdPreview: preview,
                ManifestVersion: manifestVersion,
                EntryPoint: entryPoint,
                Error: null,
                FrontmatterName: frontmatterName,
                FrontmatterVersion: frontmatterVersion);
        }
        catch (InvalidDataException ex)
        {
            return new ExtractResult(false, null, null, null, null, $"不是有效的 zip 文件: {ex.Message}", null, null);
        }
        catch (Exception ex)
        {
            return new ExtractResult(false, null, null, null, null, $"解析失败: {ex.Message}", null, null);
        }
    }

    /// <summary>
    /// 极简 frontmatter 解析：只关心 name / version 两个键。
    /// 不引 YAML 库,因为我们要的格式很固定:
    ///   ---
    ///   name: foo
    ///   version: 1.2.3
    ///   description: ...
    ///   ---
    /// 边缘情况(数组、嵌套、引号转义等)交给上传者保证。
    /// (public 方便在测试项目里直接调用)
    /// </summary>
    public static (string? name, string? version) ParseFrontmatter(string content)
    {
        if (string.IsNullOrEmpty(content)) return (null, null);
        // 必须 --- 开头(可选 BOM/空行)
        var lines = content.Split('\n');
        var startIdx = 0;
        while (startIdx < lines.Length && string.IsNullOrWhiteSpace(lines[startIdx]))
            startIdx++;
        if (startIdx >= lines.Length || lines[startIdx].TrimEnd('\r').Trim() != "---")
            return (null, null);

        string? name = null, version = null;
        for (var i = startIdx + 1; i < lines.Length; i++)
        {
            var line = lines[i].TrimEnd('\r');
            if (line.Trim() == "---") break;
            var colonIdx = line.IndexOf(':');
            if (colonIdx <= 0) continue;
            var key = line[..colonIdx].Trim();
            var val = line[(colonIdx + 1)..].Trim().Trim('\'', '"');
            if (string.IsNullOrEmpty(val)) continue;
            if (key.Equals("name", StringComparison.OrdinalIgnoreCase) && name == null)
                name = val;
            else if (key.Equals("version", StringComparison.OrdinalIgnoreCase) && version == null)
                version = val;
            if (name != null && version != null) break;
        }
        return (name, version);
    }
}
