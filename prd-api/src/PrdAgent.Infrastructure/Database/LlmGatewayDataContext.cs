using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// LLM Gateway 自有数据域：appCaller、路由配置、模型池、请求日志和操作审计写入 llm_gateway。
/// MAP 主 MongoDbContext 只保留业务数据。
/// </summary>
public sealed class LlmGatewayDataContext
{
    /// <param name="llmRequestLogTenantId">
    /// MAP 进程传内部租户 ID：网关库的请求日志由全部租户共用，MAP 只能看、改、删自己那一份。
    /// serving 与控制台要处理全部租户，不传。
    /// </param>
    public LlmGatewayDataContext(string connectionString, string databaseName, string? llmRequestLogTenantId = null)
    {
        DatabaseName = string.IsNullOrWhiteSpace(databaseName) ? "llm_gateway" : databaseName;
        Context = new MongoDbContext(connectionString, DatabaseName, llmRequestLogTenantId: llmRequestLogTenantId);
    }

    public string DatabaseName { get; }

    public MongoDbContext Context { get; }

    public IMongoDatabase Database => Context.Database;

    public IMongoCollection<LlmRequestLog> LlmRequestLogs => Context.LlmRequestLogs;
}
