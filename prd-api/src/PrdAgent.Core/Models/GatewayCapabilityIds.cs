namespace PrdAgent.Core.Models;

/// <summary>
/// 网关对外发布的通用能力标识。
///
/// 主系统只认这些稳定标识，不感知上游厂商、Exchange 或具体模型——换上游不改这里。
/// 单独成文件是因为它已经有两个调用方（同步生图端点与异步任务创建端点），
/// 各自抄一份私有常量迟早会漂移。
///
/// 2026-08-17 起「什么算动作能力」的判据下沉到 <see cref="GatewayCapabilityContract"/>，
/// 本类只保留 PublicId 常量与转发入口：能力词汇表只允许有一份。
/// </summary>
public static class GatewayCapabilityIds
{
    /// <summary>把一张图拆成多个可独立编辑的透明图层。</summary>
    public const string ImageLayering = GatewayCapabilityContract.ImageLayeringPublicId;

    /// <summary>
    /// 判断某个逻辑模型是「用户可以在选择器里挑的生图模型」还是「只能被动作调用的能力」。
    ///
    /// 分层就是后者：它需要一张输入图、不吃提示词、也没有尺寸概念，
    /// 混进「选择模型」列表会让用户以为选了它就能生图。这类能力只允许由
    /// 快捷栏的具体动作按 PublicId 直接点名调用。
    ///
    /// 实现转发到能力契约：PublicId 与 Capabilities 两个信号都认，
    /// 且 Capabilities 会先经历史别名归一，换条数据来源也不会漏判。
    /// </summary>
    public static bool IsOperationOnly(string? publicId, IEnumerable<string>? capabilities)
        => GatewayCapabilityContract.IsOperationOnly(publicId, capabilities);
}
