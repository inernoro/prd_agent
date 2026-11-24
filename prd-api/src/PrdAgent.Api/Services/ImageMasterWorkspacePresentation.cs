namespace PrdAgent.Api.Services;

/// <summary>
/// 视觉创作与文学创作共用 image_master_workspaces 集合时的展示与路由唯一判据。
/// 所有首页聚合、最近打开台账和详情打点都必须从 ScenarioType 推导应用身份，
/// 不能相信历史台账里可能已经写错的 AgentKey。
/// </summary>
internal static class ImageMasterWorkspacePresentation
{
    internal const string LiteraryScenarioType = "article-illustration";

    internal sealed record Target(
        string AgentKey,
        string FeedType,
        string Subtitle,
        string Route);

    internal static Target Resolve(string workspaceId, string? scenarioType)
        => string.Equals(scenarioType, LiteraryScenarioType, StringComparison.Ordinal)
            ? new("literary-agent", "literary-workspace", "文学创作", $"/literary-agent/{workspaceId}")
            : new("visual-agent", "visual-workspace", "视觉创作", $"/visual-agent/{workspaceId}");
}
