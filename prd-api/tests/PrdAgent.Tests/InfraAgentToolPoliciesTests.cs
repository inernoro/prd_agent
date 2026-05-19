using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class InfraAgentToolPoliciesTests
{
    [Theory]
    [InlineData("Bash")]
    [InlineData("bash")]
    [InlineData("BaSh")]
    [InlineData("Edit")]
    [InlineData("edit")]
    [InlineData("Write")]
    [InlineData("write")]
    public void BuiltInWriteToolsAreCaseInsensitive(string toolName)
    {
        Assert.True(InfraAgentToolPolicies.IsCodeWritableTool(toolName));
        Assert.False(InfraAgentToolPolicies.ShouldExposeToolToRuntime(InfraAgentToolPolicies.ReadonlyAuto, toolName));
    }
}
