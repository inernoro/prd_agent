namespace PrdAgent.Infrastructure.Services.Poster;

/// <summary>
/// 周报海报模板注册表。
/// 每个模板决定 AI 生成的语调、默认色板、页面数量骨架、imagePrompt 风格关键词。
/// 保持「数据驱动」:前端拉 /api/weekly-posters/templates 得到完整元数据,
/// 后端按 TemplateKey 拼装 system prompt。
/// </summary>
public static class PosterTemplateRegistry
{
    public static readonly IReadOnlyList<PosterTemplate> All = new PosterTemplate[]
    {
        new()
        {
            Key = "release",
            Label = "发布",
            Description = "庆祝新版本上线,介绍亮点功能,期待感",
            Emoji = "🚀",
            DefaultPages = 5,
            AccentPalette = new[] { "#7c3aed", "#00f0ff", "#f43f5e", "#f59e0b", "#10b981" },
            ImageStyleKeywords =
                "cinematic dark-themed illustration, isometric perspective, " +
                "retro-futurism palette of cyan-violet-magenta, volumetric lighting, " +
                "soft bokeh, ultra-detailed, no people",
            Tone = "充满期待感的发布会语调,用动词开头,克制不浮夸。" +
                   "用户视角,告诉我能做什么、解决了什么问题,不讲代码实现",
        },
        new()
        {
            Key = "hotfix",
            Label = "修复",
            Description = "本周修复了哪些问题,让用户安心",
            Emoji = "🛠",
            DefaultPages = 4,
            AccentPalette = new[] { "#0ea5e9", "#64748b", "#22c55e", "#8b5cf6" },
            ImageStyleKeywords =
                "minimalist technical illustration, cool blue-teal palette, " +
                "blueprint grid, precision tools, clean lines, atmospheric depth, no people",
            Tone = "安定靠谱的工匠语调,强调「已经帮你搞定」,让用户感到受保护。" +
                   "结构化清晰,每页围绕一个修复主题展开",
        },
        new()
        {
            Key = "promo",
            Label = "宣传",
            Description = "主推新功能,邀请用户来试用",
            Emoji = "✨",
            DefaultPages = 5,
            AccentPalette = new[] { "#ec4899", "#a855f7", "#facc15", "#06b6d4", "#f43f5e" },
            ImageStyleKeywords =
                "vibrant editorial illustration, warm magenta-gold accents, dynamic composition, " +
                "poster-grade, bold typography-friendly negative space, glow, no people",
            Tone = "活泼有感染力,像朋友给你安利,一句话抓住注意力。" +
                   "末页给强邀请感",
        },
        new()
        {
            Key = "sale",
            Label = "促销",
            Description = "强 CTA 导向,限时福利",
            Emoji = "🎁",
            DefaultPages = 4,
            AccentPalette = new[] { "#ef4444", "#f97316", "#f59e0b", "#8b5cf6" },
            ImageStyleKeywords =
                "bold commercial poster aesthetic, hot orange-red gradient background, " +
                "high-contrast, cinematic lighting, celebratory fireworks particles, no people",
            Tone = "紧迫感 + 数字量化,每页都要有一个可点击的行动号召",
        },
    };

    public static PosterTemplate? Find(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        foreach (var t in All)
        {
            if (string.Equals(t.Key, key, StringComparison.OrdinalIgnoreCase)) return t;
        }
        return null;
    }

    public static PosterTemplate FindOrDefault(string? key) => Find(key) ?? All[0];
}

public sealed class PosterTemplate
{
    public string Key { get; init; } = string.Empty;
    public string Label { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public string Emoji { get; init; } = string.Empty;
    public int DefaultPages { get; init; } = 5;
    public string[] AccentPalette { get; init; } = Array.Empty<string>();
    /// <summary>追加到 imagePrompt 末尾的风格关键词,保证生图视觉调性统一</summary>
    public string ImageStyleKeywords { get; init; } = string.Empty;
    /// <summary>system prompt 里描述的文字语调</summary>
    public string Tone { get; init; } = string.Empty;
}
