using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 走网关的 embedding 实现。
///
/// 严格遵守 compute-then-send：先 ResolveModelAsync 算一次模型，再把这个 resolution
/// 交给 SendRawWithResolutionAsync 发送。发送阶段绝不再解析一次——本仓库为这条规则
/// 付过一整天的排查代价（视觉创作"选 A 给 B"，见 .claude/rules/compute-then-send.md）。
/// </summary>
public class EmbeddingService : IEmbeddingService
{
    /// <summary>单次请求最多向量化多少条，避免请求体过大被上游拒。</summary>
    public const int MaxBatchSize = 64;

    private readonly ILlmGateway _gateway;
    private readonly ILogger<EmbeddingService> _logger;

    public EmbeddingService(ILlmGateway gateway, ILogger<EmbeddingService> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    public async Task<string?> ResolveActiveModelAsync(string appCallerCode, CancellationToken ct = default)
    {
        try
        {
            var resolution = await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.Embedding, ct: ct);
            return resolution is { Success: true } ? resolution.ActualModel : null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "解析 embedding 模型失败 caller={Caller}", appCallerCode);
            return null;
        }
    }

    public async Task<EmbeddingBatch> EmbedAsync(
        IReadOnlyList<string> texts, string appCallerCode, CancellationToken ct = default)
    {
        var input = (texts ?? Array.Empty<string>())
            .Select(t => (t ?? string.Empty).Trim())
            .ToList();

        if (input.Count == 0)
            return EmbeddingBatch.Fail("EMPTY_INPUT", "没有可向量化的文本");

        // 空白项必须整批拒绝，**不能**过滤掉。
        //
        // Vectors 的契约是「与入参一一对应、顺序一致」，调用方靠下标把向量配回原文。
        // 过滤会让返回的向量比入参少，后面每一条都错位一格——第 5 段的向量被安到第 4 段身上，
        // 而且悄无声息（本仓库的「选 A 给 B」事故就是这么来的）。少一条不如整批红。
        var blankIndex = input.FindIndex(t => t.Length == 0);
        if (blankIndex >= 0)
        {
            return EmbeddingBatch.Fail("EMPTY_INPUT",
                $"第 {blankIndex + 1} 条文本为空，整批拒绝——过滤空白会让向量与原文错位");
        }

        if (input.Count > MaxBatchSize)
            return EmbeddingBatch.Fail("EMPTY_INPUT", $"单批最多 {MaxBatchSize} 条，请分批调用");

        // ── 算 ──
        var resolution = await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.Embedding, ct: ct);
        if (resolution is not { Success: true })
        {
            // 这里的失败绝大多数是"根本没配 embedding 模型"。必须如实往上报，
            // 让调用方告诉用户"还没接入向量模型"，而不是悄悄换个模型算出垃圾向量。
            return EmbeddingBatch.Fail("NO_EMBEDDING_MODEL",
                resolution?.ErrorMessage ?? "没有可用的向量模型，请先在模型管理里接入一个 embedding 模型");
        }

        // ── 发 ──（只带已算好的 resolution，不触发二次解析）
        var body = new JsonObject
        {
            ["model"] = resolution.ActualModel,
            ["input"] = new JsonArray(input.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()),
        };

        var raw = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Embedding,
            ExpectedModel = resolution.ActualModel,
            RequestBody = body,
        }, resolution, ct);

        if (!raw.Success || string.IsNullOrWhiteSpace(raw.Content))
        {
            _logger.LogWarning("向量化上游失败 model={Model} status={Status} body={Body}",
                resolution.ActualModel, raw.StatusCode, Truncate(raw.Content, 300));
            return EmbeddingBatch.Fail("UPSTREAM_ERROR",
                $"向量模型调用失败（HTTP {raw.StatusCode}）");
        }

        return ParseOpenAiEmbeddings(raw.Content!, input.Count, resolution);
    }

    /// <summary>
    /// 解析 OpenAI 兼容的 /embeddings 响应：{ data: [ { index, embedding: [...] } ] }。
    ///
    /// 按 index 归位而不是按返回顺序：规范允许乱序返回，真按数组顺序对回原文，
    /// 一旦上游乱序就是"A 的向量记在 B 名下"——检索永远给错答案且不报错。
    /// </summary>
    internal static EmbeddingBatch ParseOpenAiEmbeddings(
        string content, int expectedCount, GatewayModelResolution resolution)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(content);
        }
        catch (JsonException)
        {
            return EmbeddingBatch.Fail("UPSTREAM_ERROR", "向量模型返回的不是合法 JSON");
        }

        var data = root?["data"] as JsonArray;
        if (data == null || data.Count == 0)
            return EmbeddingBatch.Fail("UPSTREAM_ERROR", "向量模型返回里没有 data 数组");

        var slots = new float[expectedCount][];
        foreach (var item in data)
        {
            if (item?["embedding"] is not JsonArray arr) continue;

            // index 缺省时退回"按出现顺序"，但只要给了就以 index 为准
            var idx = item["index"]?.GetValue<int>() ?? -1;
            if (idx < 0 || idx >= expectedCount)
            {
                idx = Array.IndexOf(slots, null);
                if (idx < 0) continue;
            }

            var vec = new float[arr.Count];
            for (var i = 0; i < arr.Count; i++)
                vec[i] = (float)(arr[i]?.GetValue<double>() ?? 0d);
            slots[idx] = vec;
        }

        if (slots.Any(v => v == null))
            return EmbeddingBatch.Fail("UPSTREAM_ERROR",
                $"向量模型只返回了 {slots.Count(v => v != null)}/{expectedCount} 条向量");

        var dim = slots[0]!.Length;
        if (dim == 0)
            return EmbeddingBatch.Fail("UPSTREAM_ERROR", "向量模型返回了空向量");

        // 同一批里维度必须一致。不一致说明上游把两个模型的结果混在一起返回了，
        // 这批数据一条都不能要——混进向量库就再也分不出来了。
        if (slots.Any(v => v!.Length != dim))
            return EmbeddingBatch.Fail("DIMENSION_MISMATCH", "同一批向量维度不一致，已拒绝写入");

        return new EmbeddingBatch
        {
            Success = true,
            Vectors = slots.Select(v => v!).ToList(),
            Model = resolution.ActualModel,
            PlatformName = resolution.ActualPlatformName,
            Dimension = dim,
        };
    }

    private static string Truncate(string? s, int max)
        => string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s[..max]);
}
