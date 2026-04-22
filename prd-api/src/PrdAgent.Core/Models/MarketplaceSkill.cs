using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Models;

/// <summary>
/// 海鲜市场「技能」条目（用户上传的 zip 技能包）。
///
/// 当前形态：纯分享 / 下载（v1，不接执行引擎）。
/// 预留字段（ManifestVersion / EntryPoint / HasSkillMd）为未来接入执行体系打桩。
/// 独立集合 `marketplace_skills`；后续与 <see cref="Skill"/> 合并时写一次迁移脚本即可。
/// </summary>
public class MarketplaceSkill : IMarketplaceItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>技能名称（上传时用户填写，为空则用文件名）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>技能详情（用户填写 或 SKILL.md 自动提取 30 字摘要）</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>图标（emoji）— 无封面图时作为卡片兜底视觉</summary>
    public string IconEmoji { get; set; } = "🧩";

    /// <summary>封面图 CDN URL（上传后落 COS 拿到），空则卡片 fallback 到 IconEmoji</summary>
    public string? CoverImageUrl { get; set; }

    /// <summary>封面图 COS key（便于删除技能时回收）</summary>
    public string? CoverImageKey { get; set; }

    /// <summary>预览地址 — 用户对外展示技能效果的网页 URL（可为托管站点或外部 URL）</summary>
    public string? PreviewUrl { get; set; }

    /// <summary>预览地址来源：external | hosted_site；null 表示未提供</summary>
    public string? PreviewSource { get; set; }

    /// <summary>若 PreviewSource == hosted_site，关联的 HostedSite.Id（留存便于以后同步）</summary>
    public string? PreviewHostedSiteId { get; set; }

    /// <summary>用户自定义标签（任意字符串）</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>作者 userId（上传者）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>作者昵称（快照）</summary>
    public string AuthorName { get; set; } = string.Empty;

    /// <summary>作者头像文件名（快照，走 resolveAvatarUrl 拼全量 URL）</summary>
    public string? AuthorAvatar { get; set; }

    // === 文件元数据 ===

    /// <summary>COS / R2 对象 key（如 marketplace-skills/{id}/{filename}.zip）</summary>
    public string ZipKey { get; set; } = string.Empty;

    /// <summary>公开访问 URL（下载用）</summary>
    public string ZipUrl { get; set; } = string.Empty;

    /// <summary>文件大小（字节）</summary>
    public long ZipSizeBytes { get; set; }

    /// <summary>原始文件名（如 my-skill.zip）</summary>
    public string OriginalFileName { get; set; } = string.Empty;

    /// <summary>压缩包内是否存在 SKILL.md（供未来执行引擎快速判断）</summary>
    public bool HasSkillMd { get; set; }

    /// <summary>SKILL.md 内容预览（最多 2000 字，供未来执行引擎读取；当前仅做摘要）</summary>
    public string? SkillMdPreview { get; set; }

    /// <summary>Manifest 版本（预留：未来约定 skill.manifest.json 时使用）</summary>
    public string? ManifestVersion { get; set; }

    /// <summary>入口文件相对路径（预留，未来执行引擎用）</summary>
    public string? EntryPoint { get; set; }

    // === 社区数据 ===

    /// <summary>下载次数（对应 IMarketplaceItem.ForkCount 字段语义）</summary>
    public int DownloadCount { get; set; }

    /// <summary>收藏者 userId 列表</summary>
    public List<string> FavoritedByUserIds { get; set; } = new();

    // === P3 基础设施：Agent 开放接口引用 ===

    /// <summary>
    /// 条目类型：
    /// - `zip`（默认）：用户上传的技能 zip 包，ZipUrl / ZipKey 必填
    /// - `open-api-reference`：由 <see cref="AgentOpenEndpoint"/> 自动桥接出的"引用条目"。
    ///   Fork 不下载 zip，而是返回 Agent 开放接口调用示例 —— 这样用户在海鲜市场
    ///   也能发现 Agent 开放能力，而不是只有 zip 技能。
    /// </summary>
    public string ReferenceType { get; set; } = "zip";

    /// <summary>
    /// 当 ReferenceType == `open-api-reference` 时，指向关联的 AgentOpenEndpoint.Id。
    /// 该条目失效（Endpoint 删除 / 停用）时由桥接服务负责清理这条技能。
    /// </summary>
    public string? ReferenceEndpointId { get; set; }

    // === IMarketplaceItem 契约 ===

    public bool IsPublic { get; set; } = true;
    public int ForkCount { get; set; }
    public string? ForkedFromId { get; set; }
    public string? ForkedFromUserId { get; set; }
    public string? ForkedFromUserName { get; set; }
    public string? ForkedFromUserAvatar { get; set; }
    public bool IsModifiedAfterFork { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public string GetDisplayName() => Title;
    public string GetConfigType() => "skill";
    public string? GetOwnerUserId() => OwnerUserId;
    public void SetOwnerUserId(string userId) => OwnerUserId = userId;
}
