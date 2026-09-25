using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>一条从样式里读出来的特征：界面上逐条展示「系统读到了什么」。</summary>
public sealed record PersonalStyleTrait(string Key, string Label, string Value);

/// <summary>确定性提取的结果。<see cref="FoundAnything"/> 为 false 表示页面里没有可用的样式，调用方应当拒绝而不是交出一段空说明。</summary>
public sealed record PersonalStyleDerivation(
    string Instruction,
    List<string> Swatches,
    List<string> Fonts,
    List<PersonalStyleTrait> Traits,
    string Evidence,
    bool FoundAnything);

/// <summary>系统为这套风格挑的 OpenDesign 骨架，以及挑它的依据（必须能说出来）。</summary>
public sealed record PersonalStyleBaseChoice(string DesignSystemId, string Reason);

/// <summary>
/// 「我的风格」的确定性提取：只解析 CSS，不调大模型。
///
/// 读入口 HTML 里的 &lt;style&gt;、行内 style 与站内 CSS 文件，数出配色、字体、字号、间距、圆角、投影与版式，
/// 再拼成一段和预设同类的「风格说明」。每一行都只写读到了的东西——读不到的维度整行不出现，
/// 不拿常见值填空（no-rootless-tree）。同样的输入永远得到同样的输出，方便复现与单测。
/// </summary>
public static class PersonalStyleDeriver
{
    public const int MaxInstructionLength = 1500;

