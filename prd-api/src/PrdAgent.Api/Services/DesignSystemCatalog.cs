using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services;

/// <summary>OpenDesign 某一套设计系统在快照里的样子：元数据 + 真实 tokens.css + 从 tokens 派生的展示字段。</summary>
public sealed record DesignSystemEntry(
    string Id,
    string Name,
    string Category,
    string Description,
    string Summary,
    string SummarySource,
    string TokensCss,
    DesignSystemSwatches Swatches,
    DesignSystemFonts Fonts);

/// <summary>取自 tokens.css 的 <c>:root</c> 块：--bg / --fg / --accent 的原值（可能是 #hex，也可能是 oklch()/rgba()）。</summary>
public sealed record DesignSystemSwatches(string Bg, string Fg, string Accent);

/// <summary>取自 tokens.css 的 --font-display / --font-body（CSS font-family 原值）。</summary>
public sealed record DesignSystemFonts(string Display, string Body);

public sealed class DesignSystemCatalogUnavailableException : Exception
{
    public DesignSystemCatalogUnavailableException(string message) : base(message) { }
}

/// <summary>
/// 风格目录：OpenDesign 设计系统快照（scripts/sync-opendesign-design-systems.py 生成、内嵌进程序集）。
/// 单例、进程启动时加载一次；资源缺失或写坏时直接抛出并说明原因——绝不退化成空列表，
/// 否则风格选择会静默变成「一套都没有」，与「真的没有设计系统」分不开。
/// </summary>
public interface IDesignSystemCatalog
{
    string EngineVersion { get; }

    string EngineImage { get; }

    DateTime GeneratedAt { get; }

    IReadOnlyList<DesignSystemEntry> All { get; }

    DesignSystemEntry? Find(string? id);
}

public sealed class DesignSystemCatalog : IDesignSystemCatalog
{
    public const string ResourceFileName = "opendesign-design-systems.json";
    public const string SchemaVersion = "map-design-system-catalog/v1";

    private static readonly Regex RootBlockPattern = new(
        @"(?:^|\})\s*:root\s*\{(?<body>[^}]*)\}", RegexOptions.CultureInvariant | RegexOptions.Singleline);

    private readonly Dictionary<string, DesignSystemEntry> _byId;

    private DesignSystemCatalog(string engineVersion, string engineImage, DateTime generatedAt, IReadOnlyList<DesignSystemEntry> all)
    {
        EngineVersion = engineVersion;
        EngineImage = engineImage;
        GeneratedAt = generatedAt;
        All = all;
        _byId = all.ToDictionary(item => item.Id, StringComparer.Ordinal);
    }

    public string EngineVersion { get; }

    public string EngineImage { get; }

    public DateTime GeneratedAt { get; }

    public IReadOnlyList<DesignSystemEntry> All { get; }

    public DesignSystemEntry? Find(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        return _byId.TryGetValue(id.Trim().ToLowerInvariant(), out var entry) ? entry : null;
    }

