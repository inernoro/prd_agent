using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayServingReadinessProbeTests
{
    [Fact]
    public void GatewayRuntimeSettings_CopyOnlyFieldsConsumedByServing()
    {
        var source = new AppSettings
        {
            EnablePromptCache = false,
            RequestBodyMaxChars = 123,
            AnswerMaxChars = 456,
            ErrorMaxChars = 789,
            MiduoSsoAppSecret = "must-not-copy",
            PasswordLoginDisabled = true,
        };

        var copied = GatewayAppSettingsService.CopyGatewayFields(source);

        Assert.False(copied.EnablePromptCache);
        Assert.Equal(123, copied.RequestBodyMaxChars);
        Assert.Equal(456, copied.AnswerMaxChars);
        Assert.Equal(789, copied.ErrorMaxChars);
        Assert.Null(copied.MiduoSsoAppSecret);
        Assert.Null(copied.PasswordLoginDisabled);
    }

    [Fact]
    public void IsCallerRoutable_RejectsPoolWithDifferentRequestType()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("chat", ModelHealthStatus.Healthy);

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(
            caller, pools, [], EnabledPlatforms(), []));
    }

    [Fact]
    public void IsCallerRoutable_AcceptsMatchingPoolWithAvailableMember()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("asr", ModelHealthStatus.Degraded);

        Assert.True(GatewayServingReadinessProbe.IsCallerRoutable(
            caller, pools, [], EnabledPlatforms(), []));
    }

    [Fact]
    public void IsCallerRoutable_RejectsMatchingPoolWhenAllMembersUnavailable()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("asr", ModelHealthStatus.Unavailable);

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(
            caller, pools, [], EnabledPlatforms(), []));
    }

    [Fact]
    public void IsCallerRoutable_AcceptsMatchingDefaultPoolWithoutExplicitBinding()
    {
        var caller = CreateCaller("asr", modelPoolId: null);
        var defaultPool = CreatePool("asr", ModelHealthStatus.Healthy, isDefault: true);

        Assert.True(GatewayServingReadinessProbe.IsCallerRoutable(
            caller,
            new Dictionary<string, ModelGroup>(),
            [defaultPool],
            EnabledPlatforms(),
            []));
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
            [defaultPool],
            EnabledPlatforms(),
            []));
    }

    [Fact]
    public void IsCallerRoutable_RejectsAvailableModelWithMissingBackend()
    {
        var caller = CreateCaller("asr");
        var pools = CreatePools("asr", ModelHealthStatus.Healthy);

        Assert.False(GatewayServingReadinessProbe.IsCallerRoutable(
            caller, pools, [], new HashSet<string>(), []));
    }

    [Fact]
    public void IsCallerRoutable_AcceptsEnabledExchangeWithMatchingModel()
    {
        var caller = CreateCaller("asr");
        var pool = CreatePool(
            "asr",
            ModelHealthStatus.Healthy,
            platformId: "exchange-1");
        var pools = new Dictionary<string, ModelGroup> { [pool.Id] = pool };
        var exchange = new ModelExchange
        {
            Id = "exchange-1",
            Enabled = true,
            Models = [new ExchangeModel { ModelId = "model-1", ModelType = "asr", Enabled = true }],
        };

        Assert.True(GatewayServingReadinessProbe.IsCallerRoutable(
            caller, pools, [], new HashSet<string>(), [exchange]));
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
        bool isDefault = false,
        string platformId = "platform-1")
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
                    PlatformId = platformId,
                    HealthStatus = healthStatus,
                },
            ],
        };
    }

    private static HashSet<string> EnabledPlatforms()
        => new(StringComparer.OrdinalIgnoreCase) { "platform-1" };
}
