using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 毒舌秘书 - 任务回顾与复盘（Review）
///
/// 输入一个时段（weekly / last7d / last30d / custom），后端先聚合任务统计数据（纯数据，零 LLM），
/// 再用专门的「复盘 SystemPrompt」+ 聚合数据调一次 LLM，SSE 流式输出。
/// 完成后落盘成 PaSession.Type='review'，方便历史回看。
/// </summary>
public partial class PaAgentController
{
    public class ReviewRunRequest
    {
        /// <summary>weekly / last7d / last30d / custom</summary>
        public string Range { get; set; } = "last7d";
        /// <summary>custom 时必填，UTC ISO 字符串</summary>
        public DateTime? StartDate { get; set; }
        public DateTime? EndDate { get; set; }
    }

    /// <summary>
    /// 复盘 SystemPrompt — 与主对话人格隔离。
    /// 不复用 SystemPromptTemplate：复盘不识别任务、不输出 save_task / update_profile JSON，
    /// 全文档无 emoji，按固定三段输出。
    /// </summary>
    private const string ReviewSystemPrompt = """
        你是「毒舌秘书」的复盘模式。
        规则同主人格：MBB 风格 / MECE 拆解 / 毒舌不堆鸡汤 / 必须结构化 / 禁止任何 emoji。
        本次只做一件事：复盘 + 下一步建议。

        # 输出格式（严格按下面三段顺序，不要题外话）

        ## 数字
        - 完成 X / 新增 Y / 逾期 Z / 取消 W
        - 一句毒舌点评（≤ 30 字），直击关键

        ## 没干完的为什么
        逐条点出最关键的 1-3 个 Q1/Q2 未完成项 + 推断卡点。
        不替用户瞎猜——只问关键问题让用户自己答。

        ## 下周建议
        3-5 个 next action，每项格式：
        - [Q几] 标题 — 一句毒舌一句（≤ 25 字）

        末尾以一个尖锐问题收尾：「下周第一件事是哪个？」或类似。

        # 关键禁忌
        - 心灵鸡汤、加油、相信你能做到、希望对你有帮助
        - 输出 ```json``` 任何代码块（复盘不识别任务也不更新画像）
        - 任何 emoji 字符
        - 大段纯文本（必须用列表 / 编号 / 表格）
        """;

