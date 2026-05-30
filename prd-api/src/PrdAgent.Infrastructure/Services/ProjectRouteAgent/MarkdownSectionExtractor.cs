using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.ProjectRouteAgent;

/// <summary>
/// 确定性 Markdown 章节抽取器：从方案 md 文档里找指定关键词章节，
/// 把章节下的列表项 / 段落原话直接抽出来（不让 AI 自由发挥 / 拆解）。
///
/// 工作流：
///   1. 找标题行（^#+\s+xxx$），命中关键词（contains）即为目标 section
///   2. 从该标题行下方开始收集，直到遇到下一个同级或更高级标题
///   3. 收集规则：
///      - 列表项 `- foo` / `* foo` / `+ foo` / `1. foo` → "foo"
///      - 纯文本段落 → 按行拆分（跳过空行 / 引用前缀）
///   4. 文本归一化：去前后空格、去 inline code 反引号、去末尾标点
///   5. 去重（保持原顺序）
///
/// 关键词命中是大小写不敏感的子串匹配，按列表顺序优先（先列的标题如果同时命中以它为准）。
/// </summary>
public static class MarkdownSectionExtractor
{
    /// <summary>「应用」章节关键词（按优先级从精确到宽泛）</summary>
    public static readonly IReadOnlyList<string> AppsKeywords = new[]
    {
        "涉及应用", "相关应用", "应用范围", "应用清单", "应用列表", "应用",
    };

    /// <summary>「业务模块」章节关键词</summary>
    public static readonly IReadOnlyList<string> ModulesKeywords = new[]
    {
        "业务模块", "涉及模块", "相关模块", "功能模块", "模块清单", "模块列表", "业务模板", "模块",
    };

    /// <summary>「文档头」节点关键词（用于「文档头模式」识别）</summary>
    public static readonly IReadOnlyList<string> DocHeaderKeywords = new[]
    {
        "文档头", "文档信息", "文档说明", "基本信息", "基础信息", "需求信息", "header", "meta",
    };

    /// <summary>
    /// 从方案 markdown 抽出（apps, modules）原文清单。
    /// 找不到对应章节时返回的列表为空，调用方可决定是否回退到 LLM 抽取。
    ///
    /// <paramref name="maxScanChars"/>：扫描范围上限（字符数），默认 6000，约 100~150 行 markdown。
    ///   规则：**只扫文档前 maxScanChars 字符**，相当于「方案文档头部」。
    ///   超过该位置的章节即使命中关键词也不会被抽取（避免抓到正文中部 / 末尾的同名章节）。
    ///
    /// 提取优先级（按命中即返回的顺序）：
    ///   1. **文档头模式**：找形如 `# 一、文档头` 这种节点，扫描其下 list item 里的
    ///      `- 应用：xxx` / `- 业务模块：xxx` / `- 应用/业务模块：a/b` 行级 KV
    ///   2. **独立章节模式**：找 `## 应用` / `## 业务模块` 独立标题节点
    ///   3. 两个都没命中 → 返回空列表（让调用方决定 LLM 兜底）
    /// </summary>
    public static (List<string> Apps, List<string> Modules) Extract(string? markdown, int maxScanChars = 6000)
    {
        if (string.IsNullOrWhiteSpace(markdown))
            return (new List<string>(), new List<string>());

        // 截到文档头（按字符上限，不破坏行边界 —— 在最后一个换行处切）
        var head = markdown!;
        if (head.Length > maxScanChars)
        {
            var cut = head.LastIndexOf('\n', maxScanChars);
            if (cut < maxScanChars / 2) cut = maxScanChars;
            head = head[..cut];
        }

        // 1) 优先「文档头模式」：在「一、文档头」之类节点下抓行级 KV
        var (hApps, hModules) = TryExtractFromDocHeader(head);
        if (hApps.Count > 0 || hModules.Count > 0)
        {
            return (hApps, hModules);
        }

        // 2) 回退到独立章节模式
        var apps = ExtractSection(head, AppsKeywords);
        var modules = ExtractSection(head, ModulesKeywords);
        return (apps, modules);
    }

