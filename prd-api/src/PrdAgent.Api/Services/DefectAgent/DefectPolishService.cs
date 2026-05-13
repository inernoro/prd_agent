using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using PrdAgent.Api.Services.PrReview;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using MongoDB.Driver;

namespace PrdAgent.Api.Services.DefectAgent;

/// <summary>
/// 缺陷描述润色服务 (SSE 流式版)
///
/// 与 DefectAgentController.PolishDefect 共享 prompt 逻辑, 区别:
/// - 旧端点 (POST /defects/polish): 客户端 await 一次性结果, 看不到生成过程
/// - 本服务 + POST /defects/polish/stream: 通过 AiStreamingHelpers 把 LLM 流式增量推到前端
///
/// 客户端通过 useAiPreviewStream + AiPreviewModal 消费, 享有 Blur focus 词级动画 + 思考过程展示
///
/// AppCallerCode = AppCallerRegistry.DefectAgent.Polish.Stream (与旧 Chat 分离, 便于独立观测/计费)
/// </summary>
public sealed class DefectPolishService
{
    private const string AppCallerCode = AppCallerRegistry.DefectAgent.Polish.Stream;

    private readonly ILlmGateway _gateway;
    private readonly MongoDbContext _db;
    private readonly ILogger<DefectPolishService> _logger;

    public DefectPolishService(ILlmGateway gateway, MongoDbContext db, ILogger<DefectPolishService> logger)
    {
        _gateway = gateway;
        _db = db;
        _logger = logger;
    }

    public async IAsyncEnumerable<LlmStreamDelta> StreamPolishAsync(
        string content,
        string? templateId,
        IReadOnlyList<string>? imageDescriptions,
        PrReviewModelInfoHolder modelInfo,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var trimmed = (content ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
            throw new InvalidOperationException("内容不能为空");

        DefectTemplate? template = null;
        if (!string.IsNullOrWhiteSpace(templateId))
        {
            template = await _db.DefectTemplates.Find(x => x.Id == templateId).FirstOrDefaultAsync(ct);
        }

        var systemPrompt = BuildSystemPrompt(template);
        var userPrompt = BuildUserPrompt(trimmed, imageDescriptions);

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
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                ["temperature"] = 0.4,
                ["max_tokens"] = 2048,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
        };

        // server-authority: 客户端断开不取消 LLM
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
                _logger.LogWarning("DefectPolish stream error: {Error}", msg);
                throw new InvalidOperationException(msg);
            }
        }
    }

    private static string BuildSystemPrompt(DefectTemplate? template)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一个专业的缺陷描述优化助手。请帮助用户润色和完善缺陷描述。");
        sb.AppendLine();
        sb.AppendLine("要求:");
        sb.AppendLine("1. 保持原意不变, 但使描述更加清晰、专业");
        sb.AppendLine("2. 如果描述不完整, 补充必要的信息 (如复现步骤、期望结果、实际结果)");
        sb.AppendLine("3. 使用简洁明了的语言");
        sb.AppendLine("4. 直接输出润色后的内容, 不要添加额外的解释或标记");
        sb.AppendLine("5. 必须使用换行符分隔不同的段落和章节 (如缺陷描述、复现步骤、期望结果、实际结果之间要有空行)");
        sb.AppendLine("6. 第一行必须是可直接作为缺陷列表标题的纯文本问题标题, 不能只输出'缺陷标题:'/'问题标题:'/'图1'/'截图'等模板占位");
        sb.AppendLine("7. 如果用户已有标题, 只保留标题内容本身, 不要保留 Markdown 加粗、编号、HTML 标签或字段名前缀");

        if (template != null)
        {
            sb.AppendLine();
            sb.AppendLine($"参考模板: {template.Name}");
            if (!string.IsNullOrWhiteSpace(template.Description))
                sb.AppendLine($"模板说明: {template.Description}");
            if (!string.IsNullOrWhiteSpace(template.ExampleContent))
            {
                sb.AppendLine();
                sb.AppendLine("以下是一个高质量缺陷报告的示范, 请参考它的结构、详细程度和表达方式来润色用户的内容:");
                sb.AppendLine("--- 示范开始 ---");
                sb.AppendLine(template.ExampleContent);
                sb.AppendLine("--- 示范结束 ---");
                sb.AppendLine();
                sb.AppendLine("请按照示范的结构和详细程度来组织用户的缺陷描述, 补充缺失的部分 (如复现步骤、环境信息等), 但保持用户原始内容的核心含义不变。");
            }
            if (template.RequiredFields?.Count > 0)
            {
                sb.AppendLine("必填字段:");
                foreach (var field in template.RequiredFields)
                    sb.AppendLine($"- {field.Label}");
            }
            if (!string.IsNullOrWhiteSpace(template.AiSystemPrompt))
            {
                sb.AppendLine();
                sb.AppendLine("模板特定指令:");
                sb.AppendLine(template.AiSystemPrompt);
            }
        }

        return sb.ToString();
    }

    private static string BuildUserPrompt(string content, IReadOnlyList<string>? imageDescriptions)
    {
        var sb = new StringBuilder();
        sb.AppendLine("请润色以下缺陷描述:");
        sb.AppendLine();
        sb.AppendLine(content);

        if (imageDescriptions is { Count: > 0 })
        {
            sb.AppendLine();
            sb.AppendLine("用户还附带了截图, 以下是截图的 AI 分析描述:");
            for (var i = 0; i < imageDescriptions.Count; i++)
                sb.AppendLine($"{i + 1}. {imageDescriptions[i]}");
            sb.AppendLine();
            sb.AppendLine("请结合文字描述和截图分析, 输出完整的缺陷报告。");
        }

        return sb.ToString();
    }
}
