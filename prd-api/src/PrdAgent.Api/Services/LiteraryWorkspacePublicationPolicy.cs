using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文学工作区公开意图的权威判定。新 MCP 工作区直接持久化标记；存量工作区只在
/// MCP 调用账本或直连工具审计能可靠证明来源时回填，禁止靠标题或内容猜测。
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
        if (!string.Equals(workspace.ScenarioType, "article-illustration", StringComparison.Ordinal))
            return false;
        if (workspace.SuppressAutoSubmit) return true;

        var hasMcpArtifact = await db.McpCallLogs.CountDocumentsAsync(
            x => x.OwnerUserId == workspace.OwnerUserId
                 && x.ToolName == CreateWorkspaceTool
                 && x.Status == "success"
                 && x.ArtifactKind == "workspace"
                 && x.ArtifactId == workspace.Id,
            cancellationToken: ct) > 0;

        var hasOpenApiCreation = !hasMcpArtifact
            && await HasTrustedDirectCreationAuditAsync(db, workspace, ct);

        if (!hasMcpArtifact && !hasOpenApiCreation) return false;

        await db.ImageMasterWorkspaces.UpdateOneAsync(
            x => x.Id == workspace.Id && !x.SuppressAutoSubmit,
            Builders<ImageMasterWorkspace>.Update.Set(x => x.SuppressAutoSubmit, true),
            cancellationToken: CancellationToken.None);
        workspace.SuppressAutoSubmit = true;
        return true;
    }

    public static async Task<HashSet<string>> ResolveProtectedWorkspaceIdsAsync(
        MongoDbContext db,
        IEnumerable<string?> workspaceIds,
        CancellationToken ct)
    {
        var ids = workspaceIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (ids.Length == 0) return [];

        var workspaces = await db.ImageMasterWorkspaces
            .Find(x => ids.Contains(x.Id))
            .ToListAsync(ct);
        var protectedIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var workspace in workspaces)
        {
            if (await ResolveSuppressAutoSubmitAsync(db, workspace, ct))
                protectedIds.Add(workspace.Id);
        }
        return protectedIds;
    }

    public static string NormalizeTrigger(string? trigger)
        => (trigger ?? string.Empty).Trim().ToLowerInvariant();

    public static bool IsKnownTrigger(string trigger)
        => trigger.Length == 0 || trigger is ManualTrigger or AutoTrigger;

    public static bool IsExplicitManualTrigger(string trigger)
        => trigger == ManualTrigger;

    private static async Task<bool> HasTrustedDirectCreationAuditAsync(
        MongoDbContext db,
        ImageMasterWorkspace workspace,
        CancellationToken ct)
    {
        // /api/open 路径的请求、响应 body 按安全规则永不落库，不能从 ApiRequestLog.ResponseBody
        // 恢复 workspaceId。直连 sk-ak 请求仍会留下 McpCallLog：包含精确工具、主人、路径、
        // 调用开始时间和持续时间。只有当前工作区是该调用窗口内唯一创建的文学工作区时才回填，
        // 并发或证据不完整一律保持 false，禁止把普通网页工作区猜成 MCP 工作区。
        var lowerBound = workspace.CreatedAt.AddMinutes(-1);
        var candidates = await db.McpCallLogs.Find(x =>
                x.OwnerUserId == workspace.OwnerUserId
                && x.ToolName == CreateWorkspaceTool
                && x.Status == "success"
                && x.HttpStatus >= 200
                && x.HttpStatus < 300
                && x.KeyId != string.Empty
                && x.ArgumentsPreview == $"直连 POST {CreateWorkspacePath}"
                && x.CreatedAt >= lowerBound
                && x.CreatedAt <= workspace.CreatedAt)
            .SortByDescending(x => x.CreatedAt)
            .Limit(10)
            .ToListAsync(ct);

        foreach (var audit in candidates)
        {
            // DurationMs 是整数毫秒；加 1 秒仅吸收截断和落库调度误差，后面的唯一性检查
            // 会阻止同一窗口内的普通网页创建被误认。
            var windowEnd = audit.CreatedAt.AddMilliseconds(Math.Max(audit.DurationMs, 0) + 1000);
            if (workspace.CreatedAt > windowEnd) continue;

            var createdInWindow = await db.ImageMasterWorkspaces.CountDocumentsAsync(
                x => x.OwnerUserId == workspace.OwnerUserId
                     && x.ScenarioType == "article-illustration"
                     && x.CreatedAt >= audit.CreatedAt
                     && x.CreatedAt <= windowEnd,
                cancellationToken: ct);
            if (createdInWindow == 1) return true;
        }

        return false;
    }
}
