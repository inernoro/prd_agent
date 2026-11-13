using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Diagnostics;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Services.ChatAgent;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;

namespace PrdAgent.Api.Services.ModelReferences;

public sealed class ModelRuntimeReferenceSnapshotBuilder(
    IConfiguration configuration,
    IOptionsMonitor<ChatAgentOptions> chatOptions,
    IOptionsMonitor<ClaudeSidecarOptions> sidecarOptions)
{
    public static readonly IReadOnlyList<string> ExpectedConsumerKeys = Array.AsReadOnly(new[]
    {
        "chat-agent.default", "claude-sidecar.default", "llm.environment-fallback",
        "llm.main-model", "llm.active-config", "sdk.openai.default", "sdk.claude.default",
        "design-artifact.model", "design-artifact.pool", "design-artifact.pinned-model"
    });

    private readonly string _instanceId = Guid.NewGuid().ToString("N");

    public ModelRuntimeReferenceSnapshot Capture(ModelRuntimeDatabaseReferences database, DateTime now)
    {
        var identity = new ModelRuntimeSnapshotIdentity(
            configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenant
                ? tenant : GatewayTenantDefaults.InternalTenantId,
            InstanceIdentity.Get(configuration), DeploymentScope.Current, DeploymentScope.CurrentDurable,
            BuildIdentity.ParseBakedCommit(typeof(ModelRuntimeReferenceSnapshotBuilder).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion),
            _instanceId);
        return Build(configuration, chatOptions.CurrentValue, sidecarOptions.CurrentValue, database, identity, now,
            Environment.GetEnvironmentVariable);
    }

    /// <summary>只读白名单字段；传入完整配置也不会序列化密钥、URL、提示词或 Header。</summary>
    public static ModelRuntimeReferenceSnapshot Build(
        IConfiguration configuration, ChatAgentOptions chat, ClaudeSidecarOptions sidecar,
        ModelRuntimeDatabaseReferences database, ModelRuntimeSnapshotIdentity identity,
        DateTime now, Func<string, string?>? environment = null)
    {
        environment ??= _ => null;
        var disabled = configuration.GetValue<bool>("LlmGateway:DisableMapConfigFallbackForRegisteredAppCallers")
            || configuration.GetValue<bool>("LlmGateway:DisableMapConfigFallbackForActiveAppCallers")
            || string.Equals(environment("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_REGISTERED_APP_CALLERS"), "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(environment("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS"), "true", StringComparison.OrdinalIgnoreCase);
        var configuredFallback = environment("LLM__Model") ?? configuration["LLM:Model"];
        var entries = new List<ModelRuntimeReferenceEntry>
        {
            Entry("chat-agent.default", "ChatAgent:Model", "public-id", chat.Model, required: true, state: configuration["ChatAgent:Model"] is null ? "default" : "configured"),
            Entry("claude-sidecar.default", "ClaudeSdkExecutor:DefaultModel", "upstream-model-id", sidecar.DefaultModel, required: true, state: configuration["ClaudeSdkExecutor:DefaultModel"] is null ? "default" : "configured"),
            Entry("llm.environment-fallback", "LLM:Model", "upstream-model-id",
                configuredFallback ?? "claude-3-5-sonnet-20241022", required: true,
                state: configuredFallback is null ? "default" : "configured"),
            Stored("llm.main-model", "llmmodels[IsMain=true,Enabled=true]", "physical-pair", database.MainModels, database.Complete),
            Stored("llm.active-config", "llmconfigs[IsActive=true].Model", "upstream-model-id", database.ActiveConfigs, database.Complete),
            Entry("sdk.openai.default", "OpenAIClient.constructor.model", "upstream-model-id", LlmTransportModelMetadata.OpenAiDefaultModel, required: true, state: "default"),
            Entry("sdk.claude.default", "ClaudeClient.constructor.model", "upstream-model-id", LlmTransportModelMetadata.ClaudeDefaultModel, required: true, state: "default"),
            Entry("design-artifact.model", "DesignArtifactRuntime:Model", "public-id", configuration["DesignArtifactRuntime:Model"]),
            Entry("design-artifact.pool", "DesignArtifactRuntime:ModelPoolId", "pool-id", configuration["DesignArtifactRuntime:ModelPoolId"]),
            Entry("design-artifact.pinned-model", "DesignArtifactRuntime:RequestPolicy:PinnedModelId", "physical-pair",
                configuration["DesignArtifactRuntime:RequestPolicy:PinnedModelId"],
                platform: configuration["DesignArtifactRuntime:RequestPolicy:PinnedPlatformId"])
        };
        // 复用执行器真正的冻结判据，非法 pin/pool 组合不能被清单冒充合法的空配置。
        try { DesignArtifactModelSelection.CaptureForNewRun(configuration); }
        catch (InvalidOperationException)
        {
            foreach (var entry in entries.Where(x => x.ConsumerKey.StartsWith("design-artifact.", StringComparison.Ordinal)))
            {
                entry.State = "unknown";
                entry.Value = null;
                entry.PlatformId = null;
            }
        }
        return new ModelRuntimeReferenceSnapshot
        {
            Id = SnapshotId(identity), TenantId = identity.TenantId,
            DeploymentIdentity = identity.DeploymentIdentity, DeploymentScope = identity.DeploymentScope,
            DurableScope = identity.DurableScope, ActualCommit = identity.ActualCommit,
            InstanceId = identity.InstanceId, HeartbeatAt = now, ExpiresAt = now.AddMinutes(2),
            LegacyFallbackAuthority = disabled ? "gateway-only" : "legacy-fallback-permitted",
            ExpectedConsumerKeys = ExpectedConsumerKeys.ToList(), Entries = entries
        };
    }

    public static string SnapshotId(ModelRuntimeSnapshotIdentity identity)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new[]
        {
            identity.TenantId, identity.DeploymentIdentity, identity.DeploymentScope, identity.InstanceId
        })))).ToLowerInvariant();

    private static ModelRuntimeReferenceEntry Stored(
        string key, string path, string kind, IReadOnlyList<ModelRuntimeStoredSelection> values, bool complete)
    {
        if (!complete || values.Count > 1) return Entry(key, path, kind, null, required: true);
        return values.Count == 0 ? Entry(key, path, kind, null)
            : Entry(key, path, kind, values[0].Model, required: true, platform: values[0].PlatformId);
    }

    private static ModelRuntimeReferenceEntry Entry(
        string key, string path, string kind, string? value, bool required = false,
        string state = "configured", string? platform = null)
    {
        value = value?.Trim();
        platform = platform?.Trim();
        var absent = string.IsNullOrEmpty(value) && string.IsNullOrEmpty(platform);
        var valid = IsSafeIdentifier(value) && (kind != "physical-pair" || IsSafeIdentifier(platform));
        return new ModelRuntimeReferenceEntry
        {
            ConsumerKey = key, Path = path, IdentityKind = kind,
            State = absent && !required ? "none" : valid ? state : "unknown",
            Value = valid ? value : null,
            PlatformId = valid && kind == "physical-pair" ? platform : null
        };
    }

    public static bool IsSafeIdentifier(string? value)
        => value is { Length: > 0 and <= 200 }
            && Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$", RegexOptions.CultureInvariant)
            && !value.Contains("://", StringComparison.Ordinal)
            && !new[] { "sk-", "ghp_", "github_pat_", "bearer", "eyJ" }
                .Any(prefix => value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));

    public static string? ValidateCoverage(
        ModelRuntimeReferenceSnapshot? snapshot, ModelRuntimeSnapshotIdentity expected, DateTime now)
    {
        if (snapshot is null || snapshot.SchemaVersion != 1) return "unknown-schema-or-missing-snapshot";
        if (snapshot.TenantId != expected.TenantId || snapshot.DeploymentIdentity != expected.DeploymentIdentity
            || snapshot.DeploymentScope != expected.DeploymentScope || snapshot.DurableScope != expected.DurableScope
            || snapshot.ActualCommit != expected.ActualCommit || !Regex.IsMatch(snapshot.ActualCommit ?? "", "^[a-fA-F0-9]{40}$")
            || string.IsNullOrWhiteSpace(snapshot.InstanceId)) return "deployment-identity-mismatch";
        if (snapshot.ExpiresAt <= now || snapshot.ExpiresAt <= snapshot.HeartbeatAt || snapshot.HeartbeatAt > now.AddSeconds(5)
            || snapshot.ExpiresAt > snapshot.HeartbeatAt.AddMinutes(2)) return "expired-or-invalid-heartbeat";
        if (snapshot.LegacyFallbackAuthority is not ("gateway-only" or "legacy-fallback-permitted")) return "unknown-fallback-authority";
        if (snapshot.Id != SnapshotId(expected with { InstanceId = snapshot.InstanceId })) return "invalid-snapshot-identity";
        if (snapshot.ExpectedConsumerKeys is null || snapshot.Entries is null) return "incomplete-consumer-coverage";
        if (!snapshot.ExpectedConsumerKeys.Order().SequenceEqual(ExpectedConsumerKeys.Order())
            || snapshot.Entries.Count != ExpectedConsumerKeys.Count
            || !snapshot.Entries.Select(x => x?.ConsumerKey).Order().SequenceEqual(ExpectedConsumerKeys.Order())) return "incomplete-consumer-coverage";
        foreach (var entry in snapshot.Entries)
        {
            var expectedKind = entry.ConsumerKey switch
            {
                "llm.main-model" or "design-artifact.pinned-model" => "physical-pair",
                "design-artifact.pool" => "pool-id",
                "chat-agent.default" or "design-artifact.model" => "public-id",
                _ => "upstream-model-id"
            };
            if (entry.IdentityKind != expectedKind || string.IsNullOrWhiteSpace(entry.Path)) return "consumer-identity-kind-mismatch";
            if (entry.IdentityKind is not ("public-id" or "pool-id" or "physical-pair" or "upstream-model-id")) return "unknown-identity-kind";
            if (entry.State == "none" && entry.Value is null && entry.PlatformId is null)
            {
                if (entry.ConsumerKey is "chat-agent.default" or "claude-sidecar.default" or "llm.environment-fallback" or "sdk.openai.default" or "sdk.claude.default")
                    return "missing-required-default";
                continue;
            }
            if (entry.State is not ("configured" or "default") || !IsSafeIdentifier(entry.Value)
                || (entry.IdentityKind == "physical-pair" ? !IsSafeIdentifier(entry.PlatformId) : entry.PlatformId is not null)) return "unknown-or-invalid-reference";
        }
        return null;
    }
}
