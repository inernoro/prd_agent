using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文学工作区公开意图的权威判定。新 MCP 工作区直接持久化标记；存量工作区只在
/// MCP 调用账本或开放接口请求日志能精确证明来源时回填，禁止靠标题或内容猜测。
/// </summary>
public static class LiteraryWorkspacePublicationPolicy
{
    public const string ManualTrigger = "manual";
    public const string AutoTrigger = "auto";
    private const string CreateWorkspaceTool = "map_literary_create_workspace";
    private const string CreateWorkspacePath = "/api/open/literary/workspaces";

    public static async Task<bool> ResolveSuppressAutoSubmitAsync(
        MongoDbContext db,
        ImageMasterWorkspace workspace,
        CancellationToken ct)
    {
        if (workspace.SuppressAutoSubmit) return true;

        var hasMcpArtifact = await db.McpCallLogs.CountDocumentsAsync(
            x => x.OwnerUserId == workspace.OwnerUserId
                 && x.ToolName == CreateWorkspaceTool
                 && x.Status == "success"
                 && x.ArtifactKind == "workspace"
                 && x.ArtifactId == workspace.Id,
            cancellationToken: ct) > 0;

        var hasOpenApiCreation = false;
        if (!hasMcpArtifact)
        {
            var escapedId = Regex.Escape(workspace.Id);
            var responseFilter = Builders<ApiRequestLog>.Filter.Regex(
                x => x.ResponseBody,
                new BsonRegularExpression($"\\\"workspaceId\\\"\\s*:\\s*\\\"{escapedId}\\\"", "i"));
            var auditFilter = Builders<ApiRequestLog>.Filter.Eq(x => x.UserId, workspace.OwnerUserId)
                & Builders<ApiRequestLog>.Filter.Eq(x => x.Method, "POST")
                & Builders<ApiRequestLog>.Filter.Eq(x => x.Path, CreateWorkspacePath)
                & Builders<ApiRequestLog>.Filter.Gte(x => x.StatusCode, 200)
                & Builders<ApiRequestLog>.Filter.Lt(x => x.StatusCode, 300)
                & responseFilter;
            hasOpenApiCreation = await db.ApiRequestLogs.CountDocumentsAsync(
                auditFilter,
                cancellationToken: ct) > 0;
        }

        if (!hasMcpArtifact && !hasOpenApiCreation) return false;

        await db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == workspace.Id && !x.SuppressAutoSubmit,
            Builders<ImageMasterWorkspace>.Update.Set(x => x.SuppressAutoSubmit, true),
            cancellationToken: CancellationToken.None);
        workspace.SuppressAutoSubmit = true;
        return true;
    }

    public static string NormalizeTrigger(string? trigger)
        => (trigger ?? string.Empty).Trim().ToLowerInvariant();

    public static bool IsKnownTrigger(string trigger)
        => trigger.Length == 0 || trigger is ManualTrigger or AutoTrigger;

    public static bool IsExplicitManualTrigger(string trigger)
        => trigger == ManualTrigger;
}
