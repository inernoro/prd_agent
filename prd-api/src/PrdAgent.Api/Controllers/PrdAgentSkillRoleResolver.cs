using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

internal static class PrdAgentSkillRoleResolver
{
    public static UserRole ResolveEffectiveAnswerRole(Session session)
        => session.CurrentRole;
}
