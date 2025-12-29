using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services;

public static class GroupNameHeuristics
{
    private static readonly Regex[] NameLabelPatterns =
    {
        new(@"(?:^|\n)\s*(?:产品名称|项目名称|产品名|项目名)\s*[:：]\s*(.+?)\s*(?:$|\n)", RegexOptions.IgnoreCase | RegexOptions.Compiled),
        new(@"(?:^|\n)\s*(?:产品名称|项目名称|产品名|项目名)\s*[:：]\s*\*\*(.+?)\*\*\s*(?:$|\n)", RegexOptions.IgnoreCase | RegexOptions.Compiled)
    };

    private static readonly string[] GenericWords =
    {
        "产品需求文档", "需求文档", "产品文档", "文档", "版本历史", "更新记录"
    };

    public static string Suggest(string? fileName, string snippet, int maxLen = 20)
    {
        var s = (snippet ?? string.Empty).Trim();
        if (s.Length == 0)
        {
            var fromFile = SuggestFromFileName(fileName, maxLen);
            return string.IsNullOrWhiteSpace(fromFile) ? "未命名群组" : fromFile;
        }

        var candidates = new List<(string Text, int Bonus)>();

        // 仅看头部，避免长文本干扰/浪费
        var head = s.Length > 5000 ? s[..5000] : s;
        var lines = head.Split('\n').Take(40).Select(x => x.Trim()).ToList();

        // 1) 显式标签（产品名称/项目名称）
        foreach (var re in NameLabelPatterns)
        {
            var m = re.Match(head);
            if (m.Success)
            {
                candidates.Add((m.Groups[1].Value, 12)); // 显式字段最可信
            }
        }

        // 2) Markdown 标题（# / ## / ###）
        foreach (var line in lines)
        {
            if (line.StartsWith("#"))
            {
                var title = line.TrimStart('#').Trim();
                if (!string.IsNullOrWhiteSpace(title))
                {
                    candidates.Add((title, 4));
                }
            }
        }

        // 3) 常见“xxx 产品需求文档”样式：取前缀
        foreach (var line in lines.Take(10))
        {
            var idx = line.IndexOf("产品需求文档", StringComparison.OrdinalIgnoreCase);
            if (idx > 0)
            {
                candidates.Add((line[..idx].Trim(), 8));
            }
        }

        // 4) 文件名兜底
        var fromFileName = SuggestFromFileName(fileName, maxLen);
        if (!string.IsNullOrWhiteSpace(fromFileName))
        {
            candidates.Add((fromFileName, 2));
        }

        // 清洗 + 打分择优
        var best = candidates
            .Select(x => new { Text = Clean(x.Text, maxLen), Bonus = x.Bonus })
            .Where(x => IsUsable(x.Text))
            .Select(x => new { Text = x.Text, Score = Score(x.Text) + x.Bonus })
            .OrderByDescending(x => x.Score)
            .Select(x => x.Text)
            .FirstOrDefault();

        return string.IsNullOrWhiteSpace(best) ? "未命名群组" : best;
    }

    private static string? SuggestFromFileName(string? fileName, int maxLen)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return null;
        var baseName = System.IO.Path.GetFileNameWithoutExtension(fileName.Trim());
        if (string.IsNullOrWhiteSpace(baseName)) return null;

        // 去掉常见噪声：序号/版本/日期/分隔符
        var s = baseName
            .Replace("_", " ")
            .Replace("-", " ")
            .Replace(".", " ")
            .Trim();

        // 去掉纯数字序号
        if (Regex.IsMatch(s, @"^\d+$")) return null;

        // 去掉类似 v1.2 / 2025-12-29
        s = Regex.Replace(s, @"\b[vV]\d+(\.\d+)*\b", "", RegexOptions.Compiled);
        s = Regex.Replace(s, @"\b20\d{2}[-/\.]\d{1,2}([-/\.]\d{1,2})?\b", "", RegexOptions.Compiled);
        s = Regex.Replace(s, @"\s{2,}", " ", RegexOptions.Compiled).Trim();

        s = Clean(s, maxLen);
        return IsUsable(s) ? s : null;
    }

    private static string Clean(string raw, int maxLen)
    {
        var s = (raw ?? string.Empty).Trim();
        if (s.Length == 0) return "";

        // 去掉 Markdown 标题符号
        s = Regex.Replace(s, @"^#+\s*", "", RegexOptions.Compiled).Trim();

        // 去掉 Markdown 粗体、代码符号、引号
        s = s.Replace("**", "", StringComparison.Ordinal)
             .Trim()
             .Trim('`')
             .Trim('"', '“', '”', '\'', '‘', '’');

        // 去掉常见“章节序号”前缀：1. / 1.2 / 第1章 等
        s = Regex.Replace(s, @"^(?:第\s*\d+\s*[章节节]\s*)", "", RegexOptions.Compiled).Trim();
        s = Regex.Replace(s, @"^(?:\d+(?:\.\d+)*\s*[\.\-]?\s*)", "", RegexOptions.Compiled).Trim();

        // 去掉括号里的解释（优先保留主标题）
        var parenIdx = s.IndexOf('（');
        if (parenIdx > 0) s = s[..parenIdx].Trim();
        parenIdx = s.IndexOf('(');
        if (parenIdx > 0) s = s[..parenIdx].Trim();

        // 去掉“PRD/需求文档”等通用词（保留更具体的部分）
        foreach (var w in GenericWords)
        {
            s = s.Replace(w, "", StringComparison.OrdinalIgnoreCase).Trim();
        }

        // 去掉扩展名残留
        if (s.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
        {
            s = s[..^3].Trim();
        }

        s = Regex.Replace(s, @"\s{2,}", " ", RegexOptions.Compiled).Trim();
        if (s.Length > maxLen) s = s[..maxLen].Trim();
        return s;
    }

    private static bool IsUsable(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return false;
        if (s.Length < 2) return false;
        if (s.Length > 50) return false;

        // 明显不是“名字”的回答（追问/说明）
        var bad = new[]
        {
            "需要你提供", "请提供", "请告诉", "你想", "我可以", "方式A", "方式B", "目前只有片段", "不清楚", "无法", "不知道"
        };
        if (bad.Any(x => s.Contains(x, StringComparison.OrdinalIgnoreCase))) return false;
        if (s.Contains("http", StringComparison.OrdinalIgnoreCase)) return false;
        if (Regex.IsMatch(s, @"^[\d\W_]+$")) return false;

        return true;
    }

    private static int Score(string s)
    {
        var score = 0;
        // 长度适中加分
        if (s.Length is >= 4 and <= 12) score += 6;
        else if (s.Length is >= 2 and <= 20) score += 3;

        // 含中文/字母更像名字
        if (Regex.IsMatch(s, @"[\p{IsCJKUnifiedIdeographs}]")) score += 3;
        if (Regex.IsMatch(s, @"[A-Za-z]")) score += 2;

        // 纯“文档/需求”等泛词降分
        if (GenericWords.Any(w => s.Contains(w, StringComparison.OrdinalIgnoreCase))) score -= 5;
        if (s.Contains("未命名", StringComparison.OrdinalIgnoreCase)) score -= 10;

        // 常见“章节标题”降分（避免选到“产品概述/背景/目录”等）
        var sectionish = new[]
        {
            "概述", "背景", "目录", "术语", "范围", "里程碑", "验收", "非功能", "数据模型", "接口", "附录", "更新"
        };
        if (sectionish.Any(w => s.Contains(w, StringComparison.OrdinalIgnoreCase))) score -= 6;

        return score;
    }
}


