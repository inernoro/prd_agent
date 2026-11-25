namespace PrdAgent.Core.Models;

public sealed record VideoTemplateDefinition(string Id, string Name, string Description, string Paper, string Ink, string Accent);

public static class VideoTemplateCatalog
{
    public const int SceneCount = 3;

    public static IReadOnlyList<VideoTemplateDefinition> Items { get; } =
    [
        new("sketchnote", "视觉笔记", "在一张点阵纸上画清背景、决定和下一步。", "F8F3E7", "28251E", "E5AE38"),
    ];

    public static VideoTemplateDefinition? Find(string? id) => Items.FirstOrDefault(item => item.Id == id);
}
