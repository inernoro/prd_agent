using System.Text;
using System.Text.Json.Nodes;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPageAskController
{
    private async Task RunKnowledgeAskAsync(HostedSite site, AskStreamRequest req, string? userId,
        string? shareToken, AskQuotaDecision decision)
    {
        // 分享访问权不能扩大成知识库访问权；不以站点 owner 代替提问者读知识。
        if (userId == null || shareToken != null || userId != site.OwnerUserId)
        {
            if (decision.Consumed) await _quota.RefundAsync(decision, site.Id);
            await WriteJsonErrorAsync(403, "KNOWLEDGE_FORBIDDEN", "请在自己创建的网页中使用知识库检索；分享与团队访客不继承知识库权限");
            return;
        }
        var retrieval = HttpContext.RequestServices.GetRequiredService<KnowledgeRetrievalService>();
        var storeId = req.KnowledgeStoreId!.Trim();
        var started = DateTime.UtcNow;
        using var heartbeatCts = new CancellationTokenSource();
        Task? heartbeat = null;
        var delivered = false;
        try
        {
            await retrieval.RequireReadAsync(storeId, userId);
            Response.ContentType = "text/event-stream";
            Response.Headers.CacheControl = "no-cache";
            heartbeat = RunHeartbeatAsync(started, () => false, heartbeatCts.Token, "正在刷新与核对知识库");
            await WriteSseAsync("phase", new { phase = "retrieving", message = "正在刷新并检索所选知识库，最长等待 120 秒…" });
            var result = await retrieval.SearchAsync(storeId, userId, req.Question!.Trim());
            var hits = result.Hits;
            var session = await EnsureSessionAsync(site, userId, null, req.SessionId);
            await WriteSseAsync("session", new { sessionId = session.Id });
            await WriteSseAsync("retrieval", new { elapsedMs = result.RetrievalMs, hits = hits.Select(h => new { h.EntryId, h.Hash, h.Score }) });
            await WriteSseAsync("model", new { model = result.Model, platform = result.Platform });
            var selection = result.Selection;
            var model = result.Model;
            var platform = result.Platform;
            await retrieval.ValidateAsync(storeId, userId, hits);
            var finalText = KnowledgeRetrieval.Answer(selection, hits);
            var selected = KnowledgeRetrieval.Select(selection, hits.Count).Select(i => hits[i - 1]).ToArray();
            await PersistMessageAsync(session, site, "user", req.Question!.Trim(), hits.Sum(x => x.Text.Length), null, null, null, null);
            var token = AskAnswerRating.CreateToken();
            var saved = await PersistMessageAsync(session, site, "assistant", finalText, hits.Sum(x => x.Text.Length),
                model, platform, Elapsed(started), null, AskAnswerRating.Hash(token));
            await WriteSseAsync("reference", new { references = selected.Select(h => new { h.EntryId, h.Title, h.Url, h.Hash, h.Text, h.Model, h.ChunkIndex }) });
            await WriteSseAsync("done", new { text = finalText, elapsedMs = Elapsed(started), truncated = false,
                messageId = saved?.Id, ratingToken = token });
            delivered = true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "知识库问答失败 store={StoreId}", storeId);
            var message = ex is UnauthorizedAccessException or KnowledgeRetrievalException ? ex.Message : "知识库检索失败，请稍后重试";
            if (Response.ContentType == "text/event-stream")
                await WriteSseAsync("error", new { code = "KNOWLEDGE_UNAVAILABLE", message });
            else await WriteJsonErrorAsync(ex is UnauthorizedAccessException ? 403 : 503, "KNOWLEDGE_UNAVAILABLE", message);
        }
        finally
        {
            heartbeatCts.Cancel();
            if (heartbeat != null) { try { await heartbeat; } catch { /* 流已关闭 */ } }
            if (!delivered && decision.Consumed) await _quota.RefundAsync(decision, site.Id);
        }
    }
}
