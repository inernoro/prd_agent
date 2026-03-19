using System.Text;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Helpers;

/// <summary>
/// SKILL.md 格式序列化/反序列化工具
///
/// 格式设计原则：
/// - 标准 SKILL.md 字段（name, description）兼容 Claude Code / Cursor / Copilot 等平台
/// - prd-agent: 命名空间包含我们的扩展字段（其他平台会忽略）
/// - Markdown body 即为 promptTemplate
/// </summary>
public static partial class SkillMdFormat
{
    private const string Separator = "---";

    /// <summary>
    /// 将 Skill 模型序列化为 SKILL.md 格式字符串
    /// </summary>
    public static string Serialize(Skill skill)
    {
        var sb = new StringBuilder();

        // ━━━ YAML Frontmatter ━━━
        sb.AppendLine(Separator);

        // Standard SKILL.md fields (cross-platform)
        var name = string.IsNullOrWhiteSpace(skill.SkillKey) ? "untitled-skill" : skill.SkillKey;
        sb.AppendLine($"name: {name}");
        sb.AppendLine($"description: \"{EscapeYamlString(skill.Description)}\"");

        // prd-agent extensions (namespaced, ignored by other platforms)
        sb.AppendLine("prd-agent:");
        sb.AppendLine($"  title: \"{EscapeYamlString(skill.Title)}\"");

        if (!string.IsNullOrWhiteSpace(skill.Icon))
            sb.AppendLine($"  icon: \"{skill.Icon}\"");

        if (!string.IsNullOrWhiteSpace(skill.Category) && skill.Category != "general")
            sb.AppendLine($"  category: {skill.Category}");

        if (skill.Tags.Count > 0)
            sb.AppendLine($"  tags: [{string.Join(", ", skill.Tags.Select(t => $"\"{EscapeYamlString(t)}\""))}]");

        if (skill.Roles.Count > 0)
            sb.AppendLine($"  roles: [{string.Join(", ", skill.Roles.Select(r => r.ToString()))}]");

        // Input config
        var input = skill.Input;
        if (input.ContextScope != "prd" || input.AcceptsUserInput || input.AcceptsAttachments)
        {
            sb.AppendLine($"  context-scope: {input.ContextScope}");
            if (input.AcceptsUserInput) sb.AppendLine("  accepts-user-input: true");
            if (input.AcceptsAttachments) sb.AppendLine("  accepts-attachments: true");
        }

        // Output config
        var output = skill.Output;
        if (output.Mode != "chat")
            sb.AppendLine($"  output-mode: {output.Mode}");

        // Execution hints (non-sensitive)
        if (!string.IsNullOrWhiteSpace(skill.Execution.SystemPromptOverride))
            sb.AppendLine($"  system-prompt-override: \"{EscapeYamlString(skill.Execution.SystemPromptOverride)}\"");

        sb.AppendLine(Separator);
        sb.AppendLine();

        // ━━━ Markdown body = promptTemplate ━━━
        var template = skill.Execution.PromptTemplate ?? "";
        sb.Append(template.TrimEnd());
        sb.AppendLine();

        return sb.ToString();
    }

    /// <summary>
    /// 从 SKILL.md 格式字符串反序列化为 Skill 模型
    /// </summary>
    public static Skill? Deserialize(string skillMd)
    {
        if (string.IsNullOrWhiteSpace(skillMd))
            return null;

        var (frontmatter, body) = SplitFrontmatterAndBody(skillMd);
        if (frontmatter == null)
            return null;

        var skill = new Skill();
        var lines = frontmatter.Split('\n');
        var inPrdAgent = false;

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd();

            // Detect prd-agent: namespace
            if (line == "prd-agent:")
            {
                inPrdAgent = true;
                continue;
            }

            // Top-level field (no indent) exits prd-agent namespace
            if (!line.StartsWith(' ') && !line.StartsWith('\t') && line.Contains(':'))
            {
                inPrdAgent = false;
            }

            if (inPrdAgent)
            {
                var trimmed = line.TrimStart();
                var (key, value) = ParseYamlLine(trimmed);
                switch (key)
                {
                    case "title": skill.Title = UnquoteYaml(value); break;
                    case "icon": skill.Icon = UnquoteYaml(value); break;
                    case "category": skill.Category = value; break;
                    case "tags": skill.Tags = ParseYamlArray(value); break;
                    case "roles": skill.Roles = ParseRoles(value); break;
                    case "context-scope": skill.Input.ContextScope = value; break;
                    case "accepts-user-input": skill.Input.AcceptsUserInput = value == "true"; break;
                    case "accepts-attachments": skill.Input.AcceptsAttachments = value == "true"; break;
                    case "output-mode": skill.Output.Mode = value; break;
                    case "system-prompt-override": skill.Execution.SystemPromptOverride = UnquoteYaml(value); break;
                }
            }
            else
            {
                var (key, value) = ParseYamlLine(line);
                switch (key)
                {
                    case "name": skill.SkillKey = value; break;
                    case "description": skill.Description = UnquoteYaml(value); break;
                }
            }
        }

        // Title fallback: use SkillKey if no prd-agent title
        if (string.IsNullOrWhiteSpace(skill.Title))
            skill.Title = skill.SkillKey;

        // Body = promptTemplate
        skill.Execution.PromptTemplate = body.Trim();

        return skill;
    }

    /// <summary>
    /// 快速检测文本是否是 SKILL.md 格式（有 YAML frontmatter 且含 name: 字段）
    /// </summary>
    public static bool IsSkillMdFormat(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        var trimmed = text.TrimStart();
        return trimmed.StartsWith("---") && trimmed.IndexOf("\nname:", StringComparison.Ordinal) > 0;
    }

    // ━━━ Internal helpers ━━━━━━━━

    private static (string? Frontmatter, string Body) SplitFrontmatterAndBody(string text)
    {
        var trimmed = text.TrimStart();
        if (!trimmed.StartsWith(Separator))
            return (null, text);

        var afterFirst = trimmed.IndexOf('\n') + 1;
        if (afterFirst <= 0)
            return (null, text);

        var closingIdx = trimmed.IndexOf($"\n{Separator}", afterFirst, StringComparison.Ordinal);
        if (closingIdx < 0)
            return (null, text);

        var frontmatter = trimmed.Substring(afterFirst, closingIdx - afterFirst);
        var bodyStart = closingIdx + Separator.Length + 2; // +1 for \n, +1 for after ---
        var body = bodyStart < trimmed.Length ? trimmed[bodyStart..] : "";

        return (frontmatter, body);
    }

    private static (string Key, string Value) ParseYamlLine(string line)
    {
        var colonIdx = line.IndexOf(':');
        if (colonIdx < 0) return ("", "");

        var key = line[..colonIdx].Trim();
        var value = line[(colonIdx + 1)..].Trim();
        return (key, value);
    }

    private static string UnquoteYaml(string value)
    {
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            return value[1..^1].Replace("\\\"", "\"").Replace("\\n", "\n");
        if (value.Length >= 2 && value[0] == '\'' && value[^1] == '\'')
            return value[1..^1];
        return value;
    }

    private static List<string> ParseYamlArray(string value)
    {
        // Parse [item1, item2, ...] format
        if (!value.StartsWith('[') || !value.EndsWith(']'))
            return new List<string>();

        var inner = value[1..^1];
        return inner.Split(',')
            .Select(s => UnquoteYaml(s.Trim()))
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .ToList();
    }

    private static List<UserRole> ParseRoles(string value)
    {
        var strings = ParseYamlArray(value);
        var roles = new List<UserRole>();
        foreach (var s in strings)
        {
            if (Enum.TryParse<UserRole>(s, true, out var role))
                roles.Add(role);
        }
        return roles;
    }

    private static string EscapeYamlString(string value)
    {
        return (value ?? "")
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\n", "\\n");
    }
}
