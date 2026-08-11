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

    /// <remarks>
    /// 这条只做解析、不向上游发任何东西、也不写库，所以照常尊重调用方的 ct——
    /// server-authority 管的是「已经发出去、可能已计费的调用不许被被动断开取消」，
    /// 把一次纯查询也禁掉属于过度修正。真正发出去的那条在 EmbedAsync 里，用 None。
    /// </remarks>
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
        IReadOnlyList<string> texts, string appCallerCode, string userId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userId))
            return EmbeddingBatch.Fail("EMPTY_INPUT", "缺少发起方身份，无法向量化");

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
        //
        // 解析与发送都走 CancellationToken.None，不转发调用方的 ct。
        // server-authority 规则：客户端被动断开（或 worker 关停令牌触发）不得取消已经发出去的
        // 模型调用——上游可能已经受理并计费，取消只会让下一次重试重复付一遍钱，而结果谁也没拿到。
        // 入参的 ct 保留在签名里，供调用方做「排队阶段」的编排取消，不往网关里传。
        var resolution = await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.Embedding, ct: CancellationToken.None);
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
            // Context 必须显式填：http 模式下这条请求要跨进程，进程内的 LlmRequestContext
            // 过不去，serving 侧拿不到 UserId 会以 "User not found" 拒掉，账单也挂不到人头上。
            Context = new GatewayRequestContext
            {
                RequestId = Guid.NewGuid().ToString("N"),
                UserId = userId,
            },
            RequestBody = body,
        }, resolution, CancellationToken.None);

        if (!raw.Success || string.IsNullOrWhiteSpace(raw.Content))
        {
            _logger.LogWarning("向量化上游失败 model={Model} status={Status} body={Body}",
                resolution.ActualModel, raw.StatusCode, Truncate(raw.Content, 300));
            return EmbeddingBatch.Fail("UPSTREAM_ERROR",
                $"向量模型调用失败（HTTP {raw.StatusCode}）");
        }

        // 贴标签用**真正成功的那个候选**，不是发之前算出来的那个。
        // 网关在候选可重试失败时会换一个模型再发；这时 raw.Resolution 才是算出这批向量的模型。
        // 拿 pre-send 的 resolution 贴，就是「B 算的向量记成 A 名下」——存进库之后
        // 兼容性检查会拿两个不同向量空间当同一个比，检索静默出错且事后分辨不出来。
        return ParseOpenAiEmbeddings(raw.Content!, input.Count, raw.Resolution ?? resolution);
    }

    /// <summary>
    /// 解析 OpenAI 兼容的 /embeddings 响应：{ data: [ { index, embedding: [...] } ] }。
    ///
    /// 按 index 归位而不是按返回顺序：规范允许乱序返回，真按数组顺序对回原文，
    /// 一旦上游乱序就是"A 的向量记在 B 名下"——检索永远给错答案且不报错。
    /// </summary>
    /// <summary>
    /// 读取 data[i].index：只接受「无小数部分、落在 Int32 内」的 JSON 数字。
    /// 字符串 / null / 小数 / 超界一律判假，由调用方整批拒绝。
    /// </summary>
    private static bool TryReadIndex(JsonNode node, out int value)
    {
        value = -1;
        if (node is not JsonValue jv) return false;
        if (jv.TryGetValue(out int i)) { value = i; return true; }
        if (jv.TryGetValue(out double d) && d >= int.MinValue && d <= int.MaxValue && Math.Abs(d % 1) < double.Epsilon)
        {
            value = (int)d;
            return true;
        }
        return false;
    }

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

            // index 缺省（字段不存在）才退回"按出现顺序"填第一个空位。
            //
            // 给了却越界是另一回事：那说明上游的应答与我们发出去的这批输入对不上，
            // 把它当"没给"塞进第一个空位，等于**猜**它属于哪条原文——猜错就是
            // 「A 的向量记在 B 名下」，写进库之后余弦照算、不报错，检索永远给错答案。
            // 整批拒绝，不猜。
            var indexNode = item["index"];
            int idx;
            if (indexNode == null)
            {
                idx = Array.IndexOf(slots, null);
                if (idx < 0)
                    return EmbeddingBatch.Fail("UPSTREAM_ERROR", "向量模型返回的条数多于请求的文本数");
            }
            else
            {
                // 只有「合法整数」才走 index 路径。字符串、null、小数、超出 Int32 的值
                // 都会让 GetValue<int>() 抛异常——而这里只 catch 了 JSON 解析本身，
                // 异常会一路穿透成未处理的服务异常 / 批任务失败，而不是一条 UPSTREAM_ERROR。
                // 一个不兼容的供应商应答不该把调用方打崩。
                if (!TryReadIndex(indexNode, out idx))
                    return EmbeddingBatch.Fail("UPSTREAM_ERROR",
                        $"向量模型返回的 index 不是整数（{Truncate(indexNode.ToJsonString(), 40)}），已整批拒绝");
                if (idx < 0 || idx >= expectedCount)
                    return EmbeddingBatch.Fail("UPSTREAM_ERROR",
                        $"向量模型返回了越界的 index {idx}（本批共 {expectedCount} 条），已整批拒绝");
                if (slots[idx] != null)
                    return EmbeddingBatch.Fail("UPSTREAM_ERROR",
                        $"向量模型对 index {idx} 返回了两条向量，已整批拒绝");
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
