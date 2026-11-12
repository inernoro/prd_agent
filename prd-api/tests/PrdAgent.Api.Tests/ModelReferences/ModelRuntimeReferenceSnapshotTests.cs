using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Api.Services.ModelReferences;
using PrdAgent.Infrastructure.Services.ChatAgent;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;
using Xunit;

namespace PrdAgent.Api.Tests.ModelReferences;

public sealed class ModelRuntimeReferenceSnapshotTests
{
    private static readonly DateTime Now = new(2026, 11, 12, 0, 0, 0, DateTimeKind.Utc);
    private static readonly ModelRuntimeSnapshotIdentity Identity = new(
        "tenant_map_internal", "map:production::main", null, null, new string('a', 40), "instance-a");
    private static readonly ModelRuntimeDatabaseReferences Empty = new(true, [], []);

    private static IConfiguration Config(params (string Key, string Value)[] pairs)
        => new ConfigurationBuilder().AddInMemoryCollection(
            pairs.Select(x => new KeyValuePair<string, string?>(x.Key, x.Value))).Build();

    private static ModelRuntimeReferenceSnapshot Build(
        IConfiguration? config = null, ModelRuntimeDatabaseReferences? database = null,
        ModelRuntimeSnapshotIdentity? identity = null, Func<string, string?>? environment = null)
        => ModelRuntimeReferenceSnapshotBuilder.Build(config ?? Config(), new ChatAgentOptions(),
            new ClaudeSidecarOptions(), database ?? Empty, identity ?? Identity, Now, environment);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OwnDeploymentSnapshotHeartbeatIsAdmittedAsMaintenance(bool cds)
    {
        var configuration = cds ? Config(("CDS_PROJECT_ID", "prd-agent"), ("VITE_GIT_BRANCH", "main")) : Config();
        var registry = new PrdAgent.Api.Services.BackgroundTasks.BackgroundTaskAdmissionRegistry(configuration);
        var admission = registry.Check(typeof(ModelRuntimeReferenceSnapshotWorker));
        Assert.Equal(PrdAgent.Api.Services.BackgroundTasks.BackgroundTaskKind.Maintenance, admission.Kind);
        Assert.True(admission.Allowed);
        Assert.False(registry.SharedAutomaticEnabled); // admission does not grant any shared automatic model work
    }

    [Fact]
    public void MissingConfigurationPublishesActualComputedDefaultsAndExplicitEmptyEntries()
    {
        var snapshot = Build();
        Assert.Equal(10, snapshot.Entries.Count);
        Assert.Equal("claude-opus-4-5", snapshot.Entries.Single(x => x.ConsumerKey == "chat-agent.default").Value);
        Assert.Equal("default", snapshot.Entries.Single(x => x.ConsumerKey == "chat-agent.default").State);
        Assert.Equal("claude-3-5-sonnet-20241022", snapshot.Entries.Single(x => x.ConsumerKey == "llm.environment-fallback").Value);
        Assert.Equal("gpt-5.6-sol", snapshot.Entries.Single(x => x.ConsumerKey == "sdk.openai.default").Value);
        Assert.Equal("claude-3-5-sonnet-20241022", snapshot.Entries.Single(x => x.ConsumerKey == "sdk.claude.default").Value);
        Assert.All(snapshot.Entries.Where(x => x.ConsumerKey.StartsWith("design-artifact.")), x =>
        {
            Assert.Equal("none", x.State);
            Assert.Null(x.Value);
        });
        Assert.Null(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(snapshot, Identity, Now));
    }