    private static readonly Regex CommentPattern = new(@"/\*.*?\*/", RegexOptions.Singleline | RegexOptions.CultureInvariant);
    private static readonly Regex StyleBlockPattern = new(@"<style\b[^>]*>(?<css>.*?)</style\s*>", RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex InlineStylePattern = new(@"\sstyle\s*=\s*(?:""(?<v>[^""]*)""|'(?<v>[^']*)')", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex RulePattern = new(@"(?<sel>[^{}]*)\{(?<body>[^{}]*)\}", RegexOptions.Singleline | RegexOptions.CultureInvariant);
    private static readonly Regex LinkTagPattern = new(@"<link\b[^>]*>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex HrefPattern = new(@"\bhref\s*=\s*(?:""(?<v>[^""]*)""|'(?<v>[^']*)'|(?<v>[^\s>]+))", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex GoogleFamilyPattern = new(@"[?&]family=(?<f>[^&:]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex VarPattern = new(@"var\(\s*(?<name>--[A-Za-z0-9_-]+)\s*(?:,(?<fallback>[^()]*(?:\([^()]*\))*[^()]*))?\)", RegexOptions.CultureInvariant);
    private static readonly Regex HexPattern = new(@"#(?<h>[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b", RegexOptions.CultureInvariant);
    private static readonly Regex RgbPattern = new(@"rgba?\(\s*(?<r>[\d.]+%?)[\s,]+(?<g>[\d.]+%?)[\s,]+(?<b>[\d.]+%?)(?:\s*[,/]\s*(?<a>[\d.]+%?))?\s*\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex HslPattern = new(@"hsla?\(\s*(?<h>[\d.]+)(?:deg)?[\s,]+(?<s>[\d.]+)%[\s,]+(?<l>[\d.]+)%(?:\s*[,/]\s*(?<a>[\d.]+%?))?\s*\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex NamedColorPattern = new(@"(?<![-\w#])(?<n>white|black)(?![-\w])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex LengthPattern = new(@"(?<n>-?\d+(?:\.\d+)?)(?<u>px|rem|em)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex RepeatColumnsPattern = new(@"repeat\(\s*(?<n>\d+)\s*,", RegexOptions.CultureInvariant);
    private static readonly Regex HeadingSelectorPattern = new(@"(?<![\w-])h[1-3](?![\w-])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex CjkBigramSource = new(@"[一-鿿]+", RegexOptions.CultureInvariant);
    private static readonly Regex AsciiWordPattern = new(@"[a-z][a-z-]{3,}", RegexOptions.CultureInvariant);

    private static readonly HashSet<string> GenericFamilies = new(StringComparer.OrdinalIgnoreCase)
    {
        "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif",
        "ui-monospace", "-apple-system", "blinkmacsystemfont", "inherit", "initial", "unset", "emoji", "math",
    };

    private static readonly string[] PaperVarNames = { "--bg", "--background", "--paper", "--color-bg", "--color-background", "--surface", "--page-bg" };
    private static readonly string[] InkVarNames = { "--fg", "--text", "--ink", "--foreground", "--color-text", "--color-fg", "--text-color" };
    private static readonly string[] AccentVarNames = { "--accent", "--primary", "--brand", "--color-accent", "--color-primary", "--link", "--highlight" };

    /// <summary>一条 CSS 规则（选择器 + 已解析的声明，属性名小写）。</summary>
    internal sealed record CssRule(string Selector, IReadOnlyList<KeyValuePair<string, string>> Declarations);

    /// <summary>
    /// 从一张网页的样式里提取风格。<paramref name="linkedCss"/> 是站内 CSS 文件的正文（调用方负责读取与限量）；
    /// <paramref name="note"/> 是用户贴的描述，原样附在说明最后。
    /// </summary>
    public static PersonalStyleDerivation Derive(string? html, IReadOnlyList<string>? linkedCss, string? note)
    {
        html ??= string.Empty;
        var cssSources = new List<string>();
        var styleBlocks = 0;
        foreach (Match match in StyleBlockPattern.Matches(html))
        {
            cssSources.Add(match.Groups["css"].Value);
            styleBlocks++;
        }
        var linkedCount = 0;
        foreach (var css in linkedCss ?? Array.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(css)) continue;
            cssSources.Add(css);
            linkedCount++;
        }

        var rules = new List<CssRule>();
        foreach (var css in cssSources) rules.AddRange(ParseRules(css));
        var inlineCount = 0;
        foreach (Match match in InlineStylePattern.Matches(html))
        {
            var declarations = ParseDeclarations(match.Groups["v"].Value);
            if (declarations.Count == 0) continue;
            rules.Add(new CssRule("[inline]", declarations));
            inlineCount++;
        }

        var vars = CollectVariables(rules);
        var resolved = rules
            .Select(rule => new CssRule(rule.Selector, rule.Declarations
                .Where(d => !d.Key.StartsWith("--", StringComparison.Ordinal))
                .Select(d => new KeyValuePair<string, string>(d.Key, ResolveVars(d.Value, vars, 0)))
                .ToList()))
            .ToList();
        var declarationCount = resolved.Sum(rule => rule.Declarations.Count);

        var traits = new List<PersonalStyleTrait>();
        var lines = new List<string>();

        // ── 配色 ──
        var palette = ExtractPalette(resolved, vars);
        var swatches = new List<string>();
        if (palette.Paper != null || palette.Ink != null || palette.Accent != null)
        {
            var parts = new List<string>();
            if (palette.Paper is { } paper)
                parts.Add($"底色 {paper}（{(Luminance(paper) < 0.3 ? "深色页面" : Luminance(paper) > 0.75 ? "浅色页面" : "中间调页面")}）");
            if (palette.Ink is { } ink) parts.Add($"正文 {ink}");
            if (palette.Accent is { } accent) parts.Add($"强调色 {accent}");
            var line = "配色：" + string.Join("，", parts);
            if (palette.Others.Count > 0) line += $"；其余常用色 {string.Join("、", palette.Others)}";
            lines.Add(line + "。");
            traits.Add(new PersonalStyleTrait("palette", "配色", string.Join("，", parts)
                + (palette.Others.Count > 0 ? $"；其余 {string.Join("、", palette.Others)}" : string.Empty)));
            if (palette.Paper != null && palette.Ink != null && palette.Accent != null)
                swatches = new List<string> { palette.Ink, palette.Paper, palette.Accent };
        }

        // ── 字体 ──
        var fonts = ExtractFonts(html, resolved);
        var fontList = new List<string>();
        if (fonts.Heading != null || fonts.Body != null)
        {
            var heading = fonts.Heading ?? fonts.Body!;
            var body = fonts.Body ?? fonts.Heading!;
            var value = heading == body ? $"标题与正文都用「{body}」" : $"标题用「{heading}」，正文用「{body}」";
            lines.Add($"字体：{value}；找不到这些字体时用最接近的同类字体。");
            traits.Add(new PersonalStyleTrait("fonts", "字体", value));
            fontList.Add(heading);
            if (body != heading) fontList.Add(body);
        }

        // ── 字号 ──
        var sizes = ExtractFontSizes(resolved);
        if (sizes != null)
        {
            lines.Add($"字号：{sizes}。");
            traits.Add(new PersonalStyleTrait("font-sizes", "字号", sizes));
        }

        // ── 间距与形状 ──
        var shape = ExtractShape(resolved);
        if (shape.Count > 0)
        {
            lines.Add($"间距与形状：{string.Join("；", shape)}。");
            traits.Add(new PersonalStyleTrait("spacing", "间距与形状", string.Join("；", shape)));
        }

        // ── 版式 ──
        var layout = ExtractLayout(resolved);
        if (layout.Count > 0)
        {
            lines.Add($"版式：{string.Join("；", layout)}。");
            traits.Add(new PersonalStyleTrait("layout", "版式", string.Join("；", layout)));
        }

        var foundFromPage = lines.Count > 0;
        var trimmedNote = (note ?? string.Empty).Trim();
        if (trimmedNote.Length > 0)
        {
            lines.Add(foundFromPage ? $"另外：{trimmedNote}" : trimmedNote);
            traits.Add(new PersonalStyleTrait("note", "你的描述", trimmedNote));
        }

        var instruction = string.Join("\n", lines);
        if (instruction.Length > MaxInstructionLength) instruction = instruction[..MaxInstructionLength];
        var evidence = html.Length == 0 && linkedCount == 0
            ? "没有选网页，只按你的描述生成"
            : $"读了 {styleBlocks} 段页内样式、{linkedCount} 个站内样式文件、{inlineCount} 处行内样式，共 {declarationCount} 条声明";

        return new PersonalStyleDerivation(
            instruction,
            swatches,
            fontList,
            traits,
            evidence,
            FoundAnything: foundFromPage || trimmedNote.Length > 0);
    }

    /// <summary>入口 HTML 里引用的站内样式表路径（相对入口文件解析，外链不算）。按出现顺序去重。</summary>
    public static List<string> LocalStylesheetPaths(string? html, string entryFile)
    {
        var result = new List<string>();
        if (string.IsNullOrEmpty(html)) return result;
        var entryDir = entryFile.Contains('/') ? entryFile[..entryFile.LastIndexOf('/')] : string.Empty;
        foreach (Match tag in LinkTagPattern.Matches(html))
        {
            var text = tag.Value;
            if (!Regex.IsMatch(text, @"\brel\s*=\s*[""']?[^""'>]*stylesheet", RegexOptions.IgnoreCase)) continue;
            var href = HrefPattern.Match(text) is { Success: true } m ? m.Groups["v"].Value.Trim() : string.Empty;
            if (href.Length == 0 || href.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
            if (href.Contains("://", StringComparison.Ordinal) || href.StartsWith("//", StringComparison.Ordinal)) continue;
            var clean = href.Split('?', '#')[0];
            var path = clean.StartsWith('/') ? clean.TrimStart('/') : NormalizeRelative(entryDir, clean);
            if (path.Length > 0 && !result.Contains(path, StringComparer.OrdinalIgnoreCase)) result.Add(path);
        }
        return result;
    }

    /// <summary>
    /// 挑 OpenDesign 骨架：先按配色就近（底色权重最高），配色不够再按描述匹配预设，最后才用默认风格的骨架。
    /// 每一种都给出依据，界面原样展示并允许用户改。
    /// </summary>
    public static PersonalStyleBaseChoice ChooseBaseDesignSystem(
        IDesignSystemCatalog catalog,
        IReadOnlyList<string> swatches,
        string? note,
        IReadOnlyList<DesignStylePreset> presets,
        string defaultDesignSystemId)
    {
        if (swatches.Count == 3
            && TryParseColor(swatches[0], out var ink)
            && TryParseColor(swatches[1], out var paper)
            && TryParseColor(swatches[2], out var accent))
        {
            DesignSystemEntry? best = null;
            var bestScore = double.MaxValue;
            foreach (var entry in catalog.All)
            {
                if (!TryParseColor(entry.Swatches.Bg, out var bg)
                    || !TryParseColor(entry.Swatches.Fg, out var fg)
                    || !TryParseColor(entry.Swatches.Accent, out var ac)) continue;
                var score = 2.0 * Distance(paper, bg) + Distance(ink, fg) + 1.5 * Distance(accent, ac);
                if (score < bestScore)
                {
                    bestScore = score;
                    best = entry;
                }
            }
            if (best != null)
                return new PersonalStyleBaseChoice(best.Id, $"按配色就近选：底色、正文与强调色和「{best.Name}」最接近");
        }

        var trimmed = (note ?? string.Empty).Trim().ToLowerInvariant();
        if (trimmed.Length > 0)
        {
            var bigrams = CjkBigrams(trimmed);
            var words = AsciiWordPattern.Matches(trimmed).Select(m => m.Value).Distinct().ToList();
            DesignStylePreset? bestPreset = null;
            var bestPresetScore = 0;
            foreach (var preset in presets.Where(p => p.Enabled && catalog.Find(p.DesignSystemId) != null))
            {
                var haystack = (preset.Name + " " + preset.Description).ToLowerInvariant();
                var score = bigrams.Count(bigram => haystack.Contains(bigram, StringComparison.Ordinal))
                    + 2 * words.Count(word => preset.DesignSystemId.Contains(word, StringComparison.Ordinal));
                if (score > bestPresetScore)
                {
                    bestPresetScore = score;
                    bestPreset = preset;
                }
            }
            if (bestPreset != null)
                return new PersonalStyleBaseChoice(bestPreset.DesignSystemId, $"按你的描述匹配到预设「{bestPreset.Name}」的骨架");
            foreach (var word in words)
            {
                var entry = catalog.All.FirstOrDefault(e => e.Id.Contains(word, StringComparison.Ordinal)
                    || e.Name.Contains(word, StringComparison.OrdinalIgnoreCase));
                if (entry != null)
                    return new PersonalStyleBaseChoice(entry.Id, $"按你的描述里的「{word}」匹配到设计系统「{entry.Name}」");
            }
        }

        return new PersonalStyleBaseChoice(defaultDesignSystemId, "没有可比的配色或描述，先用默认风格的骨架");
    }

    // ───────────────────────── 解析 ─────────────────────────

    internal static List<CssRule> ParseRules(string css)
    {
        var withoutComments = CommentPattern.Replace(css, " ");
        var rules = new List<CssRule>();
        foreach (Match match in RulePattern.Matches(withoutComments))
        {
            var selector = match.Groups["sel"].Value.Trim();
            // @media 等条件块里的内层规则由正则直接命中（它只匹配最内层花括号）；@font-face / @keyframes 帧不算页面样式。
            if (selector.StartsWith('@') || Regex.IsMatch(selector, @"^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$", RegexOptions.IgnoreCase)) continue;
            var declarations = ParseDeclarations(match.Groups["body"].Value);
            if (declarations.Count > 0) rules.Add(new CssRule(selector, declarations));
        }
        return rules;
    }

    internal static List<KeyValuePair<string, string>> ParseDeclarations(string body)
    {
        var result = new List<KeyValuePair<string, string>>();
        foreach (var raw in body.Split(';'))
        {
            var colon = raw.IndexOf(':');
            if (colon <= 0) continue;
            var property = raw[..colon].Trim().ToLowerInvariant();
            var value = raw[(colon + 1)..].Replace("!important", string.Empty, StringComparison.OrdinalIgnoreCase).Trim();
            if (property.Length == 0 || value.Length == 0) continue;
            result.Add(new KeyValuePair<string, string>(property, value));
        }
        return result;
    }

    private static Dictionary<string, string> CollectVariables(IEnumerable<CssRule> rules)
    {
        var vars = new Dictionary<string, string>(StringComparer.Ordinal);
        var fromRoot = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rule in rules)
        {
            var isRoot = IsRootSelector(rule.Selector);
            foreach (var (property, value) in rule.Declarations)
            {
                if (!property.StartsWith("--", StringComparison.Ordinal)) continue;
                // :root / html / body 上的定义优先；主题切换等其它选择器上的重定义不覆盖它。
                if (isRoot)
                {
                    if (fromRoot.Add(property)) vars[property] = value;
                }
                else if (!vars.ContainsKey(property)) vars[property] = value;
            }
        }
        return vars;
    }

    private static string ResolveVars(string value, IReadOnlyDictionary<string, string> vars, int depth)
    {
        if (depth > 5 || !value.Contains("var(", StringComparison.Ordinal)) return value;
        var replaced = VarPattern.Replace(value, match =>
        {
            var name = match.Groups["name"].Value;
            if (vars.TryGetValue(name, out var found)) return found;
            return match.Groups["fallback"].Success ? match.Groups["fallback"].Value.Trim() : string.Empty;
        });
        return replaced == value ? value : ResolveVars(replaced, vars, depth + 1);
    }

    private static bool IsRootSelector(string selector)
        => selector.Split(',').Select(s => s.Trim().ToLowerInvariant()).Any(s => s is ":root" or "html" or "body" or "html body");

    private static bool SelectorHasBody(string selector)
        => selector.Split(',').Select(s => s.Trim().ToLowerInvariant()).Any(s => s is "html" or "body" or "html body" or ":root");

    // ───────────────────────── 配色 ─────────────────────────

    private sealed record Palette(string? Paper, string? Ink, string? Accent, List<string> Others);

    private static Palette ExtractPalette(IReadOnlyList<CssRule> rules, IReadOnlyDictionary<string, string> vars)
    {
        var frequency = new Dictionary<string, int>(StringComparer.Ordinal);
        var backgroundFrequency = new Dictionary<string, int>(StringComparer.Ordinal);
        var textFrequency = new Dictionary<string, int>(StringComparer.Ordinal);
        string? bodyPaper = null;
        string? bodyInk = null;
        foreach (var rule in rules)
        {
            var isBody = SelectorHasBody(rule.Selector);
            foreach (var (property, value) in rule.Declarations)
            {
                var isBackground = property is "background" or "background-color";
                var isText = property == "color";
                var isBorder = property.StartsWith("border", StringComparison.Ordinal) || property.StartsWith("outline", StringComparison.Ordinal)
                    || property is "fill" or "stroke" or "text-decoration-color" or "accent-color" or "caret-color";
                if (!isBackground && !isText && !isBorder) continue;
                foreach (var color in ColorsIn(value))
                {
                    Increment(frequency, color);
                    if (isBackground) Increment(backgroundFrequency, color);
                    if (isText) Increment(textFrequency, color);
                    if (isBody && isBackground) bodyPaper ??= color;
                    if (isBody && isText) bodyInk ??= color;
                }
            }
        }

        var paper = bodyPaper ?? FirstVarColor(vars, PaperVarNames) ?? MostFrequent(backgroundFrequency);
        var ink = bodyInk ?? FirstVarColor(vars, InkVarNames) ?? MostFrequent(textFrequency);
        var accent = FirstVarColor(vars, AccentVarNames);
        if (accent == null)
        {
            accent = frequency
                .Where(kv => IsVivid(kv.Key)
                    && (paper == null || Distance(Parse(kv.Key), Parse(paper)) > 40)
                    && (ink == null || Distance(Parse(kv.Key), Parse(ink)) > 40))
                .OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal)
                .Select(kv => kv.Key)
                .FirstOrDefault();
        }
        var chosen = new[] { paper, ink, accent }.Where(c => c != null).Select(c => c!).ToList();
        var others = new List<string>();
        foreach (var color in frequency.Where(kv => kv.Value > 0).OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => kv.Key))
        {
            if (others.Count >= 3) break;
            if (chosen.Concat(others).Any(existing => Distance(Parse(existing), Parse(color)) < 24)) continue;
            others.Add(color);
        }
        return new Palette(paper, ink, accent, others);
    }

    private static string? FirstVarColor(IReadOnlyDictionary<string, string> vars, IEnumerable<string> names)
    {
        foreach (var name in names)
        {
            if (!vars.TryGetValue(name, out var value)) continue;
            var resolved = ResolveVars(value, vars, 0);
            var color = ColorsIn(resolved).FirstOrDefault();
            if (color != null) return color;
        }
        return null;
    }

    /// <summary>值里出现的颜色，统一成 #rrggbb 小写；几乎透明（alpha &lt; 0.35）的遮罩色不算。</summary>
    internal static IEnumerable<string> ColorsIn(string value)
    {
        var found = new List<(int Index, string Hex)>();
        foreach (Match m in HexPattern.Matches(value))
            if (TryParseColor(m.Value, out var rgb, out var alpha) && alpha >= 0.35) found.Add((m.Index, ToHex(rgb)));
        foreach (Match m in RgbPattern.Matches(value))
            if (TryParseColor(m.Value, out var rgb, out var alpha) && alpha >= 0.35) found.Add((m.Index, ToHex(rgb)));
        foreach (Match m in HslPattern.Matches(value))
            if (TryParseColor(m.Value, out var rgb, out var alpha) && alpha >= 0.35) found.Add((m.Index, ToHex(rgb)));
        foreach (Match m in NamedColorPattern.Matches(value))
            found.Add((m.Index, m.Groups["n"].Value.Equals("white", StringComparison.OrdinalIgnoreCase) ? "#ffffff" : "#000000"));
        return found.OrderBy(x => x.Index).Select(x => x.Hex);
    }

    private static bool TryParseColor(string text, out (double R, double G, double B) rgb)
        => TryParseColor(text, out rgb, out _);

    internal static bool TryParseColor(string text, out (double R, double G, double B) rgb, out double alpha)
    {
        rgb = (0, 0, 0);
        alpha = 1;
        var value = text.Trim();
        var hex = HexPattern.Match(value);
        if (hex.Success && hex.Index == 0 && hex.Length == value.Length)
        {
            var h = hex.Groups["h"].Value;
            if (h.Length is 3 or 4) h = string.Concat(h.Select(c => new string(c, 2)));
            rgb = (Convert.ToInt32(h[..2], 16), Convert.ToInt32(h[2..4], 16), Convert.ToInt32(h[4..6], 16));
            if (h.Length == 8) alpha = Convert.ToInt32(h[6..8], 16) / 255.0;
            return true;
        }
        var rgbMatch = RgbPattern.Match(value);
        if (rgbMatch.Success)
        {
            rgb = (Channel(rgbMatch.Groups["r"].Value), Channel(rgbMatch.Groups["g"].Value), Channel(rgbMatch.Groups["b"].Value));
            if (rgbMatch.Groups["a"].Success) alpha = AlphaOf(rgbMatch.Groups["a"].Value);
            return true;
        }
        var hsl = HslPattern.Match(value);
        if (hsl.Success)
        {
            rgb = HslToRgb(Number(hsl.Groups["h"].Value), Number(hsl.Groups["s"].Value) / 100, Number(hsl.Groups["l"].Value) / 100);
            if (hsl.Groups["a"].Success) alpha = AlphaOf(hsl.Groups["a"].Value);
            return true;
        }
        if (value.Equals("white", StringComparison.OrdinalIgnoreCase)) { rgb = (255, 255, 255); return true; }
        if (value.Equals("black", StringComparison.OrdinalIgnoreCase)) { rgb = (0, 0, 0); return true; }
        return false;
    }

    private static double Channel(string raw)
        => raw.EndsWith('%') ? Math.Clamp(Number(raw[..^1]) * 2.55, 0, 255) : Math.Clamp(Number(raw), 0, 255);

    private static double AlphaOf(string raw)
        => raw.EndsWith('%') ? Math.Clamp(Number(raw[..^1]) / 100, 0, 1) : Math.Clamp(Number(raw), 0, 1);

    private static double Number(string raw)
        => double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : 0;

    private static (double R, double G, double B) HslToRgb(double h, double s, double l)
    {
        h = ((h % 360) + 360) % 360 / 360;
        if (s <= 0) return (l * 255, l * 255, l * 255);
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        double Hue(double t)
        {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1.0 / 6) return p + (q - p) * 6 * t;
            if (t < 0.5) return q;
            if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
            return p;
        }
        return (Hue(h + 1.0 / 3) * 255, Hue(h) * 255, Hue(h - 1.0 / 3) * 255);
    }

    private static string ToHex((double R, double G, double B) rgb)
        => $"#{(int)Math.Round(rgb.R):x2}{(int)Math.Round(rgb.G):x2}{(int)Math.Round(rgb.B):x2}";

    private static (double R, double G, double B) Parse(string hex)
        => TryParseColor(hex, out var rgb) ? rgb : (0, 0, 0);

    private static double Distance((double R, double G, double B) a, (double R, double G, double B) b)
        => Math.Sqrt(Math.Pow(a.R - b.R, 2) + Math.Pow(a.G - b.G, 2) + Math.Pow(a.B - b.B, 2));

    internal static double Luminance(string hex)
    {
        var (r, g, b) = Parse(hex);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }

    private static bool IsVivid(string hex)
    {
        var (r, g, b) = Parse(hex);
        var max = Math.Max(r, Math.Max(g, b)) / 255;
        var min = Math.Min(r, Math.Min(g, b)) / 255;
        var lightness = (max + min) / 2;
        if (lightness < 0.12 || lightness > 0.9 || max - min < 0.001) return false;
        var saturation = (max - min) / (1 - Math.Abs(2 * lightness - 1));
        return saturation >= 0.3;
    }

    // ───────────────────────── 字体 ─────────────────────────

    private sealed record FontPick(string? Heading, string? Body);

    private static FontPick ExtractFonts(string html, IReadOnlyList<CssRule> rules)
    {
        string? body = null;
        string? heading = null;
        var frequency = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var rule in rules)
        {
            foreach (var (property, value) in rule.Declarations)
            {
                var family = property switch
                {
                    "font-family" => FirstFamily(value),
                    "font" => FirstFamily(ShorthandFamily(value)),
                    _ => null,
                };
                if (family == null) continue;
                Increment(frequency, family);
                if (SelectorHasBody(rule.Selector)) body ??= family;
                if (HeadingSelectorPattern.IsMatch(rule.Selector)) heading ??= family;
            }
        }
        // Google Fonts 的链接直接写着族名：页面样式里没写全（或写在变量里没读到）时它是最可靠的来源。
        var linked = new List<string>();
        foreach (Match tag in LinkTagPattern.Matches(html))
        {
            var href = HrefPattern.Match(tag.Value) is { Success: true } m ? m.Groups["v"].Value : string.Empty;
            if (!href.Contains("fonts.googleapis.com", StringComparison.OrdinalIgnoreCase)) continue;
            foreach (Match family in GoogleFamilyPattern.Matches(System.Net.WebUtility.HtmlDecode(href)))
            {
                var name = Uri.UnescapeDataString(family.Groups["f"].Value.Replace('+', ' ')).Trim();
                if (name.Length > 0 && !linked.Contains(name, StringComparer.OrdinalIgnoreCase)) linked.Add(name);
            }
        }
        var mostFrequent = frequency.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => kv.Key).FirstOrDefault();
        body ??= mostFrequent ?? linked.FirstOrDefault();
        heading ??= linked.FirstOrDefault(name => !string.Equals(name, body, StringComparison.OrdinalIgnoreCase) && frequency.ContainsKey(name))
            ?? body;
        return new FontPick(heading, body);
    }

