using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// LLM Gateway 自有数据域：GW serving 请求日志、shadow 证据、后续操作审计写入 llm_gateway。
/// MAP 业务数据和模型配置仍使用主 MongoDbContext（通常是 prdagent）。
/// </summary>
public sealed class LlmGatewayDataContext
{
    public LlmGatewayDataContext(string connectionString, string databaseName)
    {
        DatabaseName = string.IsNullOrWhiteSpace(databaseName) ? "llm_gateway" : databaseName;
        Context = new MongoDbContext(connectionString, DatabaseName);
    }

    public string DatabaseName { get; }

    public MongoDbContext Context { get; }

    public IMongoDatabase Database => Context.Database;

    public IMongoCollection<LlmRequestLog> LlmRequestLogs => Context.LlmRequestLogs;

    public IMongoCollection<LlmShadowComparison> LlmShadowComparisons => Context.LlmShadowComparisons;
}
