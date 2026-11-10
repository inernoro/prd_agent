using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

public sealed class ProviderMirrorRemovalTests
{
    [Theory]
    [InlineData("tenant_map_internal", false, true)]
    [InlineData("tenant_map_internal", true, false)]
    [InlineData("external", false, false)]
    [InlineData("external", true, false)]
    public void MirrorSynchronizationOnlyDisablesForInternalTenant(string tenantId, bool enabled, bool expected)
        => Assert.Equal(expected, ProviderRemovalPolicy.ShouldDisableMapMirror(tenantId, "tenant_map_internal", enabled));

    [Fact]
    public void MapOnlyPlatformIsRemovableForInternalTenantButNotExternalTenant()
    {
        var mirror = new BsonDocument { { "_id", "old-source" }, { "Name", "old provider" } };
        Assert.True(ProviderRemovalPolicy.MayRemoveMapMirror("tenant_map_internal", "tenant_map_internal"));
        Assert.False(ProviderRemovalPolicy.MayRemoveMapMirror("external-tenant", "tenant_map_internal"));
        Assert.Same(mirror, ProviderRemovalPolicy.SelectSource(null, mirror, true));
        Assert.Null(ProviderRemovalPolicy.SelectSource(null, mirror, false));
        var gateway = new BsonDocument { { "_id", "old-source" }, { "TenantId", "external-tenant" } };
        Assert.Same(gateway, ProviderRemovalPolicy.SelectSource(gateway, mirror, false));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("tenant_map_internal")]
    public void SnapshotDeletionMatchesExactIdentityVersionAndGatewayTenant(string? tenantId)
    {
        var snapshot = new BsonDocument { { "_id", "old-source" }, { "Name", "same name as someone else" },
            { "UpdatedAt", new BsonDateTime(new DateTime(2026, 11, 11, 0, 0, 0, DateTimeKind.Utc)) } };
        var args = new RenderArgs<BsonDocument>(BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry);
        var rendered = ProviderRemovalPolicy.UnchangedFilter(snapshot, tenantId).Render(args);
        Assert.Equal("old-source", rendered["_id"].AsString);
        Assert.Equal(snapshot["UpdatedAt"], rendered["UpdatedAt"]);
        Assert.DoesNotContain("Name", rendered.Names);
        if (tenantId is null) Assert.False(rendered.Contains("TenantId"));
        else Assert.Equal(tenantId, rendered["TenantId"].AsString);
        snapshot.Remove("UpdatedAt");
        Assert.False(ProviderRemovalPolicy.UnchangedFilter(snapshot, tenantId).Render(args)["UpdatedAt"]["$exists"].AsBoolean);
    }

    [Fact]
    public void EndpointChecksReferencesThenDeletesMirrorBeforeGatewayWithRequiredAudit()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "llmgw"))) directory = directory.Parent;
        Assert.NotNull(directory);
        var program = File.ReadAllText(Path.Combine(directory!.FullName, "llmgw", "console-api", "Program.cs"));
        var start = program.IndexOf("app.MapDelete(\"/gw/platforms/{id}\"", StringComparison.Ordinal);
        var end = program.IndexOf("// 删除模型：同样先查引用。", start, StringComparison.Ordinal);
        var endpoint = program[start..end];
        Assert.Contains("var mapDocument = isInternal", endpoint);
        Assert.Contains("ProviderRemovalPolicy.SelectSource(gatewayDocument, mapDocument, isInternal)", endpoint);
        Assert.Contains("PLATFORM_HAS_OFFERINGS", endpoint);
        Assert.Contains("PLATFORM_HAS_INFLIGHT_JOBS", endpoint);
        Assert.Contains("if (isInternal && mapDocument is not null)", endpoint);
        Assert.Contains("platforms.DeleteOneAsync(ProviderRemovalPolicy.UnchangedFilter(mapDocument)", endpoint);
        Assert.Contains("gwPlatforms.DeleteOneAsync(ProviderRemovalPolicy.UnchangedFilter(gatewayDocument, tenantId)", endpoint);
        var mirrorDelete = endpoint.IndexOf("platforms.DeleteOneAsync", StringComparison.Ordinal);
        var gatewayDelete = endpoint.IndexOf("gwPlatforms.DeleteOneAsync", StringComparison.Ordinal);
        Assert.True(endpoint.IndexOf("CollectPlatformDeleteBlockersAsync", StringComparison.Ordinal) < mirrorDelete);
        Assert.True(endpoint.IndexOf("action: \"platform.delete\"", StringComparison.Ordinal) < mirrorDelete);
        Assert.True(mirrorDelete < gatewayDelete);
        Assert.Contains("TryCompleteRequiredOperationAuditAsync", endpoint);
        Assert.DoesNotContain("platforms.DeleteManyAsync", endpoint);
    }

    [Fact]
    public void DisableEndpointRepairsMirrorEvenWhenGatewayWasAlreadyDisabled()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "llmgw"))) directory = directory.Parent;
        Assert.NotNull(directory);
        var program = File.ReadAllText(Path.Combine(directory!.FullName, "llmgw", "console-api", "Program.cs"));
        var start = program.IndexOf("app.MapPut(\"/gw/platforms/{id}/enabled\"", StringComparison.Ordinal);
        var end = program.IndexOf("// 模型启用/停用", start, StringComparison.Ordinal);
        var endpoint = program[start..end];
        Assert.Contains("if (ProviderRemovalPolicy.ShouldDisableMapMirror(tenantId, internalTenantId, enabled))", endpoint);
        Assert.Contains("var mapDocument = targetAuthority == \"map\" ? doc : await platforms.Find(sourceFilter)", endpoint);
        Assert.Contains("platforms.UpdateOneAsync(ProviderRemovalPolicy.UnchangedFilter(mapDocument), update", endpoint);
        Assert.Contains("PLATFORM_DISABLE_INCOMPLETE", endpoint);
        Assert.Contains("TryCompleteRequiredOperationAuditAsync", endpoint);
        Assert.DoesNotContain("if (doc.AsNullableBool(\"Enabled\")", endpoint);
        var mirrorUpdate = endpoint.IndexOf("platforms.UpdateOneAsync", StringComparison.Ordinal);
        Assert.True(endpoint.IndexOf("BeginRequiredOperationAuditAsync", StringComparison.Ordinal) < mirrorUpdate);
        Assert.True(mirrorUpdate < endpoint.IndexOf("var targetResult = await targetPlatforms.UpdateOneAsync", StringComparison.Ordinal));
        Assert.EndsWith("}).RequireAuthorization(\"ConfigWrite\");", endpoint.Trim());
    }
}