    [Fact]
    public void ComputedOptionsOverrideRawConfigurationAndNeverExportOtherOptionFields()
    {
        var config = Config(("ChatAgent:Model", "raw-stale-model"), ("LLM:ClaudeApiKey", "secret-key"),
            ("DesignArtifactRuntime:PublicBaseUrl", "https://secret.example/token"));
        var chat = new ChatAgentOptions { Model = "claude-computed-version", SystemPrompt = "secret-system-prompt" };
        var sidecar = new ClaudeSidecarOptions { DefaultModel = "claude-sidecar-computed", DefaultSidecarToken = "secret-sidecar-token" };
        var snapshot = ModelRuntimeReferenceSnapshotBuilder.Build(config, chat, sidecar, Empty, Identity, Now);
        var serialized = JsonSerializer.Serialize(snapshot);
        Assert.Contains("claude-computed-version", serialized);
        Assert.Contains("claude-sidecar-computed", serialized);
        Assert.DoesNotContain("raw-stale-model", serialized);
        Assert.DoesNotContain("secret", serialized);
        Assert.DoesNotContain("ApiKey", serialized);
        Assert.DoesNotContain("BaseUrl", serialized);
        Assert.DoesNotContain("SystemPrompt", serialized);
    }

    [Fact]
    public void EnvironmentPrecedenceAndLegacyAuthorityMatchExistingResolver()
    {
        var snapshot = Build(Config(("LLM:Model", "config-model")), environment: key => key switch
        {
            "LLM__Model" => "env-model",
            "LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS" => "true",
            _ => null
        });
        Assert.Equal("env-model", snapshot.Entries.Single(x => x.ConsumerKey == "llm.environment-fallback").Value);
        Assert.Equal("gateway-only", snapshot.LegacyFallbackAuthority);
    }
    [Fact]
    public void LegacyFallbackValuesArePublishedAsUpstreamNamesRatherThanPublicAliases()
    {
        var snapshot = Build(Config(("LLM:Model", "old-upstream-model")),
            database: new ModelRuntimeDatabaseReferences(true, [], [new("old-active-upstream")]), environment: _ => null);
        Assert.Equal("legacy-fallback-permitted", snapshot.LegacyFallbackAuthority);
        foreach (var key in new[] { "llm.environment-fallback", "llm.active-config" })
            Assert.Equal("upstream-model-id", snapshot.Entries.Single(x => x.ConsumerKey == key).IdentityKind);
        Assert.Equal("old-active-upstream", snapshot.Entries.Single(x => x.ConsumerKey == "llm.active-config").Value);
        Assert.Null(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(snapshot, Identity, Now));
    }

