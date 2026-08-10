namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 文本向量化。走 LLM 网关的 embedding 通路，因此模型池调度、健康管理、
/// 请求日志、成本归属全部与其它模型调用同一套，不另开一条私链。
///
/// 「换一个 embedding 供应商」的正常路径是**加一行配置**，不是改代码：
/// 只要对方是 OpenAI 兼容的 /embeddings（OpenAI / 硅基流动 / Jina / DashScope /
/// Voyage / 本地 TEI、Ollama、vLLM 都是），在后台加一个平台 + 一个 modelType=embedding
/// 的模型即可。形状不兼容的供应商才需要新增 wire adapter。
/// </summary>
public interface IEmbeddingService
{
    /// <summary>
    /// 批量向量化。返回的每条向量都带着「哪个模型算的、多少维」——
    /// 这两个值必须跟着向量一路存下去，见 <see cref="EmbeddingBatch.Model"/> 的说明。
    /// </summary>
    Task<EmbeddingBatch> EmbedAsync(
        IReadOnlyList<string> texts,
        string appCallerCode,
        CancellationToken ct = default);

    /// <summary>
    /// 当前生效的 embedding 模型标识（不发向量化请求，只做解析）。
    /// 用于建索引前判断「模型有没有换过」，以及在配置界面如实显示当前用的是谁。
    /// 没有可用的 embedding 模型时返回 null —— 调用方必须据此如实告知用户
    /// 「还没接入向量模型」，不许静默退化成别的模型类型。
    /// </summary>
    Task<string?> ResolveActiveModelAsync(string appCallerCode, CancellationToken ct = default);
}

/// <summary>一批文本的向量化结果。</summary>
public class EmbeddingBatch
{
    public bool Success { get; init; }

    /// <summary>失败原因（面向用户的中文）</summary>
    public string? Error { get; init; }

    /// <summary>错误码：NO_EMBEDDING_MODEL / UPSTREAM_ERROR / DIMENSION_MISMATCH / EMPTY_INPUT</summary>
    public string? ErrorCode { get; init; }

    /// <summary>
    /// 与入参 texts 一一对应、顺序一致的向量。
    /// 顺序是契约的一部分：上游按 index 返回，我们按 index 对回原文，
    /// 一旦错位就是「A 的向量存到 B 名下」，检索结果会稳定地牛头不对马嘴且不报错。
    /// </summary>
    public List<float[]> Vectors { get; init; } = new();

    /// <summary>
    /// 算这批向量的模型标识。
    ///
    /// **必须跟着向量一起持久化。** 不同模型的向量空间互不相容：把 bge-m3(1024维) 的向量
    /// 和 text-embedding-3-small(1536维) 的向量放进同一次相似度计算，维度不同会直接崩，
    /// 维度碰巧相同则更糟——余弦算得出数字，但那个数字毫无意义，表现为「检索质量莫名其妙变差」，
    /// 没有任何报错可查。所以换模型 = 存量向量全部作废重建。
    /// </summary>
    public string Model { get; init; } = string.Empty;

    /// <summary>平台名（展示 + 排障用）</summary>
    public string? PlatformName { get; init; }

    /// <summary>向量维度（== Vectors[i].Length，冗余出来便于建索引时快速比对）</summary>
    public int Dimension { get; init; }

    public static EmbeddingBatch Fail(string code, string message)
        => new() { Success = false, ErrorCode = code, Error = message };
}
