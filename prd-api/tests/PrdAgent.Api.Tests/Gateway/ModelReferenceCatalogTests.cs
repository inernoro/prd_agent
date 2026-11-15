using MongoDB.Bson;
using PrdAgent.LlmGw.ModelReferences;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class ModelReferenceCatalogTests
{
    [Theory]
    [InlineData(null, null, null)]
    [InlineData("project-a", "main", "461076339cbf20a310d4cedd2403a08a2941ae87")]
    [InlineData(" project-b ", " codex/test ", " abc ")]
    [InlineData("project-a", null, null)]
    public void SnapshotExpectedScopeMatchesActualMapAuthority(string? project, string? branch, string? revision)
    {
        var compose = typeof(PrdAgent.Core.Models.DeploymentScope).GetMethod("Compose", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        Assert.Equal(compose.Invoke(null, [project, branch, revision]), ModelReferenceRuntimeAuthority.ComposeScope(project, branch, revision));
    }
    private static BsonDocument Logical(string type = "chat", params string[] capabilities)
        => new() { { "Enabled", true }, { "ModelType", type }, { "Capabilities", new BsonArray(capabilities.Length == 0 ? new[] { "chat" } : capabilities) }, { "AllowedAppCallerCodes", new BsonArray() } };
    private static BsonDocument Physical(params string[] capabilities)
        => new() { { "Enabled", true }, { "Capabilities", new BsonArray((capabilities.Length == 0 ? new[] { "chat" } : capabilities)
            .Select(x => new BsonDocument { { "Type", x }, { "Value", true } })) } };
    private static BsonDocument Provider() => new("Enabled", true);

    [Fact]
    public void SamePurposeEnabledSuccessorWithPreservedCapabilitiesAndCallersIsAccepted()
        => Assert.Empty(ModelReferenceCatalog.ValidateDocuments(Logical(), Logical(), Physical(), Provider()));

    [Fact]
    public void EnabledLogicalCannotHideDisabledActualProvider()
    {
        var provider = Provider(); provider["Enabled"] = false;
        Assert.Contains(ModelReferenceCatalog.ValidateDocuments(Logical(), Logical(), Physical(), provider), x => x.Contains("停用"));
    }
    [Fact]
    public void ChatAndImageSameNameNeverEstablishPurposeCompatibility()
        => Assert.Contains(ModelReferenceCatalog.ValidateDocuments(Logical(), Logical("generation", "text2img"), Physical("text2img"), Provider()), x => x.Contains("用途"));

    [Fact]
    public void SuccessorMustRetainCapabilitiesAndPhysicalImplementation()
    {
        Assert.Contains(ModelReferenceCatalog.ValidateDocuments(Logical("chat", "chat", "tools"), Logical(), Physical(), Provider()), x => x.Contains("全部能力"));
        Assert.Contains(ModelReferenceCatalog.ValidateDocuments(Logical(), Logical("chat", "chat", "tools"), Physical(), Provider()), x => x.Contains("物理线路能力"));
    }
    [Fact]
    public void MigrationCannotSilentlyRemoveExistingCallerAuthorization()
    {
        var source = Logical(); var target = Logical();
        target["AllowedAppCallerCodes"] = new BsonArray { "prd-agent.arena.battle::chat" };
        Assert.Contains(ModelReferenceCatalog.ValidateDocuments(source, target, Physical(), Provider()), x => x.Contains("授权"));
        source["AllowedAppCallerCodes"] = new BsonArray { "PRD-AGENT.ARENA.BATTLE::CHAT" };
        Assert.Empty(ModelReferenceCatalog.ValidateDocuments(source, target, Physical(), Provider()));
        source["AllowedAppCallerCodes"] = new BsonArray { "prd-agent-web.model-lab.run::chat" };
        Assert.Contains(ModelReferenceCatalog.ValidateDocuments(source, target, Physical(), Provider()), x => x.Contains("授权"));
    }
}
