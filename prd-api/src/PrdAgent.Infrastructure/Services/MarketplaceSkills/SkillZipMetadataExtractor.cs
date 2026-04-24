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
        string? Error);

    /// <summary>SKILL.md 预览最多存多少字（同时也是上交 LLM 做摘要的上限）</summary>
    private const int PreviewMaxChars = 2000;

    public ExtractResult Extract(byte[] zipBytes)
    {
        if (zipBytes == null || zipBytes.Length == 0)
            return new ExtractResult(false, null, null, null, null, "空文件");

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
            if (skillMd != null)
            {
                using var stream = skillMd.Open();
                using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                content = reader.ReadToEnd();
                preview = content.Length > PreviewMaxChars
                    ? content[..PreviewMaxChars]
                    : content;
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
                Error: null);
        }
        catch (InvalidDataException ex)
        {
            return new ExtractResult(false, null, null, null, null, $"不是有效的 zip 文件: {ex.Message}");
        }
        catch (Exception ex)
        {
            return new ExtractResult(false, null, null, null, null, $"解析失败: {ex.Message}");
        }
    }
}
