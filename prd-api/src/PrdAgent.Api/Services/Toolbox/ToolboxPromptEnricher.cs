namespace PrdAgent.Api.Services.Toolbox;

/// <summary>
/// 把百宝箱智能体的 EnabledTools 折叠进 systemPrompt 的「你的能力」段（SSOT）。
///
/// 两条调用路径必须共用同一份实现，避免行为漂移（Cursor/Codex review）：
/// - AiToolboxController 的 direct-chat 路径
/// - AgentUniverseController 的 custom:{id} 统一 invoke 路径
/// </summary>
public static class ToolboxPromptEnricher
{
    public static string EnrichSystemPromptWithTools(string basePrompt, List<string>? enabledTools)
    {
        if (enabledTools == null || enabledTools.Count == 0)
            return basePrompt;

        var capabilities = new List<string>();

        if (enabledTools.Contains("webSearch"))
            capabilities.Add("- 你具备网页搜索能力。当用户需要实时信息或你不确定答案时，可以告知用户你正在搜索并提供基于搜索的回答。请在需要搜索时用 [搜索中...] 标记。");

        if (enabledTools.Contains("imageGen"))
            capabilities.Add("- 你具备图片生成能力。当用户需要生成图片时，请用详细的英文描述生成提示词，并用 [生成图片: prompt] 格式标记。");

        if (enabledTools.Contains("codeInterpreter"))
            capabilities.Add("- 你具备代码执行能力。可以编写并执行 Python 代码来处理数据分析、计算、图表生成等任务。请在需要执行代码时提供完整的可运行代码。");

        if (enabledTools.Contains("fileReader"))
            capabilities.Add("- 你具备文件阅读能力。可以解析用户上传的 PDF、Word、Excel 等文件内容并基于其回答问题。");

        if (enabledTools.Contains("workflowTrigger"))
            capabilities.Add("- 你具备工作流触发能力。当用户请求执行预定义的自动化流程时，可以触发绑定的工作流。");

        if (capabilities.Count == 0)
            return basePrompt;

        return basePrompt + "\n\n## 你的能力\n" + string.Join("\n", capabilities);
    }
}
