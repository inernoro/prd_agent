namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// 系统资产清单：列举所有「不在 MongoDB 中但系统运行必须」的静态文件。
/// 这些文件通常是手动上传到对象存储的，不经过 SaveAsync，因此 asset_registry 中没有记录。
///
/// 用途：
/// 1. 切换存储 Provider 时，用 SystemAssetSyncService 一键从旧 Provider 同步到新 Provider
/// 2. 部署全新系统实例时，确保所有系统图标到位
/// 3. 健康检查：验证系统必需文件是否存在
/// </summary>
public static class SystemAssetManifest
{
    /// <summary>默认头像和机器人头像</summary>
    public static readonly string[] Avatars =
    {
        "icon/backups/head/nohead.png",
        "icon/backups/head/bot_pm.gif",
        "icon/backups/head/bot_dev.gif",
        "icon/backups/head/bot_qa.gif",
    };

    /// <summary>Agent 封面图（首页/启动器/百宝箱展示）</summary>
    public static readonly string[] AgentCovers =
    {
        "icon/backups/agent/prd-agent.png",
        "icon/backups/agent/visual-agent.png",
        "icon/backups/agent/literary-agent.png",
        "icon/backups/agent/defect-agent.png",
        "icon/backups/agent/video-agent.png",
        "icon/backups/agent/report-agent.png",
        "icon/backups/agent/arena.png",
        "icon/backups/agent/shortcuts-agent.png",
        "icon/backups/agent/workflow-agent.png",
    };

    /// <summary>Agent 视频（首页/百宝箱动效）</summary>
    public static readonly string[] AgentVideos =
    {
        "icon/backups/agent/prd-agent.mp4",
        "icon/backups/agent/visual-agent.mp4",
        "icon/backups/agent/literary-agent.mp4",
        "icon/backups/agent/defect-agent.mp4",
        "icon/backups/agent/video-agent.mp4",
        "icon/backups/agent/report-agent.mp4",
        "icon/backups/agent/arena.mp4",
        "icon/backups/agent/shortcuts-agent.mp4",
        "icon/backups/agent/workflow-agent.mp4",
    };

    /// <summary>全局 UI 元素（favicon、首页标题图等）</summary>
    public static readonly string[] GlobalUI =
    {
        "favicon.png",
        "icon/title/home.png",
    };

    /// <summary>桌面端启动动画</summary>
    public static readonly string[] DesktopLoading =
    {
        "icon/desktop/load.gif",
        "icon/desktop/start_load.gif",
    };

    /// <summary>获取所有系统资产路径（完整清单）</summary>
    public static IEnumerable<string> All()
    {
        foreach (var p in Avatars) yield return p;
        foreach (var p in AgentCovers) yield return p;
        foreach (var p in AgentVideos) yield return p;
        foreach (var p in GlobalUI) yield return p;
        foreach (var p in DesktopLoading) yield return p;
    }

    /// <summary>总数</summary>
    public static int Count => Avatars.Length + AgentCovers.Length + AgentVideos.Length + GlobalUI.Length + DesktopLoading.Length;
}
