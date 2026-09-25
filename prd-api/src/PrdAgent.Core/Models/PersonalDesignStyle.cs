using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 「我的风格」：用户自己的一套网页生成风格，只属于创建它的人（不共享、不上市场）。
///
/// 与管理员的 <see cref="DesignStylePreset"/> 是同一类东西——一段风格说明 + 一个 OpenDesign 设计系统骨架——
/// 区别只在归属：预设挂在全局设置单例上，这里每人一份、每人最多 <see cref="MaxPerUser"/> 套。
/// 生成时服务端按 Id + 归属人取出并冻结进运行（StyleId = <see cref="StyleIdPrefix"/> + Id），
/// 从不信任前端传来的风格正文。
/// </summary>
[BsonIgnoreExtraElements]
public class PersonalDesignStyle
{
    /// <summary>运行里记录的 StyleId 前缀：与预设编号（小写字母数字连字符）和目录风格前缀 design-system: 都分得开。</summary>
    public const string StyleIdPrefix = "personal:";

    /// <summary>每人最多保存的套数。</summary>
    public const int MaxPerUser = 20;

    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>归属人。读、写、删、用于生成都只认这个人。</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 风格说明：生成时原样交给执行器——直连执行器拿它当「视觉风格」，OpenDesign 执行器把它接在创作提示词后面。
    /// </summary>
    public string Instruction { get; set; } = string.Empty;

    /// <summary>画廊上的三枚色块 [ink, paper, accent]（#rrggbb）；按描述建的风格没有真实颜色，就是空的，不编一组。</summary>
    public List<string> Swatches { get; set; } = new();

    /// <summary>标题 / 正文字体（CSS font-family 里的第一个族名），只用于展示。</summary>
    public List<string> Fonts { get; set; } = new();

    /// <summary>OpenDesign 设计系统骨架（/app/design-systems/&lt;id&gt;）；OpenDesign 执行器必须有一个。</summary>
    public string BaseDesignSystemId { get; set; } = string.Empty;

    /// <summary>从哪张自己的网页提取的（只作来源说明，生成时不再读那张网页）。</summary>
    public string? SourceSiteId { get; set; }

    public string? SourceSiteTitle { get; set; }

    /// <summary>用户创建时贴的那段描述。</summary>
    public string? SourceNote { get; set; }

    /// <summary>
    /// 创建时由系统填写、保存时用户没有改动过的字段（name / instruction / swatches / fonts / baseDesignSystemId），
    /// 用来在界面上标出「这一项是系统填的」。
    /// </summary>
    public List<string> SystemFilledFields { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
