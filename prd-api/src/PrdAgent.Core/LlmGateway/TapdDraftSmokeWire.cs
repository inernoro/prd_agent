using System.Text.Json.Nodes;

namespace PrdAgent.Core.LlmGateway;

/// <summary>Fixed, non-user inputs admitted by the bounded TAPD quality probe.</summary>
public static class TapdDraftSmokeWire
{
    public const int MaxOutputTokens = 1024;

    public const string SystemPrompt = """
            你是 TAPD 缺陷自动提报智能体，负责把用户口语化缺陷描述整理为标准缺陷草稿。
            严格规则：
            1. 只能输出严格 JSON，不要输出 Markdown、解释、代码围栏。
            2. 必须尽量基于用户原话合理补齐四要素。信息不足时使用“进入出现该问题的页面/执行描述中的操作/观察异常结果/不应出现异常错误”等可核对表述，不要让四要素为空。
            3. 标题格式为“场景 + 问题现象”，不超过 30 个中文字符。
            4. 四要素必须拆成数组：preconditions、steps、actualResult、expectedResult。
            5. 默认 module/versionReport 为“附近门店组件精准筛选”，currentOwner 为“黄卫杰;”。
            6. severity 只能是 fatal/serious/normal/minor，默认 serious；priority 只能是 urgent/high/medium/low，默认 high。
            7. bugType 只能是 逻辑错误/不符方案/功能遗漏/历史缺陷/产品缺陷，默认 逻辑错误。
            返回 JSON 字段：
            title, module, severity, priority, bugType, currentOwner, versionReport,
            preconditions, steps, actualResult, expectedResult, missingFields
            """;

    private static readonly string[] Cases =
    [
        "在门店搜索页，搜索北岸门店后点击筛选，页面显示错误 503。预期只显示北岸门店。",
        "在资料页点击上传，实际返回 FILE_EMPTY，预期正常接收 inventory.csv。",
        "在设置页将重试次数设为 3 后点击保存，提示 CONFIG_LOCKED。预期刷新后仍显示重试次数 3。",
    ];

    public static bool IsScenario(int index) => index >= 0 && index < Cases.Length;

    public static JsonArray Messages(int index) =>
    [
        new JsonObject { ["role"] = "system", ["content"] = SystemPrompt },
        new JsonObject { ["role"] = "user", ["content"] = Cases[index] }
    ];

    public static bool Accepts(string caller, JsonArray messages)
        => string.Equals(caller, Models.AppCallerRegistry.TapdBugAgent.Extract.Chat, StringComparison.OrdinalIgnoreCase)
           && Enumerable.Range(0, Cases.Length).Any(index => JsonNode.DeepEquals(messages, Messages(index)));
}
