using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentSessionServiceRemotePollingTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("cds-agent-active", true)]
    public void ShouldPollRemoteSession_ShouldRequireAttachedCdsSession(
        string? cdsSessionId,
        bool expected)
    {
        var session = new InfraAgentSession { CdsSessionId = cdsSessionId };

        InfraAgentSessionService.ShouldPollRemoteSession(session).ShouldBe(expected);
    }

    [Fact]
    public void ShouldPollRemoteSession_ShouldStopAfterMissingSessionIsDetached()
    {
        var session = new InfraAgentSession { CdsSessionId = "cds-agent-missing" };
        InfraAgentSessionService.ShouldPollRemoteSession(session).ShouldBeTrue();

        session.CdsSessionId = null;

        InfraAgentSessionService.ShouldPollRemoteSession(session).ShouldBeFalse();
    }

    [Fact]
    public void IsCdsSessionNotFound_ShouldRequireTransportErrorCodeAndMarker()
    {
        var missing = new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.CdsRequestFailed,
            "CDS 请求失败：HTTP 404 {\"error\":\"session_not_found\"}",
            502);
        var unrelated = new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.CdsRequestFailed,
            "CDS 请求失败：HTTP 500",
            502);
        var wrongCode = new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.SessionNotFound,
            "session_not_found",
            404);

        InfraAgentSessionService.IsCdsSessionNotFound(missing).ShouldBeTrue();
        InfraAgentSessionService.IsCdsSessionNotFound(unrelated).ShouldBeFalse();
        InfraAgentSessionService.IsCdsSessionNotFound(wrongCode).ShouldBeFalse();
    }
}
