using PrdAgent.Core.Models.AgentUniverse;
using PrdAgent.Infrastructure.Services.ChatAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「专业智能体作为通用体的技能」这条链路的守卫。
///
/// 这条链有三段：能力契约声明 ToolName → DI 把它包成工具 → 白名单放它进这次对话。
/// 断任何一段，功能都**不报错、不红、编译通过**，只是通用体永远不会转派，
/// 用户依旧得自己挑智能体——正是「链路只建一半」那种静默退化。
/// </summary>
public class AgentDelegationContractTests
{
    /// <summary>
    /// 白名单是一道**故意的人工闸**（加工具要决策者点头），所以它不从契约自动生成。
    /// 代价是会漂移：契约里新登一个可转派智能体、忘了开闸，工具就永远不出现。
    /// 这条断言就是那把锁——漂了必红，同时逼着加闸的人明确知道自己在扩范围。
    /// </summary>
    [Fact]
    public void EveryDelegatableCapability_ShouldBeOnChatAgentToolWhitelist()
    {
        var whitelist = new ChatAgentOptions().Tools;

        foreach (var capability in AgentCapabilityRegistry.Delegatable)
        {
            Assert.True(
                whitelist.Contains(capability.ToolName!, StringComparer.Ordinal),
                $"能力 {capability.AgentKey} 声明了工具 {capability.ToolName}，"
                + "但 ChatAgentOptions.Tools 白名单里没有它——通用体永远看不到这把工具。"
                + "扩白名单属于扩范围，请确认已获决策者同意，再把它加进去。");
        }
    }

    /// <summary>
    /// 反向：白名单里的转派工具必须真有对应能力。删了能力却留着闸，
    /// 通用体会拿到一把注册表里不存在的工具名，运行时才炸。
    /// </summary>
    [Fact]
    public void EveryDelegateToolOnWhitelist_ShouldHaveBackingCapability()
    {
        var known = AgentCapabilityRegistry.Delegatable
            .Select(c => c.ToolName!)
            .ToHashSet(StringComparer.Ordinal);

        var orphans = new ChatAgentOptions().Tools
            .Where(name => name.StartsWith("agent_", StringComparison.Ordinal))
            .Where(name => !known.Contains(name))
            .ToList();

        Assert.True(orphans.Count == 0,
            $"白名单里这些转派工具没有对应能力契约：{string.Join(", ", orphans)}");
    }

    /// <summary>
    /// 可转派的能力必须能真的被路由到：AgentKey + DefaultAction 是找适配器的唯一依据，
    /// 缺一个就只能报 NO_REAL_AGENT。ToolWhenToUse 也必填——
    /// 描述里不写「什么时候该用我」，模型要么从不调用，要么见谁都调。
    /// </summary>
    [Fact]
    public void DelegatableCapabilities_ShouldCarryRoutableContract()
    {
        Assert.NotEmpty(AgentCapabilityRegistry.Delegatable);

        foreach (var capability in AgentCapabilityRegistry.Delegatable)
        {
            Assert.False(string.IsNullOrWhiteSpace(capability.AgentKey));
            Assert.False(string.IsNullOrWhiteSpace(capability.DefaultAction),
                $"{capability.AgentKey} 没有 DefaultAction，转派时找不到适配器动作");
            Assert.False(string.IsNullOrWhiteSpace(capability.ToolWhenToUse),
                $"{capability.AgentKey} 没写「什么时候该用我」，模型无从判断要不要转派");
            Assert.Matches("^[a-z][a-z0-9_]*$", capability.ToolName!);
        }
    }

    /// <summary>
    /// 视觉创作刻意不可转派：出图已经由 chat_generate_image 覆盖（同一条平台出图流水线）。
    /// 两把干同样事的工具会让路由随机化，也会出现改一处忘一处。
    /// 哪天真要放开，必须先处理掉这个重叠——这条断言就是那道提醒。
    /// </summary>
    [Fact]
    public void VisualAgent_ShouldNotDuplicateExistingImageTool()
    {
        var visual = AgentCapabilityRegistry.Find("visual-agent");
        Assert.NotNull(visual);
        Assert.True(string.IsNullOrWhiteSpace(visual!.ToolName),
            "视觉创作被登记成了转派工具，但 chat_generate_image 已经覆盖同一条出图流水线；"
            + "要放开就得先解决两把工具的重叠。");
        Assert.Contains("chat_generate_image", new ChatAgentOptions().Tools);
    }

    /// <summary>
    /// 工具卡上必须显示智能体的名字，不是函数名。
    /// 带 mcp__map__ 前缀的形态同样要命中——运行时回传的就是带前缀那种。
    /// </summary>
    [Fact]
    public void DelegateToolCard_ShouldShowAgentNameNotFunctionName()
    {
        foreach (var capability in AgentCapabilityRegistry.Delegatable)
        {
            Assert.Equal(capability.Name, ChatAgentToolPresentation.ToolLabel(capability.ToolName));
            Assert.Equal(capability.Name,
                ChatAgentToolPresentation.ToolLabel($"mcp__map__{capability.ToolName}"));

            // 等待期要有推进感，不能退化成单阶段「执行」
            var steps = ChatAgentToolPresentation.ToolSteps($"mcp__map__{capability.ToolName}");
            Assert.True(steps.Length > 1);
            Assert.Contains(capability.Name, steps[0]);
        }
    }

    /// <summary>
    /// 用户没有挑智能体，就更要看得见是谁接的活——转派结果的卡上必须写明来源。
    /// </summary>
    [Fact]
    public void DelegateToolCard_ShouldAttributeResultToTheAgent()
    {
        var payload = ChatAgentToolPresentation.BuildToolCardPayload(
            "mcp__map__agent_prd_analyze",
            "tool-1",
            """{"ok":true,"agent":"PRD 解读智能体","output":"这篇需求缺少异常路径。"}""",
            isError: false);

        Assert.True(payload.Ok);
        Assert.Contains("PRD 解读智能体", payload.Message ?? string.Empty);
    }
}
