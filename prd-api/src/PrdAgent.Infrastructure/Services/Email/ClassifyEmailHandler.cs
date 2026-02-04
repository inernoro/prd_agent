using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Email;

/// <summary>
/// 邮件分类处理器
/// 使用 LLM 对邮件内容进行分类
/// </summary>
public class ClassifyEmailHandler : IEmailHandler
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _llmGateway;
    private readonly ILogger<ClassifyEmailHandler> _logger;

    public EmailIntentType IntentType => EmailIntentType.Classify;

    public ClassifyEmailHandler(MongoDbContext db, ILlmGateway llmGateway, ILogger<ClassifyEmailHandler> logger)
    {
        _db = db;
        _llmGateway = llmGateway;
        _logger = logger;
    }

    public async Task<EmailHandleResult> HandleAsync(
        string taskId,
        string senderAddress,
        string? senderName,
        string subject,
        string body,
        EmailIntent intent,
        string? mappedUserId,
        CancellationToken ct = default)
    {
        _logger.LogInformation("Classifying email from {Sender}: {Subject}", senderAddress, subject);

        try
        {
            // 构建分类 prompt
            var truncatedBody = body.Length > 2000 ? body[..2000] + "..." : body;
            var prompt = BuildClassifyPrompt(subject, truncatedBody);

            // 调用 LLM
            var request = new GatewayRequest
            {
                AppCallerCode = "channel-adapter.email::classify",
                ModelType = "chat",
                RequestBody = new JsonObject
                {
                    ["messages"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["role"] = "user",
                            ["content"] = prompt
                        }
                    },
                    ["temperature"] = 0.3 // 分类任务用低温度
                }
            };

            var response = await _llmGateway.SendAsync(request, ct);

            // 解析分类结果
            var classification = ParseClassificationResult(response.Content, taskId, subject, body);

            // 保存分类结果
            await _db.EmailClassifications.InsertOneAsync(classification, cancellationToken: ct);

            _logger.LogInformation(
                "Email classified: {Category}/{SubCategory}, Urgency={Urgency}",
                classification.Category,
                classification.SubCategory,
                classification.Urgency);

            // 构建回复消息
            var replyMessage = BuildReplyMessage(classification);

            var result = EmailHandleResult.Ok(replyMessage, classification.Summary);
            result.EntityId = classification.Id;
            result.Data = new Dictionary<string, object>
            {
                ["category"] = classification.Category,
                ["subCategory"] = classification.SubCategory ?? "",
                ["urgency"] = classification.Urgency,
                ["keywords"] = classification.Keywords
            };
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to classify email: {TaskId}", taskId);
            return EmailHandleResult.Fail("邮件分类失败", ex.Message);
        }
    }

    private string BuildClassifyPrompt(string subject, string body)
    {
        return $$"""
            请分析以下邮件内容，进行分类和摘要。

            【邮件主题】
            {{subject}}

            【邮件正文】
            {{body}}

            请用JSON格式返回分类结果：
            {
                "category": "主分类（如：工作、财务、人事、技术、营销、客户、个人等）",
                "subCategory": "子分类（可选）",
                "urgency": "紧急程度（low/medium/high/urgent）",
                "needsReply": true/false,
                "suggestedAction": "建议的处理方式",
                "keywords": ["关键词1", "关键词2"],
                "summary": "50字以内的内容摘要"
            }

            只返回JSON，不要其他内容。
            """;
    }

    private EmailClassification ParseClassificationResult(string llmResponse, string taskId, string subject, string body)
    {
        var classification = new EmailClassification { TaskId = taskId };

        try
        {
            // 尝试提取 JSON（LLM 可能返回带 markdown 的内容）
            var jsonStart = llmResponse.IndexOf('{');
            var jsonEnd = llmResponse.LastIndexOf('}');

            if (jsonStart >= 0 && jsonEnd > jsonStart)
            {
                var json = llmResponse[jsonStart..(jsonEnd + 1)];
                var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (root.TryGetProperty("category", out var cat))
                    classification.Category = cat.GetString() ?? "未分类";

                if (root.TryGetProperty("subCategory", out var subCat))
                    classification.SubCategory = subCat.GetString();

                if (root.TryGetProperty("urgency", out var urg))
                    classification.Urgency = urg.GetString() ?? "medium";

                if (root.TryGetProperty("needsReply", out var reply))
                    classification.NeedsReply = reply.GetBoolean();

                if (root.TryGetProperty("suggestedAction", out var action))
                    classification.SuggestedAction = action.GetString();

                if (root.TryGetProperty("keywords", out var kw) && kw.ValueKind == JsonValueKind.Array)
                {
                    classification.Keywords = kw.EnumerateArray()
                        .Select(k => k.GetString() ?? "")
                        .Where(k => !string.IsNullOrEmpty(k))
                        .ToList();
                }

                if (root.TryGetProperty("summary", out var sum))
                    classification.Summary = sum.GetString();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse LLM classification response, using defaults");
        }

        // 确保有默认值
        if (string.IsNullOrEmpty(classification.Category))
            classification.Category = "未分类";

        if (string.IsNullOrEmpty(classification.Summary))
            classification.Summary = subject.Length > 50 ? subject[..50] + "..." : subject;

        return classification;
    }

    private string BuildReplyMessage(EmailClassification classification)
    {
        var urgencyText = classification.Urgency switch
        {
            "urgent" => "紧急",
            "high" => "较高",
            "medium" => "中等",
            "low" => "较低",
            _ => "中等"
        };

        var lines = new List<string>
        {
            "📧 邮件分类完成",
            "",
            $"📁 分类：{classification.Category}" + (classification.SubCategory != null ? $" / {classification.SubCategory}" : ""),
            $"⚡ 紧急程度：{urgencyText}",
            $"💬 需要回复：{(classification.NeedsReply ? "是" : "否")}"
        };

        if (classification.Keywords.Count > 0)
        {
            lines.Add($"🏷️ 关键词：{string.Join("、", classification.Keywords)}");
        }

        if (!string.IsNullOrEmpty(classification.SuggestedAction))
        {
            lines.Add($"💡 建议：{classification.SuggestedAction}");
        }

        if (!string.IsNullOrEmpty(classification.Summary))
        {
            lines.Add("");
            lines.Add($"📝 摘要：{classification.Summary}");
        }

        return string.Join("\n", lines);
    }
}
