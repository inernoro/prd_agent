using System.Reflection;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 网关不能引用 MAP 项目，但删除闸查询的是 MAP 文档。这里把集合、字段和枚举逐项对照，
/// 防止 MAP 重命名后过滤器静默匹配不到，从而放行本应阻断的删除。
/// </summary>
public sealed class MapLogicalModelReferencePolicyMirrorTests
{
    [Fact]
    public void 集合名与MAP上下文一致()
    {
        var source = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs");
        Assert.Contains($"GetCollection<AppSettings>(\"{MapLogicalModelReferencePolicy.AppSettingsCollectionName}\")", source);
        Assert.Contains($"GetCollection<AgentApiKey>(\"{MapLogicalModelReferencePolicy.AgentApiKeysCollectionName}\")", source);
        Assert.Contains($"GetCollection<ImageGenRun>(\"{MapLogicalModelReferencePolicy.ImageRunsCollectionName}\")", source);
    }

    [Fact]
    public void 配置引用字段与MAP实体一致()
    {
        AssertNestedProperty(typeof(AppSettings), MapLogicalModelReferencePolicy.VisualPolicyDefaultField);
        AssertNestedProperty(typeof(AppSettings), MapLogicalModelReferencePolicy.VisualPolicyModelsField);
        AssertNestedProperty(typeof(AgentApiKey), MapLogicalModelReferencePolicy.AgentKeyModelModeField);
        AssertNestedProperty(typeof(AgentApiKey), MapLogicalModelReferencePolicy.AgentKeyFixedModelField);
        AssertNestedProperty(typeof(AgentApiKey), MapLogicalModelReferencePolicy.AgentKeyOpenApiChatModelsField);
        AssertNestedProperty(typeof(AgentApiKey), MapLogicalModelReferencePolicy.AgentKeyOpenApiImageModelsField);
        Assert.Equal((int)McpLiteraryImageModelMode.Fixed, MapLogicalModelReferencePolicy.AgentKeyFixedModelMode);
    }

    [Fact]
    public void 生图任务引用字段与终态枚举一致()
    {
        AssertNestedProperty(typeof(ImageGenRun), MapLogicalModelReferencePolicy.ImageRunStatusField);
        AssertNestedProperty(typeof(ImageGenRun), MapLogicalModelReferencePolicy.ImageRunLogicalModelField);
        AssertNestedProperty(typeof(ImageGenRun), MapLogicalModelReferencePolicy.ImageRunPlatformField);
        AssertNestedProperty(typeof(ImageGenRun), MapLogicalModelReferencePolicy.ImageRunModelField);
        Assert.Equal(
            new[] { ImageGenRunStatus.Completed, ImageGenRunStatus.Failed, ImageGenRunStatus.Cancelled }
                .Select(x => (int)x).ToHashSet(),
            MapLogicalModelReferencePolicy.TerminalImageRunStatuses.ToHashSet());
    }

    [Theory]
    [InlineData("future-image-model-2099")]
    [InlineData("vendor-neutral-image-edit-v42")]
    [InlineData("newly-added-model-without-code-change")]
    public void 三类过滤器都按任意公开模型标识生效(string publicId)
    {
        var rendered = new[]
        {
            Render(MapLogicalModelReferencePolicy.BuildVisualPolicyFilter(publicId)),
            Render(MapLogicalModelReferencePolicy.BuildAgentApiKeyReferenceFilter(publicId)),
            Render(MapLogicalModelReferencePolicy.BuildInFlightImageRunFilter(publicId)),
        };

        Assert.All(rendered, filter => Assert.Contains(publicId, filter));
        Assert.Contains(MapLogicalModelReferencePolicy.VisualPolicyDefaultField, rendered[0]);
        Assert.Contains(MapLogicalModelReferencePolicy.AgentKeyFixedModelField, rendered[1]);
        Assert.Contains(MapLogicalModelReferencePolicy.AgentKeyOpenApiChatModelsField, rendered[1]);
        Assert.Contains(MapLogicalModelReferencePolicy.AgentKeyOpenApiImageModelsField, rendered[1]);
        Assert.Contains(MapLogicalModelReferencePolicy.ImageRunLogicalModelField, rendered[2]);

        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("MapLogicalModelReferencePolicy.BuildVisualPolicyFilter", console);
        Assert.Contains("MapLogicalModelReferencePolicy.BuildAgentApiKeyReferenceFilter", console);
        Assert.Contains("MapLogicalModelReferencePolicy.BuildInFlightImageRunFilter", console);
        Assert.Contains("MODEL_REFERENCED_BY_MAP", console);
    }

