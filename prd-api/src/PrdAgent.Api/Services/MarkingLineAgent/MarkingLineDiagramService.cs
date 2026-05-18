using System.Text;
using PrdAgent.Api.Services.PrReview;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Services.MarkingLineAgent;

/// <summary>
/// 赋码产线：根据用户简述生成「工业示意」风格的产线/采集关联说明（Markdown，可含 Mermaid）。
/// </summary>
public sealed class MarkingLineDiagramService
{
    private const string AppCallerCode = AppCallerRegistry.MarkingLineAgent.Diagram.Stream;

    private readonly ILlmGateway _gateway;
    private readonly ILogger<MarkingLineDiagramService> _logger;

    public MarkingLineDiagramService(ILlmGateway gateway, ILogger<MarkingLineDiagramService> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    public async IAsyncEnumerable<LlmStreamDelta> StreamDiagramAsync(
        string userBrief,
        PrReviewModelInfoHolder modelInfo)
    {
        var trimmed = (userBrief ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
            throw new InvalidOperationException("请填写产线或工位描述");

        var systemPrompt = BuildSystemPrompt();
        var userContent = "用户需求与现场信息如下，请生成示意图说明：\n\n" + trimmed;

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerCode,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userContent },
                },
                ["temperature"] = 0.35,
                ["max_tokens"] = 4096,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
        };

        await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
            {
                modelInfo.Model = chunk.Resolution.ActualModel;
                modelInfo.Platform = chunk.Resolution.ActualPlatformName ?? chunk.Resolution.ActualPlatformId;
                modelInfo.ModelGroupName = chunk.Resolution.ModelGroupName;
                modelInfo.Captured = true;
                continue;
            }

            if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return new LlmStreamDelta(IsThinking: true, Content: chunk.Content!);
            }
            else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return new LlmStreamDelta(IsThinking: false, Content: chunk.Content!);
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                var msg = chunk.Error ?? chunk.Content ?? "LLM 网关未知错误";
                _logger.LogWarning("MarkingLineAgent diagram stream error: {Error}", msg);
                throw new InvalidOperationException(msg);
            }
        }
    }

    private static string BuildSystemPrompt()
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是产线工艺与赋码采集关联的制图说明助手。");
        sb.AppendLine("输出必须是 Markdown。禁止输出 emoji 或装饰性符号。");
        sb.AppendLine();
        sb.AppendLine("视觉与结构要求（对齐常见工业培训「白底产线总图」风格，类似瓶箱垛采集关联总流程培训图）：");
        sb.AppendLine("- 白底、留白充足；主流程从左到右一条线读完；有高度变化时写「爬坡 >>」、有水平走向时写「运行方向 >>」这类短标注（用纯文字表达，勿依赖真彩色）。");
        sb.AppendLine("- 设备块用符号化描述：灰色输送带分段、白色大型机壳（裹包机等）、黄色区域表示车间起点或剔除工位、浅蓝块表示电柜、棕/纸箱块表示已装箱产品；相机用工控相机小方块+镜头方向文字说明。");
        sb.AppendLine("- 侧视略带等距感：输送线可画成平行多通道后合并、再爬坡到高层，末端垛口与人工站位用文字标出。");
        sb.AppendLine("- 用简短中文标注工位（灌装车间、四通道、裹包机、龙门架、NC 剔除、共享屏幕、墙体、尾箱计数、箱码垛工位等），可用 `>` 或 ASCII 方框表示输送线分段。");
        sb.AppendLine("- 采集点写清「瓶码 / 箱码 / 尾箱计数 / 剔除校验」等，并注明工业相机数量（如 工业相机 x4）。");
        sb.AppendLine("- 可用 ```mermaid 代码块画 flowchart LR 或简单子图，节点标签用中文；若 Mermaid 不足以表达空间关系，辅以 ASCII 侧视图说明。");
        sb.AppendLine("- 引线关系用「红线指引：」起头逐条列出「标签 -> 指向对象」，Markdown 中不强行上色。");
        sb.AppendLine();
        sb.AppendLine("内容要求：");
        sb.AppendLine("1. 先给一段「整体说明」再给出分段子图或列表。");
        sb.AppendLine("2. 若用户未给足信息，用「假设：」列出合理缺省，并提醒现场核对。");
        sb.AppendLine("3. 不要编造具体品牌型号，除非用户明确提供。");
        sb.AppendLine("4. 直接输出最终文档，不要自称「下面是示意图」以外的元废话。");
        return sb.ToString();
    }
}
