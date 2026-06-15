using PrdAgent.Infrastructure.Services.CcasAgent;
using Xunit;

namespace PrdAgent.Tests;

public class CcasPrdRevisePromptsTests
{
    [Fact]
    public void BuildUserPrompt_IncludesCurrentDocAndInstruction()
    {
        var prompt = CcasPrdRevisePrompts.BuildUserPrompt(
            "# Part A\n内容",
            "把设备改成 6 台相机",
            "立项背景",
            null);

        Assert.Contains("当前文档全文", prompt);
        Assert.Contains("# Part A", prompt);
        Assert.Contains("把设备改成 6 台相机", prompt);
        Assert.Contains("立项背景", prompt);
    }

    [Fact]
    public void BuildSystemPrompt_IncludesTemplateKey()
    {
        var prompt = CcasPrdRevisePrompts.BuildSystemPrompt(CcasPrdPrompts.TemplateKeys.Agile);
        Assert.Contains("敏捷版", prompt);
        Assert.Contains("最小改动", prompt);
    }
}