    /// <summary>从程序集内嵌资源加载；找不到或解析失败都抛 <see cref="DesignSystemCatalogUnavailableException"/>。</summary>
    public static DesignSystemCatalog LoadEmbedded()
    {
        var assembly = typeof(DesignSystemCatalog).Assembly;
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith(ResourceFileName, StringComparison.OrdinalIgnoreCase));
        if (resourceName == null)
            throw new DesignSystemCatalogUnavailableException(
                $"内嵌资源 {ResourceFileName} 不在程序集里（构建时没打进去）。先跑 scripts/sync-opendesign-design-systems.py 生成快照，并确认 PrdAgent.Api.csproj 的 EmbeddedResource 登记了它。");
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new DesignSystemCatalogUnavailableException($"内嵌资源 {resourceName} 打不开");
        using var reader = new StreamReader(stream);
        return Parse(reader.ReadToEnd());
    }

    internal static DesignSystemCatalog Parse(string json)
    {
        SnapshotFile? file;
        try
        {
            file = JsonSerializer.Deserialize<SnapshotFile>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (JsonException ex)
        {
            throw new DesignSystemCatalogUnavailableException($"设计系统快照不是合法 JSON：{ex.Message}");
        }
        if (file == null || file.SchemaVersion != SchemaVersion)
            throw new DesignSystemCatalogUnavailableException(
                $"设计系统快照的 schemaVersion 是「{file?.SchemaVersion}」，这一版只认 {SchemaVersion}");
        if (string.IsNullOrWhiteSpace(file.Engine?.Version))
            throw new DesignSystemCatalogUnavailableException("设计系统快照没有写 OpenDesign 版本");
        if (file.DesignSystems is not { Count: > 0 })
            throw new DesignSystemCatalogUnavailableException("设计系统快照里一套设计系统都没有");

        var entries = new List<DesignSystemEntry>(file.DesignSystems.Count);
        foreach (var raw in file.DesignSystems)
        {
            var id = raw.Id?.Trim() ?? string.Empty;
            if (id.Length == 0) throw new DesignSystemCatalogUnavailableException("设计系统快照里有一项没有 id");
            var css = raw.TokensCss ?? string.Empty;
            string Required(string token) => ReadRootToken(css, token)
                ?? throw new DesignSystemCatalogUnavailableException($"设计系统「{id}」的 tokens.css 在 :root 里没有 {token}");
            entries.Add(new DesignSystemEntry(
                id,
                string.IsNullOrWhiteSpace(raw.Name) ? id : raw.Name.Trim(),
                string.IsNullOrWhiteSpace(raw.Category) ? "Uncategorized" : raw.Category.Trim(),
                raw.Description?.Trim() ?? string.Empty,
                raw.Summary?.Trim() ?? raw.Description?.Trim() ?? string.Empty,
                raw.SummarySource ?? "manifest-description",
                css,
                new DesignSystemSwatches(Required("--bg"), Required("--fg"), Required("--accent")),
                new DesignSystemFonts(Required("--font-display"), Required("--font-body"))));
        }
        var duplicate = entries.GroupBy(entry => entry.Id, StringComparer.Ordinal).FirstOrDefault(group => group.Count() > 1);
        if (duplicate != null) throw new DesignSystemCatalogUnavailableException($"设计系统「{duplicate.Key}」在快照里出现了两次");

        return new DesignSystemCatalog(
            file.Engine.Version!.Trim(),
            file.Engine.Image?.Trim() ?? string.Empty,
            file.GeneratedAt ?? DateTime.MinValue,
            entries.OrderBy(entry => entry.Id, StringComparer.Ordinal).ToList());
    }

    /// <summary>
    /// 读 tokens.css 第一段 <c>:root { }</c> 里某个自定义属性的值；同一块里声明多次时取最后一条（层叠的胜者）。
    /// 只读 :root，不读 [data-theme="dark"] 之类的覆盖块——样张与色块展示的是设计系统的默认形态。
    /// </summary>
    internal static string? ReadRootToken(string css, string token)
    {
        var root = RootBlockPattern.Match(css);
        if (!root.Success) return null;
        string? winner = null;
        foreach (var declaration in root.Groups["body"].Value.Split(';'))
        {
            var colon = declaration.IndexOf(':');
            if (colon <= 0) continue;
            if (!string.Equals(declaration[..colon].Trim(), token, StringComparison.Ordinal)) continue;
            var value = declaration[(colon + 1)..].Trim();
            if (value.Length > 0) winner = value;
        }
        return winner;
    }

    private sealed class SnapshotFile
    {
        public string? SchemaVersion { get; set; }

        public SnapshotEngine? Engine { get; set; }

        public DateTime? GeneratedAt { get; set; }

        public List<SnapshotDesignSystem>? DesignSystems { get; set; }
    }

    private sealed class SnapshotEngine
    {
        public string? Version { get; set; }

        public string? Image { get; set; }
    }

    private sealed class SnapshotDesignSystem
    {
        public string? Id { get; set; }

        public string? Name { get; set; }

        public string? Category { get; set; }

        public string? Description { get; set; }

        public string? Summary { get; set; }

        public string? SummarySource { get; set; }

        [JsonPropertyName("tokensCss")]
        public string? TokensCss { get; set; }
    }
}
