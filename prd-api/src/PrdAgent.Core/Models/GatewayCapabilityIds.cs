namespace PrdAgent.Core.Models;

/// <summary>
/// 网关对外发布的通用能力标识。
///
/// 主系统只认这些稳定标识，不感知上游厂商、Exchange 或具体模型——换上游不改这里。
/// 单独成文件是因为它已经有两个调用方（同步生图端点与异步任务创建端点），
/// 各自抄一份私有常量迟早会漂移。
/// </summary>
public static class GatewayCapabilityIds
{
    /// <summary>把一张图拆成多个可独立编辑的透明图层。</summary>
    public const string ImageLayering = "image-layering";

    /// <summary>
    /// 「只能被具体动作调用」的能力标记（逻辑模型 Capabilities 数组里的 token，snake_case）。
    ///
    /// 注意与 PublicId 的命名不是一套：PublicId 是 kebab-case（image-layering），
    /// Capabilities 里的 token 是 snake_case（image_layering）。判定必须两个都认，
    /// 否则换个数据来源就漏判。
    /// </summary>
    private static readonly HashSet<string> OperationOnlyCapabilityTokens = new(StringComparer.OrdinalIgnoreCase)
    {
        "image_layering",
        "image-layering",
    };

    /// <summary>这些 PublicId 本身就代表一个动作，不是用户可挑的生图模型。</summary>
    private static readonly HashSet<string> OperationOnlyPublicIds = new(StringComparer.OrdinalIgnoreCase)
    {
        ImageLayering,
    };

    /// <summary>
    /// 判断某个逻辑模型是「用户可以在选择器里挑的生图模型」还是「只能被动作调用的能力」。
    ///
    /// 分层就是后者：它需要一张输入图、不吃提示词、也没有尺寸概念，
    /// 混进「选择模型」列表会让用户以为选了它就能生图。这类能力只允许由
    /// 快捷栏的具体动作按 PublicId 直接点名调用。
    ///
    /// 两个信号都认（PublicId 与 Capabilities），因为不同数据来源填的字段不一样：
    /// 只认其中一个，换条路进来就漏。判定只此一处，禁止在 Controller 里再写一遍。
    /// </summary>
    public static bool IsOperationOnly(string? publicId, IEnumerable<string>? capabilities)
    {
        var id = (publicId ?? string.Empty).Trim();
        if (id.Length > 0 && OperationOnlyPublicIds.Contains(id)) return true;

        if (capabilities is null) return false;
        foreach (var capability in capabilities)
        {
            var token = (capability ?? string.Empty).Trim();
            if (token.Length > 0 && OperationOnlyCapabilityTokens.Contains(token)) return true;
        }
        return false;
    }
}
