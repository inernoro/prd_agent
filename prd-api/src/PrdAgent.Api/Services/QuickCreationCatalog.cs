using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

internal static class QuickCreationCatalog
{
    private static readonly Lazy<Catalog> Content = new(Load);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    internal static Catalog Get() => Content.Value;

    internal static Template? Find(string? id) =>
        id is { Length: > 0 and <= 64 } && Get().ById.TryGetValue(id, out var template)
            ? template : null;

    internal static byte[] ReadGuide(Template template)
    {
        using var stream = Open($"QuickCreation.styles.{template.Id}.md");
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        var bytes = buffer.ToArray();
        if (Hash(bytes) != template.GuideSha256)
            throw new InvalidDataException("快捷创作的风格说明与发布目录不一致");
        return bytes;
    }

    internal static DesignArtifactDesignDirection FreezeWebDirection(Template template, string guide)
    {
        var direction = new DesignArtifactDesignDirection
        {
            StyleId = $"opuscar:{template.Id}",
            StyleName = template.Name,
            StyleDescription = template.Line,
            GeneratePrompt = guide,
            BrandSource = "lemo-opuscar",
            PromptFingerprint = template.GuideSha256,
        };
        return direction;
    }

    private static Catalog Load()
    {
        using var stream = Open("QuickCreation.catalog.json");
        var catalog = JsonSerializer.Deserialize<Catalog>(stream, JsonOptions)
            ?? throw new InvalidDataException("快捷创作的风格目录格式不正确");
        if (catalog.Items.Count != 99 || catalog.Categories.Count != 15)
            throw new InvalidDataException("快捷创作的风格目录缺少固定版的条目");
        return catalog;
    }

    private static Stream Open(string name) =>
        typeof(QuickCreationCatalog).Assembly.GetManifestResourceStream(name)
        ?? throw new InvalidDataException("快捷创作的资源没有随服务发布");

    internal static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    internal sealed record Catalog(string Revision, Source Source, List<Category> Categories, List<Template> Items)
    {
        private Dictionary<string, Template>? _byId;
        [JsonIgnore]
        internal IReadOnlyDictionary<string, Template> ById => _byId ??= Items.ToDictionary(item => item.Id, StringComparer.Ordinal);
    }

    internal sealed record Source(string Name, string Url, string PosterLicense);
    internal sealed record Category(string Id, string Name, string NameEn);
    internal sealed record Template(
        string Id, string Name, string NameEn, string CategoryId, string PosterUrl, string Film,
        string Line, int DurationSec, string PromptRef, bool? NeedsImageTool, string GuideSha256);
}