    /// <summary>
    /// 「文档头模式」：从「文档头 / 文档信息 / 基础信息」这类节点下扫描 list item 的行级 KV，
    /// 把 `应用：` / `业务模块：` / `应用/业务模块：` 三种形态拍平成 (apps, modules)。
    ///
    /// 行级匹配规则：
    ///   - `- 应用：智能营销`                    → apps=["智能营销"]
    ///   - `- 业务模块：营销后台`                → modules=["营销后台"]
    ///   - `- 应用/业务模块：智能营销/营销后台`  → apps=["智能营销"], modules=["营销后台"]
    ///   - `- **应用/业务模块**：a / b`          → 同上（容忍加粗、空格、半/全角斜杠）
    ///
    /// 合并 label 的对位拆分：
    ///   label `应用/业务模块` 按 `/` 拆成 N=2 段 → value 也按 `/` 拆 N 段（一一对位）
    ///   value 段数 < label：剩余字段空；段数 > label：多出的归并到最后一段
    ///   value 不含 `/` 时退化用 `、` `，` `,` 拆
    /// </summary>
    public static (List<string> Apps, List<string> Modules) TryExtractFromDocHeader(string head)
    {
        var lines = head.Split('\n');
        var apps = new List<string>();
        var modules = new List<string>();
        var seenApps = new HashSet<string>(StringComparer.Ordinal);
        var seenModules = new HashSet<string>(StringComparer.Ordinal);

        int? sectionStart = null;
        int sectionLevel = 0;

        // 找到「文档头」节点的标题行
        for (var i = 0; i < lines.Length; i++)
        {
            var headerMatch = HeadingRegex.Match(lines[i]);
            if (!headerMatch.Success) continue;
            var level = headerMatch.Groups[1].Value.Length;
            var title = StripHeadingDecoration(headerMatch.Groups[2].Value.Trim());
            // 标题里可能有编号前缀：「一、文档头」「1. 文档头」「1.1 基础信息」 —— 都接受
            var normalizedTitle = StripChineseOrdinalPrefix(title);
            if (MatchesAnyKeyword(normalizedTitle, DocHeaderKeywords))
            {
                sectionStart = i + 1;
                sectionLevel = level;
                break;
            }
        }

        if (sectionStart == null) return (apps, modules);

        // 在节点内扫描 list item 行
        for (var i = sectionStart.Value; i < lines.Length; i++)
        {
            var headerMatch = HeadingRegex.Match(lines[i]);
            if (headerMatch.Success)
            {
                var level = headerMatch.Groups[1].Value.Length;
                if (level <= sectionLevel) break;
                continue;
            }

            var raw = lines[i].TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(raw)) continue;

            // 取列表项内容；非列表行也允许（兼容「应用：xxx」单行格式）
            string inner;
            var lm = ListItemRegex.Match(raw);
            if (lm.Success) inner = lm.Groups[1].Value;
            else inner = raw.Trim();

            if (!TrySplitInlineKv(inner, out var key, out var value)) continue;
            key = NormalizeKey(key);
            value = value.Trim();
            if (value.Length == 0) continue;

            // 判别 key 是哪一类
            var hasApp = key.Contains("应用");
            var hasModule = key.Contains("模块") || key.Contains("模板");

            if (hasApp && hasModule)
            {
                // 合并 label：按 `/` 对位拆
                var labelParts = SplitOnSlash(key);
                var valueParts = SplitOnSlash(value);
                if (valueParts.Count <= 1)
                {
                    // value 没用 `/` —— 退化用顿号 / 逗号拆
                    valueParts = SplitOnChineseSeps(value);
                }
                AssignParts(labelParts, valueParts, apps, seenApps, modules, seenModules);
            }
            else if (hasApp)
            {
                foreach (var v in SplitMulti(value))
                    AddIfNew(v, apps, seenApps);
            }
            else if (hasModule)
            {
                foreach (var v in SplitMulti(value))
                    AddIfNew(v, modules, seenModules);
            }
        }

