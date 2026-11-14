using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

/// <summary>显式单篇入库。由已有对话 Run/Worker 执行，不在搜索或启动时自动重建。</summary>
public sealed class KbIndexTool(MongoDbContext db, IServiceScopeFactory scopeFactory) : IAgentTool
{
    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "kb_index",
        Description = "仅在用户明确要求时，为本人拥有的指定单篇知识库文档建立检索索引。复用模型网关，不遍历全库；缺模型、正文过大或文档变化时明确失败。",
        InputSchemaJson = """
        {
          "type": "object",
          "required": ["entryId"],
          "properties": {
            "entryId": { "type": "string", "description": "用户明确指定的单篇知识库条目 ID。不得自动遍历列表建立索引。" }
          },
          "additionalProperties": false
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(JsonElement input, AgentToolInvocationContext context, CancellationToken ct)
    {
        var userId = await KnowledgeBaseReadonlyToolSupport.ResolveUserIdAsync(db, context, ct);
        if (userId == null)
            return AgentToolInvokeResult.Fail("kb_user_context_required", "建立检索索引需要明确的用户身份");
        var entryId = KnowledgeBaseReadonlyToolSupport.GetString(input, "entryId");
        if (string.IsNullOrWhiteSpace(entryId))
            return AgentToolInvokeResult.Fail("kb_entry_id_required", "请指定一篇文档");
        using var scope = scopeFactory.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<KnowledgeRetrievalService>()
            .IndexEntryAsync(entryId, userId, ct);
    }
}
