using System.Reflection;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Api.OfficialSkills;

/// <summary>
/// 官方技能目录：从内嵌的 official-skills.generated.json 加载（由
/// scripts/bundle-official-skills.mjs 在提交期生成，因为 .claude/skills 不在
/// API 的 Docker 构建上下文里）。
///
/// 不含 findmapskills —— 那一个由 <see cref="OfficialSkillTemplates"/> 特殊处理
/// （版本号 + {{BASE_URL}} 占位替换）。本目录是其余可移植技能。
/// </summary>
public static class OfficialSkillCatalog
{
    public sealed class SkillFile
    {
        public string Path { get; set; } = string.Empty;
        public string Content { get; set; } = string.Empty;
        public bool Truncated { get; set; }
    }

    public sealed class SkillEntry
    {
        public string Key { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
        public List<string> Tags { get; set; } = new();
        public List<SkillFile> Files { get; set; } = new();
    }

    private sealed class CatalogFile
    {
        public int Version { get; set; }
        public string? GeneratedAt { get; set; }
        public int Count { get; set; }
        public List<SkillEntry> Skills { get; set; } = new();
    }

    private static readonly Lazy<IReadOnlyList<SkillEntry>> _entries = new(Load);

    public static IReadOnlyList<SkillEntry> All => _entries.Value;

    public static SkillEntry? Find(string key) =>
        _entries.Value.FirstOrDefault(e => string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase));

    private static IReadOnlyList<SkillEntry> Load()
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            var resName = asm.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("official-skills.generated.json", StringComparison.OrdinalIgnoreCase));
            if (resName == null) return Array.Empty<SkillEntry>();

            using var stream = asm.GetManifestResourceStream(resName);
            if (stream == null) return Array.Empty<SkillEntry>();
            using var reader = new StreamReader(stream);
            var json = reader.ReadToEnd();

            var doc = JsonSerializer.Deserialize<CatalogFile>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });
            return doc?.Skills ?? new List<SkillEntry>();
        }
        catch
        {
            // 解析失败不致命：官方目录退化为空，市场仍展示 findmapskills + 用户技能
            return Array.Empty<SkillEntry>();
        }
    }
}
