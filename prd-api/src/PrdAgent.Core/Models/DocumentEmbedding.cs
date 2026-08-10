using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库文档切块的向量。
///
/// 存储选型：本部署是自建 mongo:8.0 Community + redis:7-alpine（docker-compose.yml），
/// **没有** Atlas Vector Search，Redis 也不是 Redis Stack。所以 debt.knowledge-base.md K-2
/// 里「建议 Atlas Vector Search」在这套环境上不成立，不能照抄。
/// 实际做法：向量存 Mongo、按作用域先过滤再进程内算余弦。按真实规模（挂进来的通常是
/// 1-3 个库、最大的 MAP 库 330 篇 4.24MB ≈ 5 千余块）这条路完全够用，且零新基建。
/// 规模上限与迁移路径写在 doc/debt.knowledge-base.md。
/// </summary>
[BsonIgnoreExtraElements]
public class DocumentEmbedding
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属知识库（检索的作用域过滤就打在这个字段上）</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>所属文档</summary>
    public string EntryId { get; set; } = string.Empty;

    /// <summary>文档标题快照（检索结果要显示"出自哪篇"，避免每次回表）</summary>
    public string EntryTitle { get; set; } = string.Empty;

    /// <summary>本块在文档内的序号（从 0 开始）</summary>
    public int ChunkIndex { get; set; }

    /// <summary>切块原文。回答要引用原句，所以必须存下来，不能只存向量。</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>
    /// 向量本体，float32 小端字节序。
    ///
    /// 不用 double[]：一个 1024 维向量做 BSON double 数组是 8KB+ 且解析慢，
    /// 5 千块就是 40MB+。存成 BinData 后减半且反序列化几乎零开销。
    /// 读写一律走 <see cref="EmbeddingVector"/>，不要在别处自己 BitConverter。
    /// </summary>
    public byte[] Vector { get; set; } = Array.Empty<byte>();

    /// <summary>
    /// 算这条向量的模型标识。**检索时必须按它过滤。**
    ///
    /// 不同模型的向量空间互不相容。维度不同会当场崩（还算好事）；维度碰巧相同
    /// （比如两个都是 1024 维的模型）则算得出余弦、给得出排序，但那个排序毫无意义——
    /// 没有任何异常、没有任何日志，只表现为"检索结果莫名其妙不准"。
    /// 所以换模型之后存量向量一律作废重建，见 EmbeddingVector.IsCompatible。
    /// </summary>
    public string Model { get; set; } = string.Empty;

    /// <summary>向量维度。与 Model 一起构成兼容性判据。</summary>
    public int Dimension { get; set; }

    /// <summary>
    /// 切块原文的哈希。增量建索引靠它：内容没变就不重算，省钱也省时间。
    /// </summary>
    public string ContentHash { get; set; } = string.Empty;

    /// <summary>
    /// 部署作用域。共享 Mongo 下分支预览与生产读写同一个库，不盖戳的话
    /// 分支预览建的索引会混进生产检索（cross-project-isolation 通道 4 同款）。
    /// 生产为 null，兼容存量。
    /// </summary>
    public string? DeploymentSlug { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 向量的编解码与相似度计算。**唯一**的向量字节序入口——
/// 抽成一处是因为「编码方式」和「兼容性判据」被抄散了就必然漂移，
/// 而这两件事漂移的表现都是"不报错但结果不对"。
/// </summary>
public static class EmbeddingVector
{
    /// <summary>float[] → 字节（float32 小端）</summary>
    public static byte[] Encode(float[] vector)
    {
        var bytes = new byte[vector.Length * sizeof(float)];
        Buffer.BlockCopy(vector, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    /// <summary>字节 → float[]</summary>
    public static float[] Decode(byte[] bytes)
    {
        if (bytes == null || bytes.Length == 0) return Array.Empty<float>();
        var vector = new float[bytes.Length / sizeof(float)];
        Buffer.BlockCopy(bytes, 0, vector, 0, vector.Length * sizeof(float));
        return vector;
    }

    /// <summary>
    /// 这条存量向量能不能和「当前模型算出来的查询向量」放在一起比。
    ///
    /// 判据是**模型标识 + 维度都相等**，不是只看维度。只看维度会让两个恰好同维的
    /// 不同模型互相"兼容"，那正是本文件反复警告的静默污染。
    /// </summary>
    public static bool IsCompatible(string storedModel, int storedDimension, string queryModel, int queryDimension)
        => storedDimension > 0
           && storedDimension == queryDimension
           && string.Equals(storedModel, queryModel, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 余弦相似度。两个向量都已 L2 归一化时等价于点积，但这里不假设归一化——
    /// 换供应商时"对方到底归没归一化"是最容易想当然的一点，老老实实除模长。
    /// </summary>
    public static double Cosine(float[] a, float[] b)
    {
        if (a.Length == 0 || a.Length != b.Length) return 0d;

        double dot = 0, na = 0, nb = 0;
        for (var i = 0; i < a.Length; i++)
        {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na <= 0 || nb <= 0) return 0d;
        return dot / (Math.Sqrt(na) * Math.Sqrt(nb));
    }
}
