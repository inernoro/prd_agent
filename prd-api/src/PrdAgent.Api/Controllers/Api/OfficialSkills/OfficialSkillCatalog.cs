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
        public string? Version { get; set; }
        public string Description { get; set; } = string.Empty;
        public List<string> Tags { get; set; } = new();

        /// <summary>角色归属（pm / dev / qa …），供海鲜市场按角色筛选；空表示不归任何角色。</summary>
        public List<string> Roles { get; set; } = new();

        /// <summary>硬依赖的其他技能 key —— 下载本技能时自动一并打包（递归展开）。</summary>
        public List<string> Requires { get; set; } = new();

        public List<SkillFile> Files { get; set; } = new();
    }

    /// <summary>
    /// 角色套装：一条 curl 装齐某个角色需要的全部技能。
    /// 与 <see cref="SkillEntry"/> 共用 `official-{key}` 下载命名空间，
    /// 打包脚本已保证 key 不与技能 key 相撞。
    /// </summary>
    public sealed class BundleEntry
    {
        public string Key { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string? Version { get; set; }
        public string Description { get; set; } = string.Empty;
        public List<string> Tags { get; set; } = new();
        public List<string> Roles { get; set; } = new();

        /// <summary>套装包含的技能 key（不含它们各自的 Requires，打包时再递归展开）。</summary>
        public List<string> Includes { get; set; } = new();

        /// <summary>装完第一步该干什么（写进 zip 里的 INSTALL.md）。</summary>
        public string? FirstStep { get; set; }
    }

    private sealed class CatalogFile
    {
        public int Version { get; set; }
        public string? GeneratedAt { get; set; }
        public int Count { get; set; }
        public Dictionary<string, string> RoleLabels { get; set; } = new();
        public List<SkillEntry> Skills { get; set; } = new();
        public List<BundleEntry> Bundles { get; set; } = new();
    }

    private static readonly Lazy<CatalogFile> _catalog = new(Load);

    public static IReadOnlyList<SkillEntry> All => _catalog.Value.Skills;

    public static IReadOnlyList<BundleEntry> AllBundles => _catalog.Value.Bundles;

    /// <summary>角色 key → 中文名（如 pm → 产品经理）。</summary>
    public static IReadOnlyDictionary<string, string> RoleLabels => _catalog.Value.RoleLabels;

    public static SkillEntry? Find(string key) =>
        _catalog.Value.Skills.FirstOrDefault(e => string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase));

    public static BundleEntry? FindBundle(string key) =>
        _catalog.Value.Bundles.FirstOrDefault(b => string.Equals(b.Key, key, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// 把一组技能 key 递归展开成「自己 + 全部依赖」，去重且保持稳定顺序。
    /// 依赖环由打包脚本挡在提交期（禁止自依赖），这里仍用 visited 兜底防死循环。
    /// </summary>
    public static List<SkillEntry> ExpandWithRequires(IEnumerable<string> keys, out List<string> missing)
    {
        var ordered = new List<SkillEntry>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var notFound = new List<string>();

        void Visit(string key)
        {
            if (!seen.Add(key)) return;
            var entry = Find(key);
            if (entry == null)
            {
                notFound.Add(key);
                return;
            }
            ordered.Add(entry);
            foreach (var dep in entry.Requires ?? new List<string>())
                Visit(dep);
        }

        foreach (var k in keys)
            Visit(k);

        missing = notFound;
        return ordered;
    }

    private static CatalogFile Load()
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            var resName = asm.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("official-skills.generated.json", StringComparison.OrdinalIgnoreCase));
            if (resName == null) return new CatalogFile();

            using var stream = asm.GetManifestResourceStream(resName);
            if (stream == null) return new CatalogFile();
            using var reader = new StreamReader(stream);
            var json = reader.ReadToEnd();

            var doc = JsonSerializer.Deserialize<CatalogFile>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });
            return doc ?? new CatalogFile();
        }
        catch
        {
            // 解析失败不致命：官方目录退化为空，市场仍展示 findmapskills + 用户技能
            return new CatalogFile();
        }
    }
}
