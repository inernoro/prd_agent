using System.Reflection;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// MAP 读写网关日志集合时，每一次操作都必须带上内部租户条件：
/// 网关库里还有外部租户的日志，漏一处就是越权读取或越权删除。
/// 用一个记录调用的代理当内层集合，断言包装真正发出去的条件与管道。
/// </summary>
public class ScopedMongoCollectionTests
{
    private const string Tenant = "map-internal";

    [Fact]
    public void Find_Count_Delete_Update_AllCarryTenantFilter()
    {
        var (scoped, calls) = Create();
        var byId = Builders<LlmRequestLog>.Filter.Eq(x => x.Id, "log-1");

        _ = scoped.FindAsync(byId);
        _ = scoped.CountDocumentsAsync(Builders<LlmRequestLog>.Filter.Empty);
        _ = scoped.DeleteManyAsync(Builders<LlmRequestLog>.Filter.Empty);
        _ = scoped.UpdateOneAsync(byId, Builders<LlmRequestLog>.Update.Set(x => x.Status, "succeeded"));
        _ = scoped.DistinctAsync<string>("Model", Builders<LlmRequestLog>.Filter.Empty);

        Assert.Equal(new[] { "FindAsync", "CountDocumentsAsync", "DeleteManyAsync", "UpdateOneAsync", "DistinctAsync" },
            calls.Select(c => c.Method));
        foreach (var call in calls)
        {
            var filter = call.Args.OfType<FilterDefinition<LlmRequestLog>>().Single();
            Assert.Contains($"\"TenantId\" : \"{Tenant}\"", RenderFilter(filter));
        }
        Assert.Contains("\"_id\" : \"log-1\"", RenderFilter(calls[0].Args.OfType<FilterDefinition<LlmRequestLog>>().Single()));
    }

    [Fact]
    public void Aggregate_PrependsTenantMatchAsFirstStage()
    {
        var (scoped, calls) = Create();
        var pipeline = PipelineDefinition<LlmRequestLog, BsonDocument>.Create(
            new[] { BsonDocument.Parse("{ \"$group\" : { \"_id\" : \"$Model\", \"n\" : { \"$sum\" : 1 } } }") });

        _ = scoped.AggregateAsync(pipeline);

        var sent = Assert.Single(calls).Args.OfType<PipelineDefinition<LlmRequestLog, BsonDocument>>().SingleOrDefault()
                   ?? throw new Xunit.Sdk.XunitException("聚合没有发出管道");
        var stages = sent.Render(new RenderArgs<LlmRequestLog>(
            BsonSerializer.SerializerRegistry.GetSerializer<LlmRequestLog>(),
            BsonSerializer.SerializerRegistry)).Documents;
        Assert.Equal($"{{ \"$match\" : {{ \"TenantId\" : \"{Tenant}\" }} }}", stages[0].ToJson());
        Assert.Contains("$group", stages[1].ToJson());
    }

    [Fact]
    public void FluentFind_RoutesThroughScopedFilter()
    {
        var (scoped, calls) = Create();

        // 代理不返回游标，ToList 会在拿到空游标时抛参数异常；这里只关心发出去的条件。
        Assert.ThrowsAny<ArgumentException>(() => scoped.Find(x => x.Status == "failed").ToList());

        var filter = Assert.Single(calls).Args.OfType<FilterDefinition<LlmRequestLog>>().Single();
        var rendered = RenderFilter(filter);
        Assert.Contains($"\"TenantId\" : \"{Tenant}\"", rendered);
        Assert.Contains("\"Status\" : \"failed\"", rendered);
    }

    [Fact]
    public void UnscopableOperations_Throw()
    {
        var (scoped, calls) = Create();

        Assert.Throws<NotSupportedException>(() => scoped.BulkWrite(Array.Empty<WriteModel<LlmRequestLog>>()));
        Assert.Throws<NotSupportedException>(() => scoped.Watch(new EmptyPipelineDefinition<ChangeStreamDocument<LlmRequestLog>>()));
        Assert.Throws<NotSupportedException>(() => scoped.OfType<LlmRequestLog>());
        Assert.Empty(calls);
    }

    [Fact]
    public void MongoDbContext_ScopesLogsOnlyWhenTenantGiven()
    {
        var map = new MongoDbContext("mongodb://localhost:27017", "prdagent", "llm_gateway", llmRequestLogTenantId: Tenant);
        var scoped = Assert.IsType<ScopedMongoCollection<LlmRequestLog>>(map.LlmRequestLogs);
        Assert.Contains($"\"TenantId\" : \"{Tenant}\"", RenderFilter(scoped.Scope));
        Assert.Equal("llm_gateway", map.LlmRequestLogs.Database.DatabaseNamespace.DatabaseName);

        // MAP 进程里的网关数据上下文（手机看板、设计审计、视觉生图健康探针在用）同样限定内部租户。
        var mapGateway = new LlmGatewayDataContext("mongodb://localhost:27017", "llm_gateway", Tenant);
        Assert.IsType<ScopedMongoCollection<LlmRequestLog>>(mapGateway.LlmRequestLogs);

        // serving 要写全部租户的日志，不传租户就必须是原始集合。
        Assert.IsNotType<ScopedMongoCollection<LlmRequestLog>>(new LlmGatewayDataContext("mongodb://localhost:27017", "llm_gateway").LlmRequestLogs);
        var serving = new MongoDbContext("mongodb://localhost:27017", "llm_gateway");
        Assert.IsNotType<ScopedMongoCollection<LlmRequestLog>>(serving.LlmRequestLogs);
    }

    private static string RenderFilter(FilterDefinition<LlmRequestLog> filter) =>
        filter.Render(new RenderArgs<LlmRequestLog>(
            BsonSerializer.SerializerRegistry.GetSerializer<LlmRequestLog>(),
            BsonSerializer.SerializerRegistry)).ToJson();

    private static (ScopedMongoCollection<LlmRequestLog> Scoped, List<RecordedCall> Calls) Create()
    {
        // 触发 BSON 映射注册，与生产渲染口径一致。
        _ = new MongoDbContext("mongodb://localhost:27017", "prdagent");
        var calls = new List<RecordedCall>();
        var inner = DispatchProxy.Create<IMongoCollection<LlmRequestLog>, RecordingProxy>();
        ((RecordingProxy)(object)inner).Calls = calls;
        var scoped = new ScopedMongoCollection<LlmRequestLog>(inner, Builders<LlmRequestLog>.Filter.Eq(x => x.TenantId, Tenant));
        return (scoped, calls);
    }

    public sealed record RecordedCall(string Method, object?[] Args);

    public class RecordingProxy : DispatchProxy
    {
        public List<RecordedCall> Calls { get; set; } = new();

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod is null) return null;
            if (targetMethod.Name == "get_DocumentSerializer") return BsonSerializer.SerializerRegistry.GetSerializer<LlmRequestLog>();
            if (targetMethod.Name == "get_Settings") return new MongoCollectionSettings();
            if (targetMethod.Name.StartsWith("get_", StringComparison.Ordinal)) return null;
            Calls.Add(new RecordedCall(targetMethod.Name, args ?? Array.Empty<object?>()));
            return null;
        }
    }
}
