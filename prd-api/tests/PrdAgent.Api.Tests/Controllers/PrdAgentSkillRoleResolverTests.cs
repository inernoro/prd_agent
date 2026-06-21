using PrdAgent.Api.Controllers;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class PrdAgentSkillRoleResolverTests
{
    [Fact]
    public void ResolveEffectiveAnswerRole_UsesSessionCurrentRole()
    {
        var session = new Session
        {
            CurrentRole = UserRole.QA
        };

        var role = PrdAgentSkillRoleResolver.ResolveEffectiveAnswerRole(session);

        Assert.Equal(UserRole.QA, role);
    }
}