        return (apps, modules);
    }

    /// <summary>
    /// 把 `应用/业务模块` 与 `智能营销/营销后台` 一一对位塞回 apps / modules。
    /// labelParts 数量 = 拆出的字段数（通常 2），按顺序判定每段属于 apps 还是 modules。
    /// valueParts 不足补空；超额追加到最后一个匹配字段。
    /// </summary>
    private static void AssignParts(
        List<string> labelParts,
        List<string> valueParts,
        List<string> apps, HashSet<string> seenApps,
        List<string> modules, HashSet<string> seenModules)
    {
        var n = labelParts.Count;
        for (var i = 0; i < n; i++)
        {
            if (i >= valueParts.Count) break;
            var labelPart = labelParts[i];
            var isApp = labelPart.Contains("应用");
            var isMod = labelPart.Contains("模块") || labelPart.Contains("模板");
            if (!isApp && !isMod) continue;

            // 当前段
            var v = Cleanup(valueParts[i]);
            if (v.Length > 0)
            {
                if (isApp) AddIfNew(v, apps, seenApps);
                else AddIfNew(v, modules, seenModules);
            }

            // 最后一个 label 段时，把多余的 value 段都追加给它
            if (i == n - 1)
            {
                for (var j = i + 1; j < valueParts.Count; j++)
                {
                    var ex = Cleanup(valueParts[j]);
                    if (ex.Length == 0) continue;
                    if (isApp) AddIfNew(ex, apps, seenApps);
                    else AddIfNew(ex, modules, seenModules);
                }
            }
        }
    }

    private static void AddIfNew(string v, List<string> list, HashSet<string> seen)
    {
        var cleaned = Cleanup(v);
        if (cleaned.Length == 0) return;
        if (seen.Add(cleaned)) list.Add(cleaned);
    }

    /// <summary>把 `key: value` 拆成两段。半/全角冒号都接受。第一个冒号为分界。</summary>
    private static bool TrySplitInlineKv(string line, out string key, out string value)
    {
        key = string.Empty;
        value = string.Empty;
        if (string.IsNullOrEmpty(line)) return false;
        var idx = -1;
        for (var i = 0; i < line.Length; i++)
        {
            if (line[i] == '：' || line[i] == ':') { idx = i; break; }
        }
        if (idx <= 0) return false;
        key = line[..idx].Trim();
        value = line[(idx + 1)..].Trim();
        // 去 key 两端可能的 markdown 加粗 / 斜体修饰
        key = key.Trim('*', '_', '`', ' ', '\t');
        return key.Length > 0;
    }

    private static string NormalizeKey(string key)
    {
        // 全角斜杠 / 反斜杠 / 中点 → `/`；统一去空格
        var sb = new System.Text.StringBuilder(key.Length);
        foreach (var ch in key)
        {
            if (ch == '／' || ch == '\\') sb.Append('/');
            else if (ch == ' ' || ch == '\t' || ch == '　') { /* skip */ }
            else sb.Append(ch);
        }
        return sb.ToString();
    }

    private static List<string> SplitOnSlash(string s)
    {
        var parts = new List<string>();
        var raw = s.Split(new[] { '/', '／' }, StringSplitOptions.None);
        foreach (var p in raw)
        {
            var t = p.Trim();
            if (t.Length > 0) parts.Add(t);
        }
        return parts;
    }

    private static List<string> SplitOnChineseSeps(string s)
    {
        var parts = new List<string>();
        var raw = s.Split(new[] { '、', ',', '，', ';', '；' }, StringSplitOptions.None);
        foreach (var p in raw)
        {
            var t = p.Trim();
            if (t.Length > 0) parts.Add(t);
        }
        return parts;
    }

    /// <summary>把值按常见分隔符拆出多项（用于纯 `应用：a、b、c` 这种行）。</summary>
    private static List<string> SplitMulti(string s)
    {
        var parts = new List<string>();
        var raw = s.Split(new[] { '、', ',', '，', '/', '／', ';', '；', '+', '&' }, StringSplitOptions.None);
        foreach (var p in raw)
        {
            var t = p.Trim();
            if (t.Length > 0) parts.Add(t);
        }
        return parts.Count > 0 ? parts : new List<string> { s.Trim() };
    }

    /// <summary>去标题前的中文序号 / 阿拉伯序号前缀：「一、」「1. 」「1.1 」「（一）」 等。</summary>
    private static string StripChineseOrdinalPrefix(string title)
    {
        return OrdinalPrefixRegex.Replace(title, string.Empty).Trim();
    }

    /// <summary>对外暴露：根据关键词清单抽一个 section 的原话列表。</summary>
    public static List<string> ExtractSection(string markdown, IReadOnlyList<string> keywords)
    {
        var lines = markdown.Split('\n');
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        int? sectionStart = null;
        int sectionLevel = 0;

        // 1) 找命中关键词的最浅 / 最早标题
        for (var i = 0; i < lines.Length; i++)
        {
            var headerMatch = HeadingRegex.Match(lines[i]);
            if (!headerMatch.Success) continue;
            var level = headerMatch.Groups[1].Value.Length;
            var title = headerMatch.Groups[2].Value.Trim();
            // 去掉行尾的 markdown 锚点 / 链接修饰
            title = StripHeadingDecoration(title);

            if (MatchesAnyKeyword(title, keywords))
            {
                sectionStart = i + 1;
                sectionLevel = level;
                break; // 用第一次命中
            }
        }

        if (sectionStart == null) return result;

        // 2) 收集到下一个同级或更高级标题之前
        for (var i = sectionStart.Value; i < lines.Length; i++)
        {
            var headerMatch = HeadingRegex.Match(lines[i]);
            if (headerMatch.Success)
            {
                var level = headerMatch.Groups[1].Value.Length;
                if (level <= sectionLevel) break;
                // 子标题（更深层）不视为分隔符，但本身也跳过不当作内容
                continue;
            }

            var raw = lines[i].TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(raw)) continue;

            // 跳过引用块 / 水平线 / 代码块边界
            if (raw.TrimStart().StartsWith(">")) continue;
            if (raw.Trim() == "---" || raw.Trim() == "***" || raw.Trim() == "___") continue;
            if (raw.TrimStart().StartsWith("```")) continue;

            // 列表项
            var listMatch = ListItemRegex.Match(raw);
            string item;
            if (listMatch.Success)
            {
                item = listMatch.Groups[1].Value;
            }
            else
            {
                // 纯文本段落 —— 按行收（不二次拆分，方案 md 里这种情况罕见）
                item = raw.Trim();
            }

            item = Cleanup(item);
            if (item.Length == 0) continue;
            if (seen.Add(item)) result.Add(item);
        }

        return result;
    }

    private static bool MatchesAnyKeyword(string title, IReadOnlyList<string> keywords)
    {
        foreach (var kw in keywords)
        {
            if (title.Contains(kw, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string StripHeadingDecoration(string title)
    {
        // 去尾巴的 `{#anchor}` 或 `[link]()` 附加
        title = AnchorTagRegex.Replace(title, string.Empty);
        title = title.Trim();
        // 中文标题里有时会有 `:` 后缀（"应用："），剥掉
        title = title.TrimEnd('：', ':', '|', '·');
        return title.Trim();
    }

    private static string Cleanup(string item)
    {
        // 去 inline code 反引号、首尾标点、最后括号备注内容（保留原文意图）
        item = item.Trim().Trim('`').Trim();
        // 去末尾标点（中英文都剥）
        item = item.TrimEnd('。', '，', ',', '.', ';', '；');
        return item.Trim();
    }

    // ^# / ## / ###... 直到 ###### + 空格 + 标题文本
    private static readonly Regex HeadingRegex = new(@"^(#{1,6})\s+(.+?)\s*$", RegexOptions.Compiled);

    // 匹配列表项：`- foo` / `* foo` / `+ foo` / `1. foo` / `1) foo`
    private static readonly Regex ListItemRegex = new(@"^\s*(?:[-*+]|\d+[\.\)])\s+(.+?)\s*$", RegexOptions.Compiled);

    // 匹配 markdown 标题里附加的 `{#anchor}` 锚点
    private static readonly Regex AnchorTagRegex = new(@"\s*\{#[^}]+\}\s*$", RegexOptions.Compiled);

    // 匹配标题里的中文 / 阿拉伯序号前缀：
    //   「一、文档头」「1. 文档头」「1.1 文档头」「1.1.1 文档头」「（一）文档头」「(1) 文档头」「Section 1：文档头」
    // 注：必须以这些前缀开头才剥，文中含数字不会误剥。
    private static readonly Regex OrdinalPrefixRegex = new(
        @"^(?:[一二三四五六七八九十百千]+[、.．]|\d+(?:[.．]\d+)*[\.．、\s]?|[（(][一二三四五六七八九十百千\d]+[）)][、.\s]?)\s*",
        RegexOptions.Compiled);
}
