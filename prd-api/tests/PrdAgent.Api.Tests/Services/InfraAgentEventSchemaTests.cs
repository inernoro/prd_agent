using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentEventSchemaTests
{
    [Fact]
    public void ErrorEventSchema_ShouldExposeRuntimeRecoveryDiagnostics()
    {
        var error = InfraAgentEventSchema.Items.Single(x => x.Type == InfraAgentEventTypes.Error);

        error.RequiredPayloadFields.ShouldContain("message");
        error.OptionalPayloadFields.ShouldContain("code");
        error.OptionalPayloadFields.ShouldContain("retryable");
        error.OptionalPayloadFields.ShouldContain("recoveryKind");
        error.OptionalPayloadFields.ShouldContain("nextActions");
        error.OptionalPayloadFields.ShouldContain("runtimeAdapter");
        error.OptionalPayloadFields.ShouldContain("runtimeInstance");
        error.OptionalPayloadFields.ShouldContain("content");
    }
}
