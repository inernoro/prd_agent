using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 通用对话智能体的接口层。
///
/// 只做转发与读取，不含任何对话逻辑。发消息立刻返回，模型那段在后台 worker 里跑；
/// 页面通过事件流按序号续订，刷新或换设备都能接着看（见 doc/design.platform.chat-agent.md）。
/// </summary>
[ApiController]
[Authorize]
[Route("api/chat-agent")]
[AdminController("chat-agent", AdminPermissionCatalog.ChatAgentUse)]
public class ChatAgentController : ControllerBase
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    private readonly IChatAgentService _chat;
    private readonly ILogger<ChatAgentController> _logger;

    public ChatAgentController(IChatAgentService chat, ILogger<ChatAgentController> logger)
    {
        _chat = chat;
        _logger = logger;
    }

    public sealed record CreateSessionRequest(string? Title, string? Model);

    public sealed record RenameSessionRequest(string Title);

    public sealed record SendMessageRequest(string Content);

    [HttpGet("sessions")]
    public async Task<IActionResult> ListSessions(CancellationToken ct)
    {
        var items = await _chat.ListSessionsAsync(this.GetRequiredUserId(), ct);
        return Ok(new { success = true, data = new { items } });
    }

    [HttpPost("sessions")]
    public async Task<IActionResult> CreateSession([FromBody] CreateSessionRequest? body, CancellationToken ct)
    {
        var item = await _chat.CreateSessionAsync(this.GetRequiredUserId(), body?.Title, body?.Model, ct);
        return Ok(new { success = true, data = new { item } });
    }

    [HttpGet("sessions/{id}")]
    public async Task<IActionResult> GetSession(string id, CancellationToken ct)
    {
        var item = await _chat.GetSessionAsync(this.GetRequiredUserId(), id, ct);
        if (item == null) return NotFound(new { success = false, error = new { message = "会话不存在" } });
        return Ok(new { success = true, data = new { item } });
    }

    [HttpPatch("sessions/{id}")]
    public async Task<IActionResult> RenameSession(
        string id, [FromBody] RenameSessionRequest? body, CancellationToken ct)
    {
        var item = await _chat.RenameSessionAsync(this.GetRequiredUserId(), id, body?.Title ?? string.Empty, ct);
        if (item == null) return NotFound(new { success = false, error = new { message = "会话不存在或标题为空" } });
        return Ok(new { success = true, data = new { item } });
    }

    [HttpDelete("sessions/{id}")]
    public async Task<IActionResult> DeleteSession(string id, CancellationToken ct)
    {
        var ok = await _chat.DeleteSessionAsync(this.GetRequiredUserId(), id, ct);
        if (!ok) return NotFound(new { success = false, error = new { message = "会话不存在" } });
        return Ok(new { success = true, data = new { deleted = true } });
    }

    [HttpGet("sessions/{id}/messages")]
    public async Task<IActionResult> ListMessages(string id, [FromQuery] int limit = 200, CancellationToken ct = default)
    {
        var items = await _chat.ListMessagesAsync(this.GetRequiredUserId(), id, limit, ct);
        return Ok(new { success = true, data = new { items } });
    }

    [HttpPost("sessions/{id}/messages")]
    public async Task<IActionResult> SendMessage(
        string id, [FromBody] SendMessageRequest? body, CancellationToken ct)
    {
        try
        {
            // 服务端权威：接单一旦开始就整体落地，客户端此刻断开不许撕成半截。
            var accepted = await _chat.SendMessageAsync(
                this.GetRequiredUserId(), id, body?.Content ?? string.Empty, CancellationToken.None);
            return Ok(new { success = true, data = accepted });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { success = false, error = new { message = ex.Message } });
        }
    }

    /// <summary>
    /// 事件流。afterSeq 是断线续订的锚点：给上次收到的最后一个序号，
    /// 服务端把之后的补齐再继续推。空闲且已追平时收流，避免连接白挂着。
    /// </summary>
    [HttpGet("sessions/{id}/stream")]
    [Produces("text/event-stream")]
    public async Task Stream(string id, [FromQuery] long afterSeq = 0, CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();

        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        var cursor = afterSeq;
        var idleRounds = 0;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var page = await _chat.ReadEventsAsync(userId, id, cursor, 200, ct);

                foreach (var evt in page.Events)
                {
                    await WriteEventAsync(evt.Seq, evt.Type, evt.PayloadJson, ct);
                    cursor = evt.Seq;
                }

                if (page.Events.Count > 0)
                {
                    idleRounds = 0;
                    continue;
                }

                // 已追平且没有在跑的轮次：告诉前端可以停了。这样连接不会白挂，
                // 前端也不需要靠超时猜「是不是结束了」。
                if (!page.Running)
                {
                    await WriteEventAsync(cursor, "idle", "{}", ct);
                    return;
                }

                idleRounds++;
                // 有轮次在跑但这一拍没有新事件：发心跳，让中间的代理不掐连接。
                if (idleRounds % 20 == 0) await WriteRawAsync(": keepalive\n\n", ct);

                await Task.Delay(TimeSpan.FromMilliseconds(250), ct);
            }
        }
        catch (OperationCanceledException) { /* 客户端断开：正常，后台那一轮继续跑 */ }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ChatAgent] 事件流异常 session={SessionId}", id);
            try
            {
                await WriteEventAsync(cursor, "error",
                    JsonSerializer.Serialize(new { code = "stream_failed", message = "事件流中断，刷新页面可继续。" }, JsonOpts),
                    CancellationToken.None);
            }
            catch { /* 连接已经没了 */ }
        }
    }

    private async Task WriteEventAsync(long seq, string type, string payloadJson, CancellationToken ct)
        => await WriteRawAsync($"id: {seq}\nevent: {type}\ndata: {payloadJson}\n\n", ct);

    private async Task WriteRawAsync(string chunk, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(chunk);
        await Response.Body.WriteAsync(bytes, ct);
        await Response.Body.FlushAsync(ct);
    }
}