    [Fact]
    public void 业务引用覆盖四种未来配置而不扫描运行历史()
    {
        var queries = MapLogicalModelReferencePolicy.BuildBusinessLogicalModelQueries("logical-internal-id");
        Assert.Equal(new[] { "arena_slots", "model_lab_experiments", "model_lab_model_sets", "model_lab_groups" },
            queries.Select(q => q.CollectionName));
        Assert.Equal(BsonDocument.Parse("{ LogicalModelId: 'logical-internal-id' }"), RenderDocument(queries[0].Filter));
        Assert.Equal(BsonDocument.Parse("{ SelectedModels: { $elemMatch: { LogicalModelId: 'logical-internal-id' } } }"),
            RenderDocument(queries[1].Filter));
        Assert.All(queries.Skip(2), query => Assert.Equal(
            BsonDocument.Parse("{ Models: { $elemMatch: { LogicalModelId: 'logical-internal-id' } } }"), RenderDocument(query.Filter)));
        // 停用配置也保留外键；删除后重新启用不能复活一个悬空 ID。
        Assert.All(queries, query => Assert.DoesNotContain("Enabled", Render(query.Filter)));
        var source = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs");
        Assert.Contains("GetCollection<ArenaSlot>(\"arena_slots\")", source);
        Assert.Contains("GetCollection<ModelLabExperiment>(\"model_lab_experiments\")", source);
        Assert.Contains("GetCollection<ModelLabModelSet>(\"model_lab_model_sets\")", source);
        Assert.Contains("GetCollection<ModelLabGroup>(\"model_lab_groups\")", source);
        AssertNestedProperty(typeof(ModelLabExperiment), "SelectedModels.PlatformId");
        AssertNestedProperty(typeof(ModelLabModelSet), "Models.ModelId");
        AssertNestedProperty(typeof(ModelLabGroup), "Models.PlatformId");
    }

    [Fact]
    public void 显式旧逻辑绑定仅在缺少内部身份时按精确公开名阻断退役()
    {
        var queries = MapLogicalModelReferencePolicy.BuildBusinessLogicalModelQueries("new-logical-id", "fixed-version");
        var expectedMember = BsonDocument.Parse("""
            { $or: [ { LogicalModelId: "new-logical-id" },
                { LogicalModelId: { $in: [null, ""] }, PlatformId: "logical-model", ModelId: "fixed-version" } ] }
            """);
        Assert.Equal(expectedMember, RenderDocument(queries[0].Filter));
        Assert.Equal(new BsonDocument("SelectedModels", new BsonDocument("$elemMatch", expectedMember)),
            RenderDocument(queries[1].Filter));
        Assert.All(queries.Skip(2), query => Assert.Equal(
            new BsonDocument("Models", new BsonDocument("$elemMatch", expectedMember)), RenderDocument(query.Filter)));
        Assert.Equal(BsonDocument.Parse("{ LogicalModelId: 'new-logical-id' }"),
            RenderDocument(MapLogicalModelReferencePolicy.BuildBusinessLogicalModelQueries("new-logical-id", "")[0].Filter));
        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("logicalModelId: id, publicId: doc.AsNullableString(\"PublicId\")", console);
        Assert.Contains("logicalModelId: id, publicId: existing.AsNullableString(\"PublicId\")", console);
    }

    [Fact]
    public void 旧物理绑定必须同成员且未明确迁移才阻断平台退役()
    {
        var queries = MapLogicalModelReferencePolicy.BuildLegacyPlatformQueries("retired-platform");
        var expectedMember = BsonDocument.Parse("""
            { LogicalModelId: { $in: [null, ""] }, PlatformId: "retired-platform",
              ModelId: { $type: 2, $ne: "" } }
            """);
        Assert.Equal(expectedMember, RenderDocument(queries[0].Filter));
        Assert.Equal(new BsonDocument("SelectedModels", new BsonDocument("$elemMatch", expectedMember)),
            RenderDocument(queries[1].Filter));
        Assert.All(queries.Skip(2), query => Assert.Equal(
            new BsonDocument("Models", new BsonDocument("$elemMatch", expectedMember)), RenderDocument(query.Filter)));
        // 对照真正实体序列化，防止误把 ModelId 当内部物理登记 ID 或漏掉旧字段。
        var legacy = new ArenaSlot { PlatformId = "retired-platform", ModelId = "exact-fixed-version" }.ToBsonDocument();
        Assert.Equal("retired-platform", legacy["PlatformId"].AsString);
        Assert.Equal("exact-fixed-version", legacy["ModelId"].AsString);
        AssertNestedProperty(typeof(ArenaSlot), "PlatformId");
        AssertNestedProperty(typeof(ModelLabExperiment), "SelectedModels.ModelId");
    }

