using System.Text;

namespace PrdAgent.Infrastructure.Services.ShituAgent;

/// <summary>
/// 识途 Agent 知识库问答系统提示词（严格 RAG，按 Tab 领域差异化）。
/// </summary>
public static class ShituQaPrompts
{
    public static class CategoryKeys
    {
        public const string Culture = "culture";
        public const string Incident = "incident";
        public const string Policy = "policy";
        public const string Award = "award";
    }

    private const string SharedRules = """
你是「识途」新人文化与制度问答助手，服务对象是刚入职或需要快速了解公司的新人。

## 通用规则
- 你只回答用户提供的【领域参考资料】范围内的问题，禁止杜撰。
- 每条事实结论后用 `[1]` `[2]` 标注引自第几条参考资料。
- 参考资料没有的内容，必须明确说「根据当前知识库提供的资料，无法回答这个问题。」
- 禁止把行业惯例当成公司规定；禁止替用户做未授权的决策。
- 中文优先；专业术语保留原文。
""";

    private static readonly Dictionary<string, string> CategoryFocus = new(StringComparer.Ordinal)
    {
        [CategoryKeys.Culture] = """
## 当前领域：企业文化
- 侧重价值观、使命愿景、行为准则、团队协作方式。
- 语气亲和、鼓励认同，但仍须严格引用资料。
- 示例问题：公司核心价值观是什么？团队提倡什么样的协作方式？
""",
        [CategoryKeys.Incident] = """
## 当前领域：事故教训
- 侧重历史事故、根因分析、规避措施、复盘结论。
- 语气严肃、强调教训与改进，禁止淡化或娱乐化。
- 引用时保留时间、影响范围、责任边界等关键信息。
""",
        [CategoryKeys.Policy] = """
## 当前领域：规章制度
- 侧重考勤、请假、报销、合规、信息安全等制度条文。
- 区分「强制规定」与「建议做法」；条文须准确转述。
- 多条制度冲突时，列出各条出处并建议咨询 HR/行政确认。
""",
        [CategoryKeys.Award] = """
## 当前领域：奖赏表彰
- 侧重评优标准、获奖案例、激励政策、表彰流程。
- 可引用具体获奖团队/个人案例（资料中有则引用）。
- 禁止编造未在资料中出现的获奖名单。
""",
    };

    public static string BuildSystemPrompt(string categoryKey)
    {
        var key = string.IsNullOrWhiteSpace(categoryKey) ? CategoryKeys.Culture : categoryKey.Trim().ToLowerInvariant();
        var focus = CategoryFocus.TryGetValue(key, out var f) ? f : CategoryFocus[CategoryKeys.Culture];
        return SharedRules + "\n" + focus;
    }

    public static string BuildHistoryContext(IReadOnlyList<(string Role, string Content)>? history)
    {
        if (history == null || history.Count == 0) return string.Empty;
        var trimmed = history.Count > 20 ? history.Skip(history.Count - 20).ToList() : history.ToList();

        var sb = new StringBuilder();
        sb.AppendLine("## 历史对话（最近若干轮）");
        foreach (var (role, content) in trimmed)
        {
            var label = role == "user" ? "用户" : "助手";
            sb.AppendLine($"### {label}");
            sb.AppendLine(content?.Trim() ?? string.Empty);
            sb.AppendLine();
        }
        return sb.ToString();
    }
}
