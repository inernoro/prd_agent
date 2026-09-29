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
}