    private static string ShorthandFamily(string value)
    {
        // font: italic 700 16px/1.5 "Inter", sans-serif —— 字号之后的部分才是族名
        var match = Regex.Match(value, @"\d+(?:\.\d+)?(?:px|rem|em|%|pt)(?:\s*/\s*[^\s]+)?\s+(?<f>.+)$", RegexOptions.CultureInvariant);
        return match.Success ? match.Groups["f"].Value : string.Empty;
    }

    private static string? FirstFamily(string value)
    {
        var families = value.Split(',')
            .Select(f => f.Trim().Trim('"', '\'').Trim())
            .Where(f => f.Length > 0 && f.Length <= 60 && !f.Contains('(', StringComparison.Ordinal))
            .ToList();
        var named = families.FirstOrDefault(f => !GenericFamilies.Contains(f));
        if (named != null) return named;
        var generic = families.FirstOrDefault()?.ToLowerInvariant();
        return generic switch
        {
            "serif" or "ui-serif" => "衬线系统字体",
            "monospace" or "ui-monospace" => "等宽系统字体",
            "sans-serif" or "system-ui" or "ui-sans-serif" or "-apple-system" or "blinkmacsystemfont" => "无衬线系统字体",
            _ => null,
        };
    }

    // ───────────────────────── 字号 / 间距 / 版式 ─────────────────────────

