using System.Text.Json;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// CDS Agent 会话事件导入去重的纯函数回归测试。
/// 守护 2026-06-10「MD 转 PPT Agent 引擎输出乱码」修复：
/// LLM 流式生成 HTML 时大量 text_delta 内容完全相同（如单独一个 "&lt;" token），
/// 旧实现按 (type, payload) 内容判重，把重复 token 全部丢弃，
/// 拼出的 HTML 系统性缺失重复字符（最高频的 "&lt;" 全丢 = 整页乱码）。
/// 新实现按 CDS seq 水位线判重，内容相同但 seq 递增的事件必须全部导入。
/// </summary>
public class CdsEventImportDedupTests
{
    private static JsonElement Event(long? seq, string text)
    {
        var evt = new Dictionary<string, object?>
        {
            ["type"] = "text_delta",
            ["payload"] = new Dictionary<string, object?> { ["text"] = text },
        };
        if (seq.HasValue) evt["seq"] = seq.Value;
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(evt));
        return doc.RootElement.Clone();
    }

    [Fact]
    public void IdenticalDeltaPayloads_WithIncreasingSeq_AreAllImported()
    {
        // 模拟 LLM 输出 "<div><div><div>" 被切成重复 token："<" "div>" "<" "div>" "<" "div>"
        var deltas = new[] { "<", "div>", "<", "div>", "<", "div>" };
        long watermark = 0;
        var importedTexts = new List<string>();

        for (var i = 0; i < deltas.Length; i++)
        {
            var decision = InfraAgentSessionService.DecideCdsEventImport(Event(i + 1, deltas[i]), watermark);
            if (decision.Import)
            {
                watermark = decision.Watermark;
                importedTexts.Add(deltas[i]);
            }
        }

        // 重复内容一个都不许丢——丢了拼出来就是乱码
        Assert.Equal("<div><div><div>", string.Concat(importedTexts));
        Assert.Equal(6, watermark);
    }

    [Fact]
    public void ReplayedEvents_AtOrBelowWatermark_AreSkipped()
    {
        // 每次轮询 CDS /stream 都会按水位线重放，已导入的 seq 必须跳过
        var decision = InfraAgentSessionService.DecideCdsEventImport(Event(3, "<"), watermark: 5);
        Assert.False(decision.Import);
        Assert.Equal(5, decision.Watermark);

        var atWatermark = InfraAgentSessionService.DecideCdsEventImport(Event(5, "<"), watermark: 5);
        Assert.False(atWatermark.Import);
    }

    [Fact]
    public void ImportedEvent_CarriesCdsSeq_ForWatermarkPersistence()
    {
        var decision = InfraAgentSessionService.DecideCdsEventImport(Event(7, "x"), watermark: 5);
        Assert.True(decision.Import);
        Assert.False(decision.RequiresPayloadDedup);
        Assert.Equal(7, decision.CdsSeq);
        Assert.Equal(7, decision.Watermark);
    }

    [Fact]
    public void EventWithoutSeq_FallsBackToPayloadDedup()
    {
        var decision = InfraAgentSessionService.DecideCdsEventImport(Event(null, "x"), watermark: 5);
        Assert.True(decision.Import);
        Assert.True(decision.RequiresPayloadDedup);
        Assert.Null(decision.CdsSeq);
        Assert.Equal(5, decision.Watermark);
    }
}
