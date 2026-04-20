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

    /// <summary>图标（emoji）</summary>
    public string IconEmoji { get; set; } = "🧩";

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
