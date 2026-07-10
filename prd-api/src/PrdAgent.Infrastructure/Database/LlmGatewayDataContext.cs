using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// LLM Gateway 自有数据域：appCaller、路由配置、模型池、请求日志、shadow 证据和操作审计写入 llm_gateway。
/// MAP 主 MongoDbContext 只保留业务数据与迁移期破玻璃回滚读取。
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
