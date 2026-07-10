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

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(caller, pools, []));
    }

    [Fact]
    public void IsCallerRoutable_AcceptsMatchingPoolWithAvailableMember()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("asr", ModelHealthStatus.Degraded);

        Assert.True(GatewayServingReadinessProbe.IsCallerRoutable(caller, pools, []));
    }

    [Fact]
    public void IsCallerRoutable_RejectsMatchingPoolWhenAllMembersUnavailable()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("asr", ModelHealthStatus.Unavailable);

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(caller, pools, []));
    }

    [Fact]
    public void IsCallerRoutable_AcceptsMatchingDefaultPoolWithoutExplicitBinding()
    {
        var caller = CreateCaller("asr", modelPoolId: null);
        var defaultPool = CreatePool("asr", ModelHealthStatus.Healthy, isDefault: true);

        Assert.True(GatewayServingReadinessProbe.IsCallerRoutable(
            caller,
            new Dictionary<string, ModelGroup>(),
            [defaultPool]));
    }

    [Fact]
    public void IsCallerRoutable_DoesNotFallBackToDefaultWhenExplicitBindingIsInvalid()
    {
        var caller = CreateCaller("asr");
        var wrongBoundPool = CreatePools("chat", ModelHealthStatus.Healthy);
        var defaultPool = CreatePool("asr", ModelHealthStatus.Healthy, isDefault: true);

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(
            caller,
            wrongBoundPool,
            [defaultPool]));
    }

    private static GatewayAppCallerRecord CreateCaller(
        string requestType,
        string? modelPoolId = "pool-1")
    {
        return new GatewayAppCallerRecord
        {
            AppCallerCode = "test.caller",
            RequestType = requestType,
            ModelPoolId = modelPoolId,
        };
    }

    private static IReadOnlyDictionary<string, ModelGroup> CreatePools(
        string modelType,
        ModelHealthStatus healthStatus)
    {
        var pool = CreatePool(modelType, healthStatus);

        return new Dictionary<string, ModelGroup>(StringComparer.OrdinalIgnoreCase)
        {
            [pool.Id] = pool,
        };
    }

    private static ModelGroup CreatePool(
        string modelType,
        ModelHealthStatus healthStatus,
        bool isDefault = false)
    {
        return new ModelGroup
        {
            Id = "pool-1",
            ModelType = modelType,
            IsDefaultForType = isDefault,
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
    }
}
