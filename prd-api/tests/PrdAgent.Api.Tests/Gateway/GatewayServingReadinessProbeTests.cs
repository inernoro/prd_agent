using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayServingReadinessProbeTests
{
    [Fact]
    public void IsCallerRoutable_RejectsPoolWithDifferentRequestType()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("chat", ModelHealthStatus.Healthy);

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(caller, pools));
    }

    [Fact]
    public void IsCallerRoutable_AcceptsMatchingPoolWithAvailableMember()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("asr", ModelHealthStatus.Degraded);

        Assert.True(GatewayServingReadinessProbe.IsCallerRoutable(caller, pools));
    }

    [Fact]
    public void IsCallerRoutable_RejectsMatchingPoolWhenAllMembersUnavailable()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("asr", ModelHealthStatus.Unavailable);

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(caller, pools));
    }

    private static GatewayAppCallerRecord CreateCaller(string requestType)
    {
        return new GatewayAppCallerRecord
        {
            AppCallerCode = "test.caller",
            RequestType = requestType,
            ModelPoolId = "pool-1",
        };
    }

    private static IReadOnlyDictionary<string, ModelGroup> CreatePools(
        string modelType,
        ModelHealthStatus healthStatus)
    {
        var pool = new ModelGroup
        {
            Id = "pool-1",
            ModelType = modelType,
            Models =
            [
                new ModelGroupItem
                {
                    ModelId = "model-1",
                    PlatformId = "platform-1",
                    HealthStatus = healthStatus,
                },
            ],
        };

        return new Dictionary<string, ModelGroup>(StringComparer.OrdinalIgnoreCase)
        {
            [pool.Id] = pool,
        };
    }
}
