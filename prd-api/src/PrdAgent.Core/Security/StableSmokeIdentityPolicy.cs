namespace PrdAgent.Core.Security;

/// <summary>
/// 稳定冒烟巡检身份的权限契约（SSOT）。
///
/// 48 小时稳定冒烟矩阵要以专用合成账号（如 <c>stsmk_cds</c>）走完录音、文件、短视频、
/// 视觉创作、网页托管以及「创建受限用户并隔离」这些旅程。2026-09-14 那一轮 32 项失败里，
/// 录音全线、大文件进度、非法短视频链接（403 而非 400）和会话权限用例的共同外因只有一个：
/// 签名认证自动开号时给的是面向真人的「Agent 体验者」角色，它没有文档空间和用户管理权限，
/// 于是每一条写路径都在业务动作之前被权限中间件以「无权限」挡下。
///
/// 这份清单把「巡检账号必须持有什么」写成代码而不是口头约定：
/// 认证处理器按它开号、按它补齐存量账号，单测按它核对每个被矩阵触达的控制器所需权限，
/// e2e 侧的同名夹具由跨语言契约测试钉住，三者只能一起变。
/// </summary>
public static class StableSmokeIdentityPolicy
{
    /// <summary>自动开号沿用的内置角色：面向 Agent 体验者，本身不含管理类权限。</summary>
    public const string ProvisionedSystemRoleKey = "agent_tester";

    /// <summary>
    /// 矩阵所需权限。每一行都对应 <c>.claude/skills/stable-smoke/reference/test-matrix.md</c> 里的一个模块。
    /// 新增矩阵模块触达新的 <c>[AdminController]</c> 时在这里追加，并同步 e2e 夹具。
    /// </summary>
    public static readonly IReadOnlyList<string> RequiredPermissions = new[]
    {
        // 所有管理接口的总闸
        AdminPermissionCatalog.Access,
        // 00 基础设施与身份：CORE-002/003 创建受限用户、改授权、回收会话、回读删除
        AdminPermissionCatalog.UsersRead,
        AdminPermissionCatalog.UsersWrite,
        AdminPermissionCatalog.AuthzManage,
        // 01 录音 / 02 文件解析 / 03 短视频：文档空间、录音分片、短视频素材都挂在 document-store 权限上
        AdminPermissionCatalog.DocumentStoreRead,
        AdminPermissionCatalog.DocumentStoreWrite,
        // 01 录音转写任务状态：/api/transcript-agent 归 AI 百宝箱
        AdminPermissionCatalog.AiToolboxUse,
        // 04 视频创作
        AdminPermissionCatalog.VideoAgentUse,
        // 05 文学创作
        AdminPermissionCatalog.LiteraryAgentUse,
        // 06/07 视觉创作：任务、工作区、产物；adapter-info 与业务模型策略只读
        AdminPermissionCatalog.VisualAgentUse,
        AdminPermissionCatalog.SettingsRead,
        // 09 网页托管与分享
        AdminPermissionCatalog.WebPagesRead,
        AdminPermissionCatalog.WebPagesWrite,
    };

    /// <summary>
    /// 给定账号当前生效的权限，算出矩阵还缺哪些。返回空即无需补齐。
    /// 顺序保持与 <see cref="RequiredPermissions"/> 一致，便于日志与报告稳定可读。
    /// </summary>
    public static IReadOnlyList<string> MissingPermissions(IEnumerable<string>? effectivePermissions)
    {
        var effective = new HashSet<string>(
            (effectivePermissions ?? Array.Empty<string>())
                .Select(item => (item ?? string.Empty).Trim())
                .Where(item => item.Length > 0),
            StringComparer.Ordinal);
        if (effective.Contains(AdminPermissionCatalog.Super)) return Array.Empty<string>();
        return RequiredPermissions.Where(item => !effective.Contains(item)).ToList();
    }
}