    /// <summary>
    /// 流式复盘 — SSE 事件协议：
    /// - stage:    阶段提示（aggregating / scoring / suggesting）
    /// - delta:    LLM 流式文本
    /// - done:     完成，附 sessionId
    /// - error:    错误
    /// </summary>
    [HttpPost("review/run")]
    public async Task ReviewRun([FromBody] ReviewRunRequest req)
    {
        var userId = GetUserId();

        // ── 1. 解析时间窗 ─────────────────────────────────────────
        var now = DateTime.UtcNow;
        DateTime startUtc, endUtc;
        string rangeLabel;

        switch (req.Range)
        {
            case "weekly":
            {
                // 本周一 00:00（用户本地时区近似为 UTC+8）→ 转 UTC
                var localNow = now.AddHours(8);
                var dow = ((int)localNow.DayOfWeek + 6) % 7; // 周一=0
                var localMonday = localNow.Date.AddDays(-dow);
                startUtc = localMonday.AddHours(-8);
                endUtc = startUtc.AddDays(7);
                rangeLabel = $"本周（{localMonday:M月d日}-{localMonday.AddDays(6):M月d日}）";
                break;
            }
            case "last30d":
                startUtc = now.AddDays(-30);
                endUtc = now;
                rangeLabel = "近 30 天";
                break;
            case "custom":
                if (!req.StartDate.HasValue || !req.EndDate.HasValue)
                {
                    Response.StatusCode = 400;
                    await Response.WriteAsync(JsonSerializer.Serialize(
                        ApiResponse<object>.Fail("INVALID_FORMAT", "自定义时段必须提供 startDate / endDate")));
                    return;
                }
                startUtc = req.StartDate.Value.ToUniversalTime();
                endUtc = req.EndDate.Value.ToUniversalTime();
                rangeLabel = $"自定义（{startUtc.AddHours(8):M月d日}-{endUtc.AddHours(8):M月d日}）";
                break;
            case "last7d":
            default:
                startUtc = now.AddDays(-7);
                endUtc = now;
                rangeLabel = "近 7 天";
                break;
        }

        // ── 2. SSE headers ──────────────────────────────────────
        Response.Headers["Content-Type"] = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        await WriteSseAsync(new { type = "stage", stage = "aggregating", message = "正在统计任务数据" });

        // ── 3. 聚合任务统计（纯数据，零 LLM）─────────────────────
        var allTasks = await _db.PaTasks
            .Find(t => t.UserId == userId)
            .ToListAsync();

        var inWindow = allTasks
            .Where(t => t.CreatedAt >= startUtc && t.CreatedAt < endUtc)
            .ToList();

        // 待复盘各种统计
        var doneCount = inWindow.Count(t => t.Status == PaTaskStatus.Done);
        var newCount = inWindow.Count;
        var archivedCount = inWindow.Count(t => t.Status == PaTaskStatus.Archived);
        var overdueCount = allTasks.Count(t =>
            t.Status == PaTaskStatus.Pending && t.Deadline.HasValue && t.Deadline < now);

        // 当前未完成的 Q1 / Q2（无论是否在窗口内创建）
        var topPending = allTasks
            .Where(t => t.Status == PaTaskStatus.Pending &&
                        (t.Quadrant == PaTaskQuadrant.Q1 || t.Quadrant == PaTaskQuadrant.Q2))
            .OrderBy(t => t.Deadline ?? DateTime.MaxValue)
            .Take(8)
            .Select(t => new
            {
                title = t.Title,
                quadrant = t.Quadrant,
                deadline = t.Deadline?.AddHours(8).ToString("yyyy-MM-dd"),
                createdAt = t.CreatedAt.AddHours(8).ToString("yyyy-MM-dd"),
            })
            .ToList();

        var quadrantBreakdown = inWindow
            .GroupBy(t => t.Quadrant)
            .ToDictionary(g => g.Key, g => new
            {
                pending = g.Count(t => t.Status == PaTaskStatus.Pending),
                done = g.Count(t => t.Status == PaTaskStatus.Done),
                archived = g.Count(t => t.Status == PaTaskStatus.Archived),
            });

        var aggregate = new
        {
            range = rangeLabel,
            done = doneCount,
            newTasks = newCount,
            archived = archivedCount,
            overdue = overdueCount,
            quadrants = quadrantBreakdown,
            empty = newCount == 0 && topPending.Count == 0,
        };

        await WriteSseAsync(new { type = "stage", stage = "scoring", message = "正在毒舌点评" });

        // ── 4. 调 LLM ─────────────────────────────────────────────
        var displayName = GetDisplayName();
        var userLabel = string.IsNullOrWhiteSpace(displayName) ? "你" : displayName;
        var profile = await LoadOrCreateProfileAsync(userId, displayName);
        var profileBlock = BuildProfileBlock(profile);

        var systemPrompt = ReviewSystemPrompt
            + "\n\n# 当前用户\n- 姓名/称呼：" + userLabel
            + (string.IsNullOrEmpty(profileBlock) ? "" : "\n" + profileBlock);

        var aggregateJson = JsonSerializer.Serialize(aggregate, new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        var topPendingJson = JsonSerializer.Serialize(topPending, new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });

        var userMessage = new StringBuilder();
        userMessage.AppendLine($"请对【{rangeLabel}】做一次复盘。");
        userMessage.AppendLine();
        userMessage.AppendLine("# 任务统计");
        userMessage.AppendLine("```json");
        userMessage.AppendLine(aggregateJson);
        userMessage.AppendLine("```");
        userMessage.AppendLine();
        userMessage.AppendLine("# 当前未完成高优任务（按 deadline 升序）");
        userMessage.AppendLine("```json");
        userMessage.AppendLine(topPendingJson);
        userMessage.AppendLine("```");
        if (aggregate.empty)
        {
            userMessage.AppendLine();
            userMessage.AppendLine("注意：本时段用户没有在系统里留下任何任务记录。请直接点出这件事——这不是清净，是没在用工具。");
        }

        var llmMessages = new List<LLMMessage>
        {
            new() { Role = "user", Content = userMessage.ToString() },
        };

        var assistantContent = new StringBuilder();
        string? streamError = null;
        bool streamSucceeded = false;

        try
        {
            var requestId = Guid.NewGuid().ToString("N");
            using var ctxScope = _llmCtx.BeginScope(new LlmRequestContext(
                RequestId: requestId,
                GroupId: null,
                SessionId: null,
                UserId: userId,
                ViewRole: null,
                DocumentChars: userMessage.Length,
                DocumentHash: null,
                SystemPromptRedacted: "[pa-agent-review]",
                RequestType: "chat",
                AppCallerCode: ReviewAppCallerCode,
                ModelResolutionType: ModelResolutionType.DedicatedPool));

            var client = _gateway.CreateClient(ReviewAppCallerCode, "chat", maxTokens: 2048, temperature: 0.35);

            await WriteSseAsync(new { type = "stage", stage = "suggesting", message = "正在出建议" });

            await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, llmMessages, CancellationToken.None))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    assistantContent.Append(chunk.Content);
                    await WriteSseAsync(new { type = "delta", content = chunk.Content });
                }
                else if (chunk.Type == "done")
                {
                    streamSucceeded = true;
                }
                else if (chunk.Type == "error")
                {
                    streamError = chunk.ErrorMessage ?? "Gateway 返回了空错误信息";
                    _logger.LogWarning("[pa-agent.review] LLM stream error: {Error}", streamError);
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            streamError = ex.Message;
            _logger.LogError(ex, "[pa-agent.review] stream exception for user {UserId}", userId);
        }

        if (!streamSucceeded)
        {
            var raw = streamError ?? "未知错误";
            string userMsg;
            if (raw.Contains("ModelGroup", StringComparison.OrdinalIgnoreCase) || raw.Contains("无可用模型"))
                userMsg = "AI 模型未绑定：管理后台「AI 配置 → 应用调度」给「毒舌秘书-复盘」绑定一个 chat 模型组后再试。";
            else if (raw.Contains("401") || raw.Contains("API key", StringComparison.OrdinalIgnoreCase))
                userMsg = "AI 服务认证失败：请检查模型组的 API Key 是否填写且有效。";
            else if (raw.Contains("429"))
                userMsg = "AI 服务被限流，请稍后重试或换个模型组。";
            else
                userMsg = $"AI 复盘暂时不可用：{(raw.Length > 200 ? raw[..200] + "..." : raw)}";

            await WriteSseAsync(new { type = "error", message = userMsg });
            return;
        }

        // ── 5. 落 PaSession + PaMessage（Type=review）─────────────
        string? sessionId = null;
        if (assistantContent.Length > 0)
        {
            var session = new PaSession
            {
                UserId = userId,
                Title = "复盘 · " + rangeLabel,
                Type = PaSessionType.Review,
                MessageCount = 2,
                LastMessagePreview = $"完成 {doneCount} / 新增 {newCount} / 逾期 {overdueCount}",
            };
            await _db.PaSessions.InsertOneAsync(session);
            sessionId = session.Id;

            await _db.PaMessages.InsertManyAsync(new[]
            {
                new PaMessage
                {
                    UserId = userId,
                    SessionId = session.Id,
                    Role = "user",
                    Content = $"请对【{rangeLabel}】做一次复盘。",
                },
                new PaMessage
                {
                    UserId = userId,
                    SessionId = session.Id,
                    Role = "assistant",
                    Content = assistantContent.ToString(),
                },
            });
        }

        await WriteSseAsync(new { type = "done", sessionId, range = rangeLabel });
    }

    private async Task WriteSseAsync(object payload)
    {
        try
        {
            var data = JsonSerializer.Serialize(payload);
            await Response.WriteAsync($"data: {data}\n\n", CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }
        catch (OperationCanceledException) { /* client disconnected; keep going on server */ }
        catch (ObjectDisposedException) { /* response stream gone */ }
    }
}
