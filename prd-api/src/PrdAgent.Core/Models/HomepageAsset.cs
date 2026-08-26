using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 首页资源（登陆后首页四张快捷卡背景 + 每个 Agent 的封面图/视频）。
///
/// Slot 命名约定（点号分层）：
/// - 卡片背景：`card.marketplace` / `card.library` / `card.showcase` / `card.updates`
/// - Agent 封面图：`agent.{agentKey}.image`（如 `agent.prd-agent.image`）
/// - Agent 封面视频：`agent.{agentKey}.video`（如 `agent.prd-agent.video`）
///
/// COS 对象路径：`icon/homepage/{slot 中的 . 替换为 /}.{ext}`
/// 例如 `agent.prd-agent.image` → `icon/homepage/agent/prd-agent/image.png`。
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class HomepageAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>业务槽位（全小写，格式 `^[a-z0-9][a-z0-9._\-]{0,127}$`），唯一键</summary>
    public string Slot { get; set; } = string.Empty;

    /// <summary>存储相对路径（COS 对象 key），如 `icon/homepage/card/marketplace.png`</summary>
    public string RelativePath { get; set; } = string.Empty;

    /// <summary>完整 CDN URL</summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>MIME 类型</summary>
    public string Mime { get; set; } = string.Empty;

    /// <summary>文件字节数</summary>
    public long SizeBytes { get; set; }

    /// <summary>上传者管理员 Id</summary>
    public string? CreatedByAdminId { get; set; }

    /// <summary>
    /// 生成这张图用的提示词（仅 AI 生成的槽位有值；手工上传的为 null）。
    ///
    /// 存在这里而不是另开一张表：提示词是「这张图怎么来的」，和图同生共死——
    /// 换图就该换提示词，删图就该一起删。管理端再次打开生成弹窗时用它回填，
    /// 让管理员在上次那版的基础上改，而不是每次从默认词重来。
    /// </summary>
    public string? Prompt { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
