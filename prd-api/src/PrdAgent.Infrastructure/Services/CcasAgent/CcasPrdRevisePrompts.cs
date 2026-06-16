using System.Text;

namespace PrdAgent.Infrastructure.Services.CcasAgent;

/// <summary>
/// CCAS PRD 多轮改稿 prompt。
/// 模式：chat-with-doc —— 每轮注入当前完整 Markdown，history 只保留短对话气泡，不重复嵌文档。
/// </summary>
public static class CcasPrdRevisePrompts
{
    public const string ReviseSystemCore = """
你是米多 CCAS 产品文档改稿助手。用户已有一份 PRD Markdown，会提出修改意见；你的任务是**在现有文档基础上做最小必要改动**，输出**完整修订后的 Markdown 全文**。

## 改稿原则

1. **最小改动** — 只改用户点名的章节/段落/表格行；未提及的内容逐字保留，禁止「顺手优化」无关段落。
2. **结构守恒** — 保留原有标题层级、章节编号、表格列、功能 ID（F01/R01/GR01 等）；禁止重排章节或合并 Part A / Part B。
3. **事实守恒** — 禁止凭空捏造客户名、接口、字段、设备数量；用户没给的新信息用 `[待补充]`。
4. **模板一致** — 文档须仍符合所选模板的章节骨架；缺章补占位，不删 mandatory 章节。
5. **输出纯净** — 只输出 Markdown 正文，不要前言、后记、解释性废话，不要用代码围栏包裹整篇文档。
6. **禁止 emoji** — 全文不得出现 emoji 字符。

## 多轮上下文

- 历史对话只记录「用户改了什么意图」和「助手已执行改稿」的简短确认，**不包含**完整文档。
- 当前轮会以「当前文档全文」为准；若历史与文档冲突，**以当前文档为准**。

## 分隔符

若原文含 `---` 分隔 Part A 与 Part B，修订后必须保留该分隔方式（可在同一位置保留一行 `---`）。
""";

    public static string BuildSystemPrompt(string templateKey)
    {
        var template = CcasPrdPrompts.GetTemplate(templateKey);
        return ReviseSystemCore
            + "\n\n## 参考模板（保持章节骨架一致）\n\n"
            + template;
    }

    public static string BuildUserPrompt(
        string currentMarkdown,
        string instruction,
        string? originalInput,
        IReadOnlyList<(string Role, string Content)>? history)
    {
        var sb = new StringBuilder();

        var historyBlock = CcasQaPrompts.BuildHistoryContext(history);
        if (!string.IsNullOrWhiteSpace(historyBlock))
        {
            sb.AppendLine(historyBlock);
            sb.AppendLine();
        }

        if (!string.IsNullOrWhiteSpace(originalInput))
        {
            sb.AppendLine("## 原始立项描述（背景参考，改稿时勿偏离）");
            sb.AppendLine(originalInput.Trim());
            sb.AppendLine();
        }

        sb.AppendLine("## 当前文档全文（在此基础上修改）");
        sb.AppendLine("---");
        sb.AppendLine(currentMarkdown.Trim());
        sb.AppendLine("---");
        sb.AppendLine();
        sb.AppendLine("## 本轮改稿指令");
        sb.AppendLine(instruction.Trim());
        sb.AppendLine();
        sb.AppendLine("请直接输出修订后的**完整 Markdown 文档**（从第一个标题开始，到文档末尾结束）。");

        return sb.ToString();
    }
}
