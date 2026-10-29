using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 把一次运行已经冻结的要求、资料、当前页面和设计方向确定性收敛成设计简报与品牌包。
/// 这里不调用模型，也不读取运行创建之后发生变化的设置。
/// </summary>
public static class DesignArtifactBriefFactory
{
    private static readonly Regex AudiencePattern = new(
        @"(?:受众|面向|给)(?:是|为|给)?[：:\s]*(?<value>[^，。；;！!？?\r\n]{2,48})",
        RegexOptions.Compiled | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    private static readonly Regex ActionPattern = new(
        @"(?<value>[^。；;！!？?\r\n]{0,80}(?:按钮|报名|联系|咨询|申请|购买|下载|预约|了解更多)[^。；;！!？?\r\n]{0,40})",
        RegexOptions.Compiled | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    private static readonly Regex MarkdownHeadingPattern = new(
        @"^(?<level>#{1,3})\s+(?<value>[^#\r\n]{1,120})\s*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.Multiline,
        TimeSpan.FromSeconds(1));
    private static readonly Regex HtmlHeadingPattern = new(
        @"<h(?<level>[1-3])\b[^>]*>(?<value>[\s\S]*?)</h\k<level>\s*>",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase,
        TimeSpan.FromSeconds(1));
    private static readonly Regex HtmlTagPattern = new(
        "<[^>]+>", RegexOptions.Compiled | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    private static readonly Regex LabeledLinePattern = new(
        @"^(?:[-*]\s*)?(?<label>必需事实|固定声明|禁止风格|不要使用)[：:]\s*(?<value>.+?)\s*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.Multiline,
        TimeSpan.FromSeconds(1));
    private static readonly Regex LogoNamePattern = new(
        "(?:logo|标志|品牌标识)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));

    public static void Freeze(DesignArtifactRun run, string? currentHtml)
    {
        ArgumentNullException.ThrowIfNull(run);
        if (run.DesignBrief != null || run.BrandPackage != null)
            throw new InvalidOperationException("设计简报与品牌包只能在任务开始时冻结一次");

        run.BrandPackage = BuildBrandPackage(run);
        run.DesignBrief = BuildDesignBrief(run, currentHtml, run.BrandPackage);
        run.DesignContextProvenance ??= new DesignArtifactContextProvenance
        {
            Source = DesignArtifactContextSources.DeterministicNewRun,
        };
    }

    /// <summary>
    /// 修改任务沿用目标站点权威来源的完整冻结上下文。修改指令仍保留在新 Run.Instruction，
    /// 不参与重算品牌或原始简报；来源类型、版本和父指纹用于审计继承链。
    /// </summary>
    public static bool TryInheritFrozenContext(
        DesignArtifactRun target,
        DesignArtifactRun source,
        string contextSource,
        string? sourceRevisionId)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(source);
        if (source.DesignBrief == null || source.BrandPackage == null) return false;
        if (target.DesignBrief != null || target.BrandPackage != null)
            throw new InvalidOperationException("设计简报与品牌包只能在任务开始时冻结一次");

        target.DesignDirection = Clone(source.DesignDirection);
        target.DesignBrief = Clone(source.DesignBrief)!;
        target.BrandPackage = Clone(source.BrandPackage)!;
        target.DesignContextProvenance = new DesignArtifactContextProvenance
        {
            Source = contextSource,
            SourceRunId = source.Id,
            SourceRevisionId = string.IsNullOrWhiteSpace(sourceRevisionId) ? null : sourceRevisionId.Trim(),
            ParentDesignBriefFingerprint = source.DesignBrief.Fingerprint,
            ParentBrandPackageFingerprint = source.BrandPackage.Fingerprint,
        };
        return true;
    }

    public static void MarkLegacyEditFallback(DesignArtifactRun run, string? sourceRevisionId)
    {
        ArgumentNullException.ThrowIfNull(run);
        run.DesignContextProvenance = new DesignArtifactContextProvenance
        {
            Source = DesignArtifactContextSources.LegacyEditDeterministicFallback,
            SourceRevisionId = string.IsNullOrWhiteSpace(sourceRevisionId) ? null : sourceRevisionId.Trim(),
        };
    }

    internal static DesignArtifactBrandPackage? BuildBrandPackage(DesignArtifactRun run)
    {
        var direction = run.DesignDirection;
        if (direction == null) return null;

        var sourceTexts = SourceTexts(run).ToList();
        var fixedStatements = LabeledValues(sourceTexts, "固定声明");
        var forbiddenStyles = LabeledValues(
            sourceTexts.Append(run.Instruction).Append(direction.StyleDescription),
            "禁止风格", "不要使用");
        var examples = direction.BrandExamples
            .Concat((run.ReferenceImages ?? new List<DesignReferenceImage>())
                .Select((image, index) => ReferenceImagePath(index, image.MimeType)))
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .Take(12)
            .ToList();
        var logo = FindLogoReference(run.ReferenceImages);
        var colors = direction.BrandColors.Where(NotBlank).Select(value => value.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Take(8).ToList();
        var fonts = direction.BrandFonts.Where(NotBlank).Select(value => value.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Take(8).ToList();
        var tokenContext = new Dictionary<string, string>(StringComparer.Ordinal);
        if (colors.Count > 0) tokenContext["--fg"] = colors[0];
        if (colors.Count > 1) tokenContext["--bg"] = colors[1];
        if (colors.Count > 2) tokenContext["--accent"] = colors[2];
        if (fonts.Count > 0) tokenContext["--font-display"] = fonts[0];
        if (fonts.Count > 1) tokenContext["--font-body"] = fonts[1];

        var package = new DesignArtifactBrandPackage
        {
            Ref = direction.StyleId,
            Source = string.IsNullOrWhiteSpace(direction.BrandSource) ? "design-direction-fallback" : direction.BrandSource,
            DesignSystemId = direction.DesignSystemId,
            Logo = logo,
            ApprovedColors = colors,
            Fonts = fonts,
            FixedStatements = fixedStatements,
            ForbiddenStyles = forbiddenStyles,
            Examples = examples,
            TokenContext = tokenContext,
        };
        package.Fingerprint = Fingerprint(new
        {
            package.SchemaVersion,
            package.Version,
            package.Ref,
            package.Source,
            package.DesignSystemId,
            package.Logo,
            package.ApprovedColors,
            package.Fonts,
            package.FixedStatements,
            package.ForbiddenStyles,
            package.Examples,
            package.TokenContext,
        });
        return package;
    }

    internal static DesignArtifactDesignBrief BuildDesignBrief(
        DesignArtifactRun run,
        string? currentHtml,
        DesignArtifactBrandPackage? brandPackage)
    {
        var sourceTexts = SourceTexts(run).ToList();
        var instruction = run.Instruction.Trim();
        var headings = ExtractHeadings(sourceTexts, currentHtml);
        var requiredFacts = LabeledValues(sourceTexts, "必需事实", "固定声明");
        var title = (run.Title ?? string.Empty).Trim();
        var goal = FirstSentence(instruction, 240);
        var audienceMatch = AudiencePattern.Match(instruction);
        var audience = audienceMatch.Success
            ? audienceMatch.Groups["value"].Value.Trim()
            : "未单独指定，按冻结资料的内容语境表达";
        var actionMatch = ActionPattern.Match(instruction);
        var primaryAction = actionMatch.Success
            ? actionMatch.Groups["value"].Value.Trim()
            : "未指定主行动，不新增虚构按钮";
        var brief = new DesignArtifactDesignBrief
        {
            Goal = goal,
            Audience = audience,
            PrimaryMessage = title.Length > 0 ? title : goal,
            PrimaryAction = primaryAction,
            RequiredSections = headings.Required,
            OptionalSections = headings.Optional,
            Tone = run.DesignDirection?.StyleName ?? "沿用当前页面语气",
            VisualIntent = run.DesignDirection?.StyleDescription ?? "沿用当前页面的视觉语言",
            BrandKitRef = brandPackage?.Ref ?? "personal-style-fallback-unavailable",
            BrandKitVersion = brandPackage?.Version ?? 1,
            ResponsiveRequirements = new List<string>
            {
                "桌面与 390px 移动视口均可读",
                "不得出现横向滚动或关键内容裁切",
                "主行动与核心信息在移动端保持可发现",
            },
            FactualCoverageRequirements = new DesignArtifactFactualCoverageRequirements
            {
                RequiredCoveragePercent = 100,
                UnsupportedFactsAllowed = false,
                RequiredFacts = requiredFacts,
                SourceContentHashes = run.KnowledgeReferences.Select(item => item.ContentHash)
                    .Concat((run.UploadedSources ?? new List<DesignUploadedSource>()).Select(item => item.ContentHash))
                    .Concat(string.IsNullOrWhiteSpace(currentHtml)
                        ? Array.Empty<string>()
                        : new[] { Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(currentHtml))).ToLowerInvariant() })
                    .Where(NotBlank)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(value => value, StringComparer.Ordinal)
                    .ToList(),
            },
        };
        brief.Fingerprint = Fingerprint(new
        {
            brief.SchemaVersion,
            brief.Version,
            brief.Goal,
            brief.Audience,
            brief.PrimaryMessage,
            brief.PrimaryAction,
            brief.RequiredSections,
            brief.OptionalSections,
            brief.Tone,
            brief.VisualIntent,
            brief.BrandKitRef,
            brief.BrandKitVersion,
            brief.ResponsiveRequirements,
            brief.FactualCoverageRequirements,
            brandFingerprint = brandPackage?.Fingerprint,
        });
        return brief;
    }

    private static IEnumerable<string> SourceTexts(DesignArtifactRun run) =>
        run.KnowledgeReferences.Select(item => item.Content)
            .Concat((run.UploadedSources ?? new List<DesignUploadedSource>()).Select(item => item.Content));

    private static (List<string> Required, List<string> Optional) ExtractHeadings(
        IReadOnlyList<string> sourceTexts,
        string? currentHtml)
    {
        var required = new List<string>();
        var optional = new List<string>();
        foreach (var source in sourceTexts)
        {
            foreach (Match match in MarkdownHeadingPattern.Matches(source))
            {
                var target = match.Groups["level"].Value.Length <= 2 ? required : optional;
                AddDistinct(target, match.Groups["value"].Value);
            }
        }
        if (!string.IsNullOrWhiteSpace(currentHtml))
        {
            foreach (Match match in HtmlHeadingPattern.Matches(currentHtml))
            {
                var target = int.Parse(match.Groups["level"].Value) <= 2 ? required : optional;
                AddDistinct(target, WebUtility.HtmlDecode(HtmlTagPattern.Replace(match.Groups["value"].Value, " ")));
            }
        }
        return (required.Take(16).ToList(), optional.Where(item => !required.Contains(item, StringComparer.Ordinal)).Take(16).ToList());
    }

    private static List<string> LabeledValues(IEnumerable<string> sources, params string[] labels)
    {
        var allowed = labels.ToHashSet(StringComparer.Ordinal);
        var values = new List<string>();
        foreach (var source in sources.Where(NotBlank))
        {
            foreach (Match match in LabeledLinePattern.Matches(source))
            {
                if (!allowed.Contains(match.Groups["label"].Value)) continue;
                AddDistinct(values, match.Groups["value"].Value, 200);
            }
        }
        return values.Take(24).ToList();
    }

    private static string? FindLogoReference(IReadOnlyList<DesignReferenceImage>? images)
    {
        if (images is not { Count: > 0 }) return null;
        for (var index = 0; index < images.Count; index++)
        {
            var image = images[index];
            if (!LogoNamePattern.IsMatch(image.FileName ?? string.Empty)) continue;
            return ReferenceImagePath(index, image.MimeType);
        }
        return null;
    }

    private static string ReferenceImagePath(int index, string mimeType)
    {
        var extension = mimeType switch
        {
            "image/jpeg" => ".jpg",
            "image/webp" => ".webp",
            _ => ".png",
        };
        return $"reference/screenshot-{index + 1:D2}{extension}";
    }

    private static string FirstSentence(string value, int max)
    {
        var boundary = value.IndexOfAny(['。', '！', '？', '\n', '\r']);
        var sentence = (boundary >= 0 ? value[..boundary] : value).Trim();
        return sentence.Length <= max ? sentence : sentence[..max];
    }

    private static void AddDistinct(List<string> target, string value, int max = 120)
    {
        var normalized = Regex.Replace(value, @"\s+", " ").Trim().Trim('#', '-', '*');
        if (normalized.Length == 0) return;
        if (normalized.Length > max) normalized = normalized[..max];
        if (!target.Contains(normalized, StringComparer.Ordinal)) target.Add(normalized);
    }

    private static bool NotBlank(string? value) => !string.IsNullOrWhiteSpace(value);

    private static string Fingerprint(object value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()[..12];
    }

    private static T? Clone<T>(T? value)
    {
        if (value == null) return default;
        return JsonSerializer.Deserialize<T>(JsonSerializer.SerializeToUtf8Bytes(
            value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)),
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
    }
}
