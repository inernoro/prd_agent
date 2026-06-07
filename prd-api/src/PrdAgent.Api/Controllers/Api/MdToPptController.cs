using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// MD 转网页 PPT — 调用 CDS Agent 生成 reveal.js HTML 幻灯片。
///
/// SSE 事件协议（前端不变）：
///   event: start  — 会话开始
///   event: delta  — data: {"text":"..."}  增量 HTML 片段
///   event: done   — data: {"html":"..."}  完整 HTML
///   event: error  — data: {"message":"..."}
/// </summary>
[ApiController]
[Route("api/md-to-ppt")]
[Authorize]
public class MdToPptController : ControllerBase
{
    private readonly IInfraAgentSessionService _sessions;
    private readonly MongoDbContext _db;

    // PPT Agent 系统提示词：要求 reveal.js@4 CDN、深色主题、多样化版式、纯 HTML 输出
    private const string PptSystemPrompt = @"你是一名专业网页 PPT 设计师。请把用户提供的 Markdown 内容转换成一份完整的 reveal.js 幻灯片 HTML 文件，遵循以下要求：

## 技术规范
- 使用 reveal.js 4.x CDN（https://cdn.jsdelivr.net/npm/reveal.js@4/）
- 必须设置 hash: false（因为会嵌入 iframe srcdoc，hash 路由会报错）
- 所有样式内联在 <head> 里，不依赖外部自定义文件
- 输出完整的 <!DOCTYPE html>…</html> 文件，不要任何代码块标记

## 视觉风格
- 使用深色系主题（如深蓝/深紫/深灰作为背景）
- 文字对比度高（白色或浅色系）
- 标题字体比正文大 1.5-2 倍，使用 font-weight: 700
- 每张幻灯片有清晰的视觉层次

## 版式多样化（必须混用以下类型，不允许全部单栏）
1. 封面页：大标题 + 副标题 + 装饰元素（渐变色块/圆形/线条）
2. 两栏对比：左右各占 50%，用于比较/对照内容
3. 数据统计：大号数字 + 说明文字，适合关键指标
4. 深色反转：浅色文字/图标在深色纯色背景上
5. 内容配图：左侧文字 + 右侧装饰色块模拟图片区
6. 结语页：居中大字 + 联系方式/总结

## 装饰元素
- 用 CSS 绘制几何形状（圆形、矩形、斜线）作为装饰，不依赖图片
- 渐变色块作为视觉重点
- 适当使用 border-left 竖线强调引用或要点

## 输出要求
- 仅输出完整 HTML，不要任何解释、标注或代码块标记
- reveal.js 初始化配置必须包含：hash: false, transition: 'fade', slideNumber: true";

