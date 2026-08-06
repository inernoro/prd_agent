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
}