    private static string? ExtractFontSizes(IReadOnlyList<CssRule> rules)
    {
        var headings = new SortedDictionary<int, int>();
        int? body = null;
        var all = new Dictionary<int, int>();
        foreach (var rule in rules)
        {
            foreach (var (property, value) in rule.Declarations)
            {
                if (property != "font-size") continue;
                var px = SizeOf(value);
                if (px is not (>= 10 and <= 160)) continue;
                Increment(all, px.Value);
                if (HeadingSelectorPattern.IsMatch(rule.Selector)) headings[px.Value] = 1;
                if (SelectorHasBody(rule.Selector) || rule.Selector.Trim().Equals("p", StringComparison.OrdinalIgnoreCase)) body ??= px;
            }
        }
        if (all.Count == 0) return null;
        body ??= all.Where(kv => kv.Key is >= 13 and <= 20).OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key).Select(kv => (int?)kv.Key).FirstOrDefault();
        var titleSizes = (headings.Count > 0 ? headings.Keys.AsEnumerable() : all.Keys.Where(size => body == null || size > body + 2))
            .OrderByDescending(size => size)
            .Take(3)
            .ToList();
        var parts = new List<string>();
        if (titleSizes.Count > 0) parts.Add($"标题约 {string.Join(" / ", titleSizes.Select(s => $"{s}px"))}");
        if (body != null) parts.Add($"正文约 {body}px");
        return parts.Count == 0 ? null : string.Join("，", parts);
    }

    private static int? SizeOf(string value)
    {
        var matches = LengthPattern.Matches(value);
        if (matches.Count == 0) return null;
        // clamp(min, preferred, max) 取上限：那是大屏上用户实际看到的字号。
        var match = value.Contains("clamp(", StringComparison.OrdinalIgnoreCase) ? matches[^1] : matches[0];
        var number = Number(match.Groups["n"].Value);
        var px = match.Groups["u"].Value.Equals("px", StringComparison.OrdinalIgnoreCase) ? number : number * 16;
        return (int)Math.Round(px);
    }

    private static List<string> ExtractShape(IReadOnlyList<CssRule> rules)
    {
        var spacing = new Dictionary<int, int>();
        var radius = new Dictionary<int, int>();
        var shadows = 0;
        var pill = 0;
        foreach (var rule in rules)
        {
            foreach (var (property, value) in rule.Declarations)
            {
                if (property.StartsWith("padding", StringComparison.Ordinal) || property.StartsWith("margin", StringComparison.Ordinal)
                    || property is "gap" or "row-gap" or "column-gap")
                {
                    foreach (Match m in LengthPattern.Matches(value))
                    {
                        var px = LengthPx(m);
                        if (px is >= 4 and <= 160) Increment(spacing, px);
                    }
                }
                else if (property == "border-radius")
                {
                    if (value.Contains('%', StringComparison.Ordinal)) { pill++; continue; }
                    var first = LengthPattern.Match(value);
                    if (!first.Success) continue;
                    var px = LengthPx(first);
                    if (px >= 99) pill++;
                    else if (px >= 0) Increment(radius, px);
                }
                else if (property == "box-shadow" && !value.Trim().Equals("none", StringComparison.OrdinalIgnoreCase))
                {
                    shadows++;
                }
            }
        }
        var result = new List<string>();
        var topSpacing = spacing.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key).Take(3).Select(kv => kv.Key).OrderBy(v => v).ToList();
        if (topSpacing.Count > 0) result.Add($"常用间距 {string.Join("、", topSpacing.Select(v => $"{v}px"))}");
        var sectionGap = spacing.Where(kv => kv.Key >= 48 && kv.Value >= 2).OrderByDescending(kv => kv.Value).ThenByDescending(kv => kv.Key).Select(kv => (int?)kv.Key).FirstOrDefault();
        if (sectionGap != null && !topSpacing.Contains(sectionGap.Value)) result.Add($"区块之间留白约 {sectionGap}px");
        if (radius.Count > 0)
        {
            var mode = radius.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key).First().Key;
            result.Add(mode == 0 ? "直角，不用圆角" : $"圆角约 {mode}px");
        }
        if (pill >= 2) result.Add("按钮或标签用胶囊形");
        if (shadows >= 3) result.Add("卡片带投影");
        else if (shadows == 0 && rules.Count >= 10) result.Add("几乎不用投影");
        return result;
    }

    private static int LengthPx(Match match)
    {
        var number = Number(match.Groups["n"].Value);
        var unit = match.Groups["u"].Value.ToLowerInvariant();
        return (int)Math.Round(unit == "px" ? number : number * 16);
    }

    private static List<string> ExtractLayout(IReadOnlyList<CssRule> rules)
    {
        var maxWidths = new Dictionary<int, int>();
        var grid = 0;
        var flex = 0;
        var columns = new Dictionary<int, int>();
        var uppercase = 0;
        foreach (var rule in rules)
        {
            foreach (var (property, value) in rule.Declarations)
            {
                var lower = value.ToLowerInvariant();
                if (property == "max-width")
                {
                    var m = LengthPattern.Match(value);
                    if (m.Success)
                    {
                        var px = LengthPx(m);
                        if (px is >= 560 and <= 1800) Increment(maxWidths, px);
                    }
                }
                else if (property == "display")
                {
                    if (lower.Contains("grid", StringComparison.Ordinal)) grid++;
                    else if (lower.Contains("flex", StringComparison.Ordinal)) flex++;
                }
                else if (property == "grid-template-columns")
                {
                    var repeat = RepeatColumnsPattern.Match(lower);
                    var count = repeat.Success
                        ? (int)Number(repeat.Groups["n"].Value)
                        : lower.Contains("auto-", StringComparison.Ordinal) ? 0 : lower.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
                    if (count is >= 2 and <= 6) Increment(columns, count);
                }
                else if (property == "text-transform" && lower.Contains("uppercase", StringComparison.Ordinal))
                {
                    uppercase++;
                }
            }
        }
        var result = new List<string>();
        if (maxWidths.Count > 0)
        {
            var width = maxWidths.OrderByDescending(kv => kv.Value).ThenByDescending(kv => kv.Key).First().Key;
            result.Add($"内容区最大宽度约 {width}px 居中");
        }
        if (grid > 0 && grid >= flex / 2)
        {
            var column = columns.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key).Select(kv => (int?)kv.Key).FirstOrDefault();
            result.Add(column != null ? $"多用网格排版，常见 {column} 列" : "多用网格排版");
        }
        else if (flex >= 3)
        {
            result.Add("以横排弹性布局为主");
        }
        if (uppercase >= 2) result.Add("小标题用大写字母");
        return result;
    }

    // ───────────────────────── 工具 ─────────────────────────

    private static void Increment<TKey>(Dictionary<TKey, int> map, TKey key) where TKey : notnull
        => map[key] = map.TryGetValue(key, out var n) ? n + 1 : 1;

    private static string? MostFrequent(Dictionary<string, int> map)
        => map.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => kv.Key).FirstOrDefault();

    private static List<string> CjkBigrams(string text)
    {
        var result = new List<string>();
        foreach (Match run in CjkBigramSource.Matches(text))
        {
            var value = run.Value;
            for (var i = 0; i + 1 < value.Length; i++)
            {
                var bigram = value.Substring(i, 2);
                if (!result.Contains(bigram)) result.Add(bigram);
            }
        }
        return result;
    }

    private static string NormalizeRelative(string baseDir, string relative)
    {
        var segments = new List<string>();
        foreach (var part in (baseDir.Length > 0 ? baseDir + "/" + relative : relative).Split('/'))
        {
            if (part.Length == 0 || part == ".") continue;
            if (part == "..")
            {
                if (segments.Count == 0) return string.Empty;
                segments.RemoveAt(segments.Count - 1);
                continue;
            }
            segments.Add(part);
        }
        var builder = new StringBuilder();
        foreach (var segment in segments)
        {
            if (builder.Length > 0) builder.Append('/');
            builder.Append(segment);
        }
        return builder.ToString();
    }
}
