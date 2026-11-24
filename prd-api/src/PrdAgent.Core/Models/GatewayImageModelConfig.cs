namespace PrdAgent.Core.Models;

/// <summary>
/// 生图模型的尺寸与参数契约——**可以在控制台里改，不用改代码、不用发布**。
///
/// 为什么有这个实体：`ImageGenModelConfigs.cs` 里躺着 26 条、777 行写死的模型契约
/// （尺寸档位、参数格式、重命名映射、能不能图生图）。上游每出一个新生图模型就要改那个文件、
/// 重新编译、走一次发布——这是「上游动一下、我们发一次版」的典型形态，也是本仓库
/// `minimal-user-input` 规则反对的那件事在运维侧的翻版。
///
/// 这份实体把同一套契约搬进数据。合并规则只有一条：
/// **同一个匹配模式，数据赢；数据里没有的，回落到代码内置那 26 条。**
/// 所以它是纯增量的——库里一行都没有时，行为与今天逐字节相同；删掉数据行就回到代码。
///
/// 判定入口仍然只有 <c>ImageGenModelAdapterRegistry.TryMatch</c> 一个，合并发生在它内部。
/// 谁都不许绕过它去直接遍历 <c>ImageGenModelConfigs.Configs</c>
/// （守卫：`ImageGenConfigOverrideGuardTests`），否则判据就分裂成两份了
/// （predicate-and-wiring-discipline 形状 3）。
/// </summary>
public sealed class GatewayImageModelConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 模型名匹配模式，与代码内置表同一套语法：支持结尾通配 `*`，如 `nano-banana-2*`。
    ///
    /// 与代码表相同的坑：**越具体的模式必须排在越前面**，否则 `nano-banana*` 会先吃掉
    /// 所有 `nano-banana-2-*` 的输入。这里靠 <see cref="MatchOrder"/> 显式排序，
    /// 不靠书写顺序——数据行没有「书写顺序」可言。
    /// </summary>
    public string ModelIdPattern { get; set; } = string.Empty;

    /// <summary>
    /// 匹配顺序，小的先匹配。留出档位（建议 10/20/30）方便中间插入。
    /// 同序时按 <see cref="ModelIdPattern"/> 长度降序——长的更具体，这条兜底规则让
    /// 忘记设 MatchOrder 的两行也不会随机胜出。
    /// </summary>
    public int MatchOrder { get; set; } = 100;

    /// <summary>租户隔离。空串表示平台内置，对所有租户生效。</summary>
    public string TenantId { get; set; } = string.Empty;

    /// <summary>停用这一行：立刻回落到代码内置那条（如果有）。比删除更适合排障。</summary>
    public bool Enabled { get; set; } = true;

    public string DisplayName { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;

    /// <summary>平台类型：openai / volces / 空（自动检测）。</summary>
    public string? PlatformType { get; set; }

    /// <summary>官方文档链接。填了它，下一个人核对契约时不用满世界找。</summary>
    public string? OfficialDocUrl { get; set; }

    /// <summary>尺寸约束类型：whitelist / range / aspect_ratio / adaptive。</summary>
    public string SizeConstraintType { get; set; } = "whitelist";

    public string SizeConstraintDescription { get; set; } = string.Empty;

    /// <summary>
    /// 按分辨率分组的尺寸档位：键是 1k / 2k / 4k，值是该档位下的尺寸列表。
    /// 尺寸写成 `宽x高`（如 `1024x1024`）；比例由宽高算出来，不单独存，免得两份对不上。
    /// </summary>
    public Dictionary<string, List<string>> SizesByResolution { get; set; } = new();

    /// <summary>
    /// 这个模型压根没有「选尺寸」这件事（如语义分层：输出图层继承输入画布）。
    /// 置 true 时 <see cref="SizesByResolution"/> 必须为空——编几个假尺寸出来，
    /// 选择器会展示这个模型根本不接受的选项。
    /// </summary>
    public bool SizesNotApplicable { get; set; }

    /// <summary>尺寸参数格式：WxH / {width,height} / aspect_ratio / none。</summary>
    public string SizeParamFormat { get; set; } = "WxH";

    /// <summary>保留原生尺寸字段的同时，把画布尺寸也写进 prompt 做语义兜底。</summary>
    public bool InjectSizePrompt { get; set; }

    public int? MustBeDivisibleBy { get; set; }
    public int? MaxWidth { get; set; }
    public int? MaxHeight { get; set; }
    public int? MinWidth { get; set; }
    public int? MinHeight { get; set; }
    public long? MaxPixels { get; set; }

    /// <summary>参数重命名映射，如 `model` → `model_name`。</summary>
    public Dictionary<string, string> ParamRenames { get; set; } = new();

    public bool RequiresResolutionParam { get; set; }
    public bool SupportsImageToImage { get; set; }
    public bool SupportsInpainting { get; set; }

    /// <summary>不带 response_format 字段（apiyi 等平台不接受它）。</summary>
    public bool SupportsResponseFormat { get; set; } = true;

    /// <summary>备注，一行一条。写给下一个来核对契约的人。</summary>
    public List<string> Notes { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>谁最后改的。排障时「这条尺寸是谁加的」要答得上来。</summary>
    public string? UpdatedBy { get; set; }
}
