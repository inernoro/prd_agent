using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Email;

/// <summary>
/// 待办事项处理器
/// 从邮件中提取待办信息并创建任务
/// </summary>
public class TodoEmailHandler : IEmailHandler
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _llmGateway;
    private readonly ILogger<TodoEmailHandler> _logger;

    public EmailIntentType IntentType => EmailIntentType.CreateTodo;

    public TodoEmailHandler(MongoDbContext db, ILlmGateway llmGateway, ILogger<TodoEmailHandler> logger)
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
        _logger.LogInformation("Creating todo from email: {Subject}", subject);

        try
        {
            // 使用 LLM 提取待办信息
            var todoInfo = await ExtractTodoInfoAsync(subject, body, ct);

            // 从意图参数中获取额外信息
            if (intent.Parameters.TryGetValue("priority", out var priorityStr) && int.TryParse(priorityStr, out var priority))
            {
                todoInfo.Priority = priority;
            }

            if (intent.Parameters.TryGetValue("dueDate", out var dueDateStr))
            {
                todoInfo.DueDateStr = dueDateStr;
            }

            // 创建待办事项
            var todo = new TodoItem
            {
                UserId = mappedUserId ?? "system",
                Title = todoInfo.Title ?? CleanSubjectForTitle(subject),
                Description = todoInfo.Description ?? body,
                Source = "email",
                SourceId = taskId,
                SourceMeta = new Dictionary<string, string>
                {
                    ["senderAddress"] = senderAddress,
                    ["senderName"] = senderName ?? senderAddress,
                    ["originalSubject"] = subject
                },
                Priority = todoInfo.Priority,
                DueDate = ParseDueDate(todoInfo.DueDateStr),
                Tags = todoInfo.Tags ?? new List<string>()
            };

            await _db.TodoItems.InsertOneAsync(todo, cancellationToken: ct);

            _logger.LogInformation(
                "Todo created: {Id} - {Title}, Priority={Priority}, DueDate={DueDate}",
                todo.Id, todo.Title, todo.Priority, todo.DueDate);

            // 构建回复消息
            var replyMessage = BuildReplyMessage(todo);

            var result = EmailHandleResult.Ok(replyMessage);
            result.EntityId = todo.Id;
            result.Data = new Dictionary<string, object>
            {
                ["title"] = todo.Title,
                ["priority"] = todo.Priority,
                ["dueDate"] = todo.DueDate?.ToString("yyyy-MM-dd") ?? ""
            };
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create todo from email: {TaskId}", taskId);
            return EmailHandleResult.Fail("创建待办失败", ex.Message);
        }
    }

    private async Task<TodoExtractInfo> ExtractTodoInfoAsync(string subject, string body, CancellationToken ct)
    {
        var info = new TodoExtractInfo();

        try
        {
            var truncatedBody = body.Length > 1500 ? body[..1500] + "..." : body;
            var systemPrompt = """
                你是一个待办事项提取助手。从邮件内容中提取待办信息，用JSON格式返回。
                只返回JSON，不要其他内容。
                """;

            var userPrompt = $$"""
                从以下邮件中提取待办事项信息：

                【主题】{{subject}}
                【正文】{{truncatedBody}}

                请提取：
                1. 待办标题（简洁明了，20字以内）
                2. 待办描述（关键内容）
                3. 优先级（1-5，5最紧急）
                4. 截止日期（如果提到的话）
                5. 相关标签

                用JSON格式返回：
                {
                    "title": "待办标题",
                    "description": "关键内容描述",
                    "priority": 3,
                    "dueDate": "2024-01-15 或 null",
                    "tags": ["标签1", "标签2"]
                }
                """;

            var client = _llmGateway.CreateClient(
                "channel-adapter.email.todo-extract::chat",
                "chat",
                maxTokens: 1024,
                temperature: 0.2);

            var messages = new List<LLMMessage>
            {
                new() { Role = "user", Content = userPrompt }
            };

            // 收集流式响应
            var responseBuilder = new System.Text.StringBuilder();
            await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, ct))
            {
                if (chunk.Type == "delta" && chunk.Content != null)
                {
                    responseBuilder.Append(chunk.Content);
                }
            }
            var responseContent = responseBuilder.ToString();

            // 解析结果
            var jsonStart = responseContent.IndexOf('{');
            var jsonEnd = responseContent.LastIndexOf('}');

            if (jsonStart >= 0 && jsonEnd > jsonStart)
            {
                var json = responseContent[jsonStart..(jsonEnd + 1)];
                var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (root.TryGetProperty("title", out var title))
                    info.Title = title.GetString();

                if (root.TryGetProperty("description", out var desc))
                    info.Description = desc.GetString();

                if (root.TryGetProperty("priority", out var pri) && pri.TryGetInt32(out var priVal))
                    info.Priority = Math.Clamp(priVal, 1, 5);

                if (root.TryGetProperty("dueDate", out var due) && due.ValueKind == JsonValueKind.String)
                    info.DueDateStr = due.GetString();

                if (root.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array)
                {
                    info.Tags = tags.EnumerateArray()
                        .Select(t => t.GetString() ?? "")
                        .Where(t => !string.IsNullOrEmpty(t))
                        .ToList();
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to extract todo info via LLM, using fallback");
        }

        return info;
    }

    private string CleanSubjectForTitle(string subject)
    {
        // 移除常见前缀
        var cleaned = Regex.Replace(subject, @"^(Re:|Fwd:|转发:|回复:|\[待办\]|\[TODO\])\s*", "", RegexOptions.IgnoreCase);
        return cleaned.Length > 50 ? cleaned[..50] + "..." : cleaned;
    }

    private DateTime? ParseDueDate(string? dueDateStr)
    {
        if (string.IsNullOrEmpty(dueDateStr) || dueDateStr == "null")
            return null;

        // 尝试标准日期格式
        if (DateTime.TryParse(dueDateStr, out var date))
            return date;

        // 处理相对日期
        var today = DateTime.Today;
        return dueDateStr switch
        {
            "今天" => today,
            "明天" => today.AddDays(1),
            "后天" => today.AddDays(2),
            "下周一" => GetNextWeekday(today, DayOfWeek.Monday),
            "下周二" => GetNextWeekday(today, DayOfWeek.Tuesday),
            "下周三" => GetNextWeekday(today, DayOfWeek.Wednesday),
            "下周四" => GetNextWeekday(today, DayOfWeek.Thursday),
            "下周五" => GetNextWeekday(today, DayOfWeek.Friday),
            "下周六" => GetNextWeekday(today, DayOfWeek.Saturday),
            "下周日" => GetNextWeekday(today, DayOfWeek.Sunday),
            _ => TryParseChineseDate(dueDateStr)
        };
    }

    private DateTime? TryParseChineseDate(string dateStr)
    {
        // 处理 "X月X日" 格式
        var match = Regex.Match(dateStr, @"(\d{1,2})月(\d{1,2})日");
        if (match.Success)
        {
            var month = int.Parse(match.Groups[1].Value);
            var day = int.Parse(match.Groups[2].Value);
            var year = DateTime.Today.Year;

            // 如果已过期，假设是明年
            var date = new DateTime(year, month, day);
            if (date < DateTime.Today)
                date = date.AddYears(1);

            return date;
        }

        return null;
    }

    private DateTime GetNextWeekday(DateTime from, DayOfWeek dayOfWeek)
    {
        var daysToAdd = ((int)dayOfWeek - (int)from.DayOfWeek + 7) % 7;
        if (daysToAdd == 0) daysToAdd = 7;
        return from.AddDays(daysToAdd);
    }

    private string BuildReplyMessage(TodoItem todo)
    {
        var lines = new List<string>
        {
            "✅ 待办事项已创建",
            "",
            $"📋 标题：{todo.Title}"
        };

        var priorityText = todo.Priority switch
        {
            5 => "🔴 紧急",
            4 => "🟠 重要",
            3 => "🟡 普通",
            2 => "🟢 较低",
            1 => "⚪ 最低",
            _ => "🟡 普通"
        };
        lines.Add($"⚡ 优先级：{priorityText}");

        if (todo.DueDate.HasValue)
        {
            lines.Add($"📅 截止日期：{todo.DueDate.Value:yyyy年M月d日}");
        }

        if (todo.Tags.Count > 0)
        {
            lines.Add($"🏷️ 标签：{string.Join("、", todo.Tags)}");
        }

        lines.Add("");
        lines.Add($"🆔 任务ID：{todo.Id}");

        return string.Join("\n", lines);
    }

    private class TodoExtractInfo
    {
        public string? Title { get; set; }
        public string? Description { get; set; }
        public int Priority { get; set; } = 3;
        public string? DueDateStr { get; set; }
        public List<string>? Tags { get; set; }
    }
}
