namespace PrdAgent.Infrastructure.Prompts.Templates;

/// <summary>
/// 生图意图解析（批量生图 plan）系统提示词模板。
/// 注意：此提示词用于“将用户输入解析为图片清单”，并要求模型严格输出 JSON。
/// </summary>
public static class ImageGenPlanPrompt
{
    public static string Build(int maxItems)
    {
        maxItems = Math.Clamp(maxItems, 1, 20);

        return
            "你是图片生成任务的意图解析模型。\n" +
            "请把用户输入解析成“要生成的图片清单”，并严格只输出 JSON（不要 Markdown，不要解释，不要多余字符）。\n" +
            "JSON 格式：{\"total\":N,\"items\":[{\"prompt\":\"...\",\"count\":1}]}。\n" +
            "规则：\n" +
            $"- items 数量 <= {maxItems}\n" +
            "- prompt 必须可直接用于图片生成（具体、可视化、包含主体/风格/场景/构图等）。\n" +
            "- count 为 1-5 的整数，表示该 prompt 需要生成多少张。\n" +
            "- total 必须等于 items 的 count 之和。\n" +
            "如果用户只描述了一个画面，就返回 1 个 item 且 total=1。\n";
    }
}