    public MdToPptController(
        IInfraAgentSessionService sessions,
        MongoDbContext db)
    {
        _sessions = sessions;
        _db = db;
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/convert
    // ─────────────────────────────────────────────

    /// <summary>将 Markdown 转换为 reveal.js HTML PPT（SSE 流式返回）</summary>
    [HttpPost("convert")]
    public async Task Convert([FromBody] MdToPptConvertRequest req)
    {
        var userId = this.GetRequiredUserId();
        SetSseHeaders();

        await WriteEventAsync("start", null);

        var styleHint = $"目标页数约 {req.SlideCount ?? 8} 页；主题风格：{(string.IsNullOrWhiteSpace(req.Theme) ? "深色现代" : req.Theme)}。";
        var prompt = $"{PptSystemPrompt}\n\n{styleHint}\n\n---\n\n# 用户内容\n\n{req.Content?.Trim()}";
        await RunAgentStreamAsync(userId, prompt, "PPT");
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/patch
    // ─────────────────────────────────────────────

    /// <summary>根据用户指令修改已有 HTML PPT（SSE 流式返回）</summary>
    [HttpPost("patch")]
    public async Task Patch([FromBody] MdToPptPatchRequest req)
    {
        var userId = this.GetRequiredUserId();
        SetSseHeaders();

        await WriteEventAsync("start", null);

        var prompt = $"{PptSystemPrompt}\n\n---\n\n# 已有 HTML\n\n```html\n{req.CurrentHtml?.Trim()}\n```\n\n# 修改要求（第 {(req.SlideIndex.HasValue ? req.SlideIndex.Value + 1 : 0)} 页）\n\n{req.SlideRequest?.Trim()}";
        await RunAgentStreamAsync(userId, prompt, "PPT 修改");
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/publish
    // ─────────────────────────────────────────────

    /// <summary>将生成的 HTML 发布为托管网页</summary>
    [HttpPost("publish")]
    public async Task<IActionResult> Publish([FromBody] MdToPptPublishRequest req)
    {
        var userId = this.GetRequiredUserId();

        if (string.IsNullOrWhiteSpace(req.HtmlContent))
            return BadRequest(new { error = "HTML 内容不能为空" });

        var title = string.IsNullOrWhiteSpace(req.Title) ? "PPT 幻灯片" : req.Title.Trim();
        var htmlBytes = Encoding.UTF8.GetBytes(req.HtmlContent);

        // 上传为托管站点
        var siteService = HttpContext.RequestServices.GetRequiredService<IHostedSiteService>();
        var site = await siteService.CreateFromHtmlAsync(
            userId,
            htmlBytes,
            "index.html",
            title,
            string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim(),
            null,
            req.Tags?.Where(t => !string.IsNullOrWhiteSpace(t)).ToList(),
            CancellationToken.None);

        if (req.TeamIds is { Count: > 0 })
        {
            await siteService.SetSharedTeamsAsync(site.Id, userId, req.TeamIds, CancellationToken.None);
        }

        return Ok(new
        {
            siteId = site.Id,
            title = site.Title,
            siteUrl = site.SiteUrl,
        });
    }

    // ─────────────────────────────────────────────
    // 内部：CDS Agent 流式执行
    // ─────────────────────────────────────────────

    private async Task RunAgentStreamAsync(string userId, string prompt, string title)
    {
        InfraConnection? connection = null;
        InfraAgentRuntimeProfile? runtimeProfile = null;
        InfraAgentSessionView? session = null;

        try
        {
            // 1. 解析 CDS 连接
            connection = await ResolveCdsConnectionAsync(CancellationToken.None);
            if (connection == null)
            {
                await WriteEventAsync("error", new { message = "没有可用的 active CDS 连接，请先完成系统级 CDS 授权" });
                return;
            }

            // 2. 解析运行配置（同 CapsuleExecutor 的四级优先级）
            runtimeProfile = await ResolveRuntimeProfileAsync(userId, CancellationToken.None);
            if (runtimeProfile == null)
            {
                await WriteEventAsync("error", new { message = "没有可用的模型运行配置，请先配置 baseUrl、model 和 API key" });
                return;
            }

            var runtime = runtimeProfile.Runtime;
            var model = runtimeProfile.Model;

            // 3. 创建会话
            session = await _sessions.CreateAsync(userId,
                new CreateInfraAgentSessionRequest(
                    connection.Id,
                    runtime,
                    model,
                    title,
                    "readonly-auto",
                    null,
                    runtimeProfile.Id,
                    null,
                    null,
                    null,
                    null),
                CancellationToken.None);

            // 4. 启动会话
            if (!string.Equals(session.Status, "running", StringComparison.OrdinalIgnoreCase))
            {
                session = await _sessions.StartAsync(userId, session.Id,
                    new StartInfraAgentSessionRequest(runtime, model),
                    CancellationToken.None) ?? session;
            }

            // 5. 发送消息
            session = await _sessions.SendMessageAsync(userId, session.Id,
                new SendInfraAgentMessageRequest(prompt),
                CancellationToken.None) ?? session;

            // 6. 轮询事件，流式推送 delta
            var afterSeq = 0L;
            var fullText = new StringBuilder();
            string? finalHtml = null;
            const int maxPollingRounds = 600; // 最多 ~8 分钟 (600 * 800ms)

            for (var round = 0; round < maxPollingRounds; round++)
            {
                var batch = await _sessions.ListEventsAsync(userId, session.Id, afterSeq, 50, CancellationToken.None);

                var gotDone = false;
                string? errorMessage = null;

                foreach (var evt in batch.OrderBy(x => x.Seq))
                {
                    if (evt.Seq <= afterSeq) continue;
                    afterSeq = evt.Seq;

                    try
                    {
                        using var doc = JsonDocument.Parse(evt.PayloadJson ?? "{}");
                        var root = doc.RootElement;

                        if (evt.Type == InfraAgentEventTypes.TextDelta
                            && root.TryGetProperty("text", out var textProp))
                        {
                            var fragment = textProp.GetString() ?? "";
                            if (!string.IsNullOrEmpty(fragment))
                            {
                                fullText.Append(fragment);
                                await WriteEventAsync("delta", new { text = fragment });
                            }
                        }
                        else if (evt.Type == InfraAgentEventTypes.Done
                            && root.TryGetProperty("finalText", out var finalProp))
                        {
                            var rawFinal = finalProp.GetString() ?? "";
                            // finalText 可能补充最后一段内容
                            if (!string.IsNullOrEmpty(rawFinal) && rawFinal != fullText.ToString())
                                finalHtml = StripCodeFences(rawFinal);
                            else
                                finalHtml = StripCodeFences(fullText.ToString());
                            gotDone = true;
                            break;
                        }
                        else if (evt.Type == InfraAgentEventTypes.Error
                            && root.TryGetProperty("message", out var msgProp))
                        {
                            errorMessage = msgProp.GetString() ?? "CDS Agent 发生错误";
                            break;
                        }
                    }
                    catch
                    {
                        // 解析单个事件失败不终止流，继续
                    }
                }

                if (errorMessage != null)
                {
                    await WriteEventAsync("error", new { message = errorMessage });
                    return;
                }

                if (gotDone)
                {
                    var html = finalHtml ?? StripCodeFences(fullText.ToString());
                    await WriteEventAsync("done", new { html });
                    return;
                }

                // 未完成：等待后继续轮询
                await Task.Delay(800);
            }

            // 超时兜底：把已收到的内容作为最终结果
            var timeoutHtml = StripCodeFences(fullText.ToString());
            if (!string.IsNullOrWhiteSpace(timeoutHtml))
                await WriteEventAsync("done", new { html = timeoutHtml });
            else
                await WriteEventAsync("error", new { message = "CDS Agent 响应超时，请稍后重试" });
        }
        catch (OperationCanceledException)
        {
            // 客户端断开，按 server-authority 规则继续后台但停止写 SSE
        }
        catch (ObjectDisposedException)
        {
            // 同上
        }
        catch (Exception ex)
        {
            try
            {
                await WriteEventAsync("error", new { message = ex.Message });
            }
            catch
            {
                // 写 SSE 失败则忽略
            }
        }
        finally
        {
            // 7. 结束后停止会话（server-authority：用 CancellationToken.None）
            if (session != null)
            {
                try
                {
                    await _sessions.StopAsync(userId, session.Id, CancellationToken.None);
                }
                catch
                {
                    // 停止失败不影响主流程
                }
            }
        }
    }

    // ─────────────────────────────────────────────
    // 解析 CDS 连接（同 CapsuleExecutor.ResolveCdsConnectionForWorkflowAsync 无 connectionId 分支）
    // ─────────────────────────────────────────────

    private async Task<InfraConnection?> ResolveCdsConnectionAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        return await _db.InfraConnections
            .Find(x => x.Partner == "cds"
                && x.LongTokenEncrypted != string.Empty
                && (x.Status == "active"
                    || (x.LastProbeOk == true && x.LongTokenExpiresAt > now)))
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
    }

    // ─────────────────────────────────────────────
    // 解析运行配置（同 CapsuleExecutor 四级优先级：owned default → shared default → owned any → shared any）
    // ─────────────────────────────────────────────

    private async Task<InfraAgentRuntimeProfile?> ResolveRuntimeProfileAsync(string userId, CancellationToken ct)
    {
        var memberTeamIds = await _db.ReportTeamMembers
            .Find(x => x.UserId == userId)
            .Limit(500)
            .ToListAsync(ct);
        var leaderTeams = await _db.ReportTeams
            .Find(x => x.LeaderUserId == userId)
            .Limit(500)
            .ToListAsync(ct);
        var visibleTeamIds = memberTeamIds
            .Select(x => x.TeamId)
            .Concat(leaderTeams.Select(x => x.Id))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var fb = Builders<InfraAgentRuntimeProfile>.Filter;
        var ownedFilter = fb.Eq(x => x.CreatedByUserId, userId);
        var sharedFilter = visibleTeamIds.Count == 0
            ? fb.Where(_ => false)
            : fb.AnyIn(x => x.SharedTeamIds, visibleTeamIds);

        // 优先级 1：用户自己的默认配置
        var profile = await _db.InfraAgentRuntimeProfiles
            .Find(ownedFilter & fb.Eq(x => x.IsDefault, true))
            .FirstOrDefaultAsync(ct);
        if (profile != null) return profile;

        // 优先级 2：共享的默认配置
        profile = await _db.InfraAgentRuntimeProfiles
            .Find(sharedFilter & fb.Eq(x => x.IsDefault, true))
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        if (profile != null) return profile;

        // 优先级 3：用户自己的任意配置
        profile = await _db.InfraAgentRuntimeProfiles
            .Find(ownedFilter)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        if (profile != null) return profile;

        // 优先级 4：共享的任意配置
        return await _db.InfraAgentRuntimeProfiles
            .Find(sharedFilter)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
    }

    // ─────────────────────────────────────────────
    // SSE 工具方法
    // ─────────────────────────────────────────────

    private void SetSseHeaders()
    {
        Response.ContentType = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";
        Response.Headers["Transfer-Encoding"] = "chunked";
    }

    private async Task WriteEventAsync(string eventName, object? data)
    {
        try
        {
            var dataLine = data == null
                ? "null"
                : JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            var payload = $"event: {eventName}\ndata: {dataLine}\n\n";
            await Response.WriteAsync(payload, CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    // ─────────────────────────────────────────────
    // 去除代码围栏（CDS Agent 偶尔会在 HTML 外包 ```html ... ```）
    // ─────────────────────────────────────────────

    private static string StripCodeFences(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;

        var s = text.Trim();

        // 去除开头的 ```html 或 ``` 行
        if (s.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNewline = s.IndexOf('\n');
            if (firstNewline >= 0)
                s = s[(firstNewline + 1)..];
        }

        // 去除结尾的 ``` 行
        if (s.EndsWith("```", StringComparison.Ordinal))
        {
            var lastFence = s.LastIndexOf("```", StringComparison.Ordinal);
            if (lastFence > 0)
                s = s[..lastFence].TrimEnd();
        }

        return s.Trim();
    }
}

// ─────────────────────────────────────────────
// 请求 DTO
// ─────────────────────────────────────────────

public class MdToPptConvertRequest
{
    /// <summary>要转换的内容（Markdown / 纯文本），与前端 content 对齐</summary>
    public string? Content { get; set; }

    /// <summary>期望页数（可选）</summary>
    public int? SlideCount { get; set; }

    /// <summary>主题（可选）</summary>
    public string? Theme { get; set; }
}

public class MdToPptPatchRequest
{
    /// <summary>当前 HTML 内容，与前端 currentHtml 对齐</summary>
    public string? CurrentHtml { get; set; }

    /// <summary>修改要求，与前端 slideRequest 对齐</summary>
    public string? SlideRequest { get; set; }

    /// <summary>目标页索引（可选）</summary>
    public int? SlideIndex { get; set; }
}

public class MdToPptPublishRequest
{
    /// <summary>要发布的 HTML 内容，与前端 htmlContent 对齐</summary>
    public string? HtmlContent { get; set; }

    /// <summary>发布标题</summary>
    public string? Title { get; set; }

    /// <summary>站点描述（可选）</summary>
    public string? Description { get; set; }

    /// <summary>标签（可选）</summary>
    public List<string>? Tags { get; set; }

    /// <summary>分享到的团队 ID（可选）</summary>
    public List<string>? TeamIds { get; set; }
}