    [Theory]
    [InlineData("app.MapDelete(\"/gw/logical-models/{id}\"", "logicalModelId: id", "MODEL_REFERENCED_BY_MAP")]
    [InlineData("app.MapPut(\"/gw/logical-models/{id}/enabled\"", "logicalModelId: id", "MODEL_REFERENCED_BY_MAP")]
    [InlineData("app.MapDelete(\"/gw/platforms/{id}\"", "platformId: id", "PLATFORM_REFERENCED_BY_MAP")]
    [InlineData("app.MapPut(\"/gw/platforms/{id}/enabled\"", "platformId: id", "PLATFORM_REFERENCED_BY_MAP")]
    public void 四个破坏性入口在写入前调用同一跨库引用闸(string route, string identityArgument, string errorCode)
    {
        var source = ReadRepoFile("llmgw/console-api/Program.cs");
        var start = source.IndexOf(route, StringComparison.Ordinal);
        Assert.True(start >= 0);
        var end = source.IndexOf("}).RequireAuthorization(\"ConfigWrite\");", start, StringComparison.Ordinal);
        var endpoint = source[start..end];
        var guard = endpoint.IndexOf("CollectMapBusinessModelReferencesAsync", StringComparison.Ordinal);
        Assert.True(guard > 0);
        Assert.Contains(identityArgument, endpoint);
        Assert.Contains(errorCode, endpoint);
        var mutation = endpoint.IndexOf(route.Contains("MapDelete") ? ".Delete" : route.Contains("logical-models")
            ? ".FindOneAndUpdateAsync" : ".UpdateOneAsync", StringComparison.Ordinal);
        Assert.True(mutation > guard, "检查必须先于实际写入");
        var helperStart = source.IndexOf("static async Task<List<string>> CollectMapBusinessModelReferencesAsync", StringComparison.Ordinal);
        var helperEnd = source.IndexOf("static async Task<PlatformDeleteBlockers>", helperStart, StringComparison.Ordinal);
        var helper = source[helperStart..helperEnd];
        Assert.True(helper.IndexOf("TenantId != internalTenantId", StringComparison.Ordinal)
            < helper.IndexOf("mapDatabase.GetCollection", StringComparison.Ordinal));
    }

    private static BsonDocument RenderDocument(FilterDefinition<BsonDocument> filter)
        => filter.Render(new RenderArgs<BsonDocument>(
            BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry));

    private static void AssertNestedProperty(Type rootType, string path)
    {
        var current = rootType;
        foreach (var segment in path.Split('.'))
        {
            var property = current.GetProperty(segment, BindingFlags.Public | BindingFlags.Instance);
            Assert.NotNull(property);
            current = property!.PropertyType;
            if (current.IsGenericType && current.GetGenericTypeDefinition() == typeof(List<>))
                current = current.GetGenericArguments()[0];
            current = Nullable.GetUnderlyingType(current) ?? current;
        }
    }

    private static string Render(FilterDefinition<BsonDocument> filter)
        => filter.Render(new RenderArgs<BsonDocument>(
            BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(),
            BsonSerializer.SerializerRegistry)).ToString();

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var fullPath = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(fullPath), $"找不到文件: {fullPath}");
        return File.ReadAllText(fullPath);
    }
    [Fact]
    public void 三类过滤器都绑定公开模型标识()
    {
        var publicId = "image-public-id";
        var rendered = new[]
        {
            Render(MapLogicalModelReferencePolicy.BuildVisualPolicyFilter(publicId)),
            Render(MapLogicalModelReferencePolicy.BuildAgentApiKeyReferenceFilter(publicId)),
            Render(MapLogicalModelReferencePolicy.BuildInFlightImageRunFilter(publicId)),
        };

        Assert.All(rendered, filter => Assert.Contains(publicId, filter));
        Assert.Contains(MapLogicalModelReferencePolicy.VisualPolicyDefaultField, rendered[0]);
        Assert.Contains(MapLogicalModelReferencePolicy.AgentKeyFixedModelField, rendered[1]);
        Assert.Contains(MapLogicalModelReferencePolicy.AgentKeyOpenApiChatModelsField, rendered[1]);
        Assert.Contains(MapLogicalModelReferencePolicy.AgentKeyOpenApiImageModelsField, rendered[1]);
        Assert.Contains(MapLogicalModelReferencePolicy.ImageRunLogicalModelField, rendered[2]);

        var console = ReadRepoFile("llmgw/console-api/Program.cs");
        Assert.Contains("MapLogicalModelReferencePolicy.BuildVisualPolicyFilter", console);
        Assert.Contains("MapLogicalModelReferencePolicy.BuildAgentApiKeyReferenceFilter", console);
        Assert.Contains("MapLogicalModelReferencePolicy.BuildInFlightImageRunFilter", console);
        Assert.Contains("MODEL_REFERENCED_BY_MAP", console);
    }

}