    [Fact]
    public void MissingAndAmbiguousDatabaseStateCannotPretendToBeComplete()
    {
        foreach (var database in new[]
        {
            new ModelRuntimeDatabaseReferences(false, [], []),
            new ModelRuntimeDatabaseReferences(true, [new("model-a", "provider-a"), new("model-b", "provider-b")], [])
        })
        {
            var snapshot = Build(database: database);
            Assert.Equal("unknown", snapshot.Entries.Single(x => x.ConsumerKey == "llm.main-model").State);
            Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(snapshot, Identity, Now));
        }
    }

    [Fact]
    public void PhysicalPairsPreserveExactProviderAndModelWhileOtherKindsRemainSeparate()
    {
        var snapshot = Build(Config(("DesignArtifactRuntime:RequestPolicy:PinnedModelId", "model-a"),
            ("DesignArtifactRuntime:RequestPolicy:PinnedPlatformId", "provider-a")),
            new(true, [new("model-main", "provider-main")], [new("logical-chat")]));
        var pin = snapshot.Entries.Single(x => x.ConsumerKey == "design-artifact.pinned-model");
        Assert.Equal("physical-pair", pin.IdentityKind);
        Assert.Equal("model-a", pin.Value);
        Assert.Equal("provider-a", pin.PlatformId);
        Assert.Null(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(snapshot, Identity, Now));
    }

    [Fact]
    public void PartialPinAndIncompatiblePoolAreUnknown()
    {
        foreach (var config in new[]
        {
            Config(("DesignArtifactRuntime:RequestPolicy:PinnedModelId", "model-a")),
            Config(("DesignArtifactRuntime:ModelPoolId", "pool-a"),
                ("DesignArtifactRuntime:RequestPolicy:PinnedModelId", "model-a"),
                ("DesignArtifactRuntime:RequestPolicy:PinnedPlatformId", "provider-a"))
        }) Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(Build(config), Identity, Now));
    }

    [Theory]
    [InlineData("sk-not-a-model-secret")]
    [InlineData("https://user:password@example.com/model")]
    [InlineData("Bearer-private-token")]
    public void CredentialShapedValuesAreNeverExported(string value)
    {
        var snapshot = Build(Config(("LLM:Model", value)));
        Assert.DoesNotContain(value, JsonSerializer.Serialize(snapshot));
        Assert.Equal("unknown", snapshot.Entries.Single(x => x.ConsumerKey == "llm.environment-fallback").State);
    }

    [Fact]
    public void ProcessAndBranchRecordsCannotOverwriteOneAnother()
    {
        var ids = new[]
        {
            Identity,
            Identity with { InstanceId = "instance-b" },
            Identity with { DeploymentScope = "project::feature::revision::a", DurableScope = "project::feature" },
            Identity with { TenantId = "another-tenant" }
        }.Select(ModelRuntimeReferenceSnapshotBuilder.SnapshotId).ToList();
        Assert.Equal(4, ids.Distinct().Count());
        var snapshot = Build();
        var filter = ModelRuntimeReferenceSnapshotWorker.OwnRecordFilter(snapshot).Render(
            new RenderArgs<ModelRuntimeReferenceSnapshot>(BsonSerializer.LookupSerializer<ModelRuntimeReferenceSnapshot>(), BsonSerializer.SerializerRegistry));
        var json = filter.ToJson();
        Assert.Contains(snapshot.Id, json);
        Assert.Contains(snapshot.InstanceId, json);
        Assert.Contains(snapshot.TenantId, json);
        Assert.Contains("DeploymentScope", json);
    }

    private sealed class Monitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue { get; set; } = value;
        public T Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }

    [Fact]
    public void HeartbeatReadsComputedCurrentOptionsWithoutChangingProcessIdentity()
    {
        var chat = new Monitor<ChatAgentOptions>(new() { Model = "model-v1" });
        var sidecar = new Monitor<ClaudeSidecarOptions>(new());
        var builder = new ModelRuntimeReferenceSnapshotBuilder(Config(), chat, sidecar);
        var first = builder.Capture(Empty, Now);
        chat.CurrentValue = new() { Model = "model-v2" };
        var second = builder.Capture(Empty, Now.AddSeconds(30));
        Assert.Equal(first.Id, second.Id);
        Assert.Equal(first.InstanceId, second.InstanceId);
        Assert.Equal("model-v2", second.Entries.Single(x => x.ConsumerKey == "chat-agent.default").Value);
        Assert.Equal(Now.AddSeconds(150), second.ExpiresAt);
        Assert.NotEqual(first.Id, new ModelRuntimeReferenceSnapshotBuilder(Config(), chat, sidecar).Capture(Empty, Now).Id);
    }

    [Fact]
    public void RequiredDefaultCannotBeForgedAsNoneAndKindCannotBeSwapped()
    {
        var snapshot = Build();
        var required = snapshot.Entries.Single(x => x.ConsumerKey == "chat-agent.default");
        required.State = "none";
        required.Value = null;
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(snapshot, Identity, Now));
        var wrongKind = Build();
        wrongKind.Entries.Single(x => x.ConsumerKey == "design-artifact.pool").IdentityKind = "public-id";
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(wrongKind, Identity, Now));
    }

    [Fact]
    public void ExpiredUnknownSchemaMissingOrDuplicateConsumerAndWrongDeploymentFailClosed()
    {
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(null, Identity, Now));
        var expired = Build();
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(expired, Identity, Now.AddMinutes(2)));
        var schema = Build(); schema.SchemaVersion = 2;
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(schema, Identity, Now));
        var missing = Build(); missing.Entries.RemoveAt(0);
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(missing, Identity, Now));
        var duplicate = Build(); duplicate.Entries[1] = duplicate.Entries[0];
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(duplicate, Identity, Now));
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(Build(), Identity with { DeploymentScope = "other-branch" }, Now));
        Assert.NotNull(ModelRuntimeReferenceSnapshotBuilder.ValidateCoverage(Build(), Identity with { ActualCommit = new string('b', 40) }, Now));
    }
}
