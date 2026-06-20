namespace PrdAgent.Api.Services;

/// <summary>
/// 知识库划词局部改写动作注册表 —— 内置动作 + custom（用户自定义指令）。
/// 后端是动作清单与提示词的 SSOT（frontend-architecture.md：前端禁止维护业务映射表），
/// 前端通过 GET /api/document-store/selection-rewrite/actions 拉取展示。
/// </summary>
public static class SelectionRewriteActionRegistry
{
    public static readonly IReadOnlyList<SelectionRewriteAction> Actions = new List<SelectionRewriteAction>
    {
        new(
            Key: "polish",
            Label: "润色",
            Description: "提升表达流畅度与专业性，不改变含义与事实",
            Instruction: "润色这段文字：提升表达的流畅度、准确性与专业性。保持原意、事实、数据与链接不变，长度大致相当。"
        ),
        new(
            Key: "concise",
            Label: "精简",
            Description: "压缩冗余表达，只保留关键信息",
            Instruction: "精简这段文字：删除冗余、重复与口水话，只保留关键信息与必要细节，长度压缩到原来的一半左右。不得丢失事实、数据与链接。"
        ),
        new(
            Key: "expand",
            Label: "扩写",
            Description: "结合上下文补充细节，让内容更充分",
            Instruction: "扩写这段文字：结合选区前后文的主题与语境，补充必要的细节、例子或解释，让内容更充分、更有说服力。保持与上下文的术语和语气一致，不得编造与上下文矛盾的事实。"
        ),
        new(
            Key: "formal",
            Label: "书面化",
            Description: "口语表达转为规范书面语，统一术语",
            Instruction: "把这段文字改写为规范的书面表达：消除口语化措辞，统一术语与人称，使其符合正式文档的语体。保持原意不变。"
        ),
        new(
            Key: "fix",
            Label: "纠错",
            Description: "修正错别字、语法与标点，尽量少改动",
            Instruction: "修正这段文字中的错别字、语法错误与标点问题。在保证正确的前提下尽量少改动，不调整句式结构与表达风格。"
        ),
    };

    public static SelectionRewriteAction? FindByKey(string? key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        return Actions.FirstOrDefault(a => a.Key == key);
    }
}

/// <param name="Key">动作 key（custom 之外的内置动作）</param>
/// <param name="Label">前端 chip 展示名</param>
/// <param name="Description">tooltip 说明</param>
/// <param name="Instruction">注入 user prompt 的改写指令</param>
public record SelectionRewriteAction(string Key, string Label, string Description, string Instruction);
