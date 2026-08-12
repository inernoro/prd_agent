using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 向量编解码 + 跨模型污染守卫。
///
/// 这一族错误的共同点是**不报错**：维度碰巧相同的两个模型，余弦照算、排序照出，
/// 只是结果没有意义。线上表现为"检索质量莫名其妙下降"，没有异常、没有日志、
/// 没有任何可查的东西。所以判据必须在这里被钉死。
/// </summary>
public class EmbeddingVectorTests
{
    [Fact]
    public void 编解码往返不丢精度()
    {
        var original = new[] { 0.1f, -0.5f, 0.333f, 1f, -1f, 0f };
        var restored = EmbeddingVector.Decode(EmbeddingVector.Encode(original));
        Assert.Equal(original, restored);
    }

    [Fact]
    public void 解码空字节得到空向量而不是崩溃()
    {
        Assert.Empty(EmbeddingVector.Decode(Array.Empty<byte>()));
        Assert.Empty(EmbeddingVector.Decode(null!));
    }

    [Fact]
    public void 同模型同维度_判为兼容()
    {
        Assert.True(EmbeddingVector.IsCompatible("bge-m3", 1024, "bge-m3", 1024));
    }

    /// <summary>
    /// 本文件存在的核心理由：两个**不同模型**恰好都是 1024 维时，绝不能判兼容。
    /// 只看维度的实现会在这里放行，然后把两个向量空间的数据混在一起算余弦。
    /// </summary>
    [Fact]
    public void 不同模型即使维度相同_也必须判为不兼容()
    {
        Assert.False(EmbeddingVector.IsCompatible("bge-m3", 1024, "jina-embeddings-v3", 1024));
    }

    [Fact]
    public void 同模型不同维度_判为不兼容()
    {
        // 同一个模型也可能支持 Matryoshka 截断（1024 / 512 / 256），截断档不同就是不同空间
        Assert.False(EmbeddingVector.IsCompatible("bge-m3", 1024, "bge-m3", 512));
    }

    [Fact]
    public void 模型名大小写不敏感()
    {
        Assert.True(EmbeddingVector.IsCompatible("BGE-M3", 1024, "bge-m3", 1024));
    }

    [Fact]
    public void 零维度一律不兼容()
    {
        Assert.False(EmbeddingVector.IsCompatible("bge-m3", 0, "bge-m3", 0));
    }

    [Fact]
    public void 余弦_相同向量为1_正交为0_相反为负1()
    {
        var a = new[] { 1f, 0f, 0f };
        var b = new[] { 0f, 1f, 0f };
        var c = new[] { -1f, 0f, 0f };

        Assert.Equal(1d, EmbeddingVector.Cosine(a, a), 5);
        Assert.Equal(0d, EmbeddingVector.Cosine(a, b), 5);
        Assert.Equal(-1d, EmbeddingVector.Cosine(a, c), 5);
    }

    [Fact]
    public void 余弦_不假设已归一化()
    {
        // 同方向不同模长必须仍然是 1：换供应商时"对方有没有归一化"最容易想当然
        var a = new[] { 3f, 4f };
        var scaled = new[] { 30f, 40f };
        Assert.Equal(1d, EmbeddingVector.Cosine(a, scaled), 5);
    }

    [Fact]
    public void 余弦_维度不等或空向量返回0而不是崩溃()
    {
        Assert.Equal(0d, EmbeddingVector.Cosine(new[] { 1f, 2f }, new[] { 1f }));
        Assert.Equal(0d, EmbeddingVector.Cosine(Array.Empty<float>(), Array.Empty<float>()));
        Assert.Equal(0d, EmbeddingVector.Cosine(new[] { 0f, 0f }, new[] { 1f, 1f }));
    }

    /// <summary>
    /// embedding 必须在专属池不可用时失败关闭。
    ///
    /// 不在这个名单里的后果：没配 embedding 池时会掉到 legacy 直连兜底，
    /// 很可能拿一个 chat 模型去打 /embeddings。要么 404，要么某些兼容层真回一串数字——
    /// 后者会被当成向量写进库，从此这批脏数据和好数据混在一个集合里，事后分不出来。
    /// </summary>
    [Fact]
    public void embedding_专属池不可用时必须失败关闭()
    {
        Assert.True(ModelResolver.ShouldFailClosedWhenDedicatedPoolUnavailable(ModelTypes.Embedding));
    }

    [Fact]
    public void chat_仍允许降级兜底()
    {
        // 对照组：chat 拿错模型顶多是回答风格变了，用户看得见，不属于静默污染
        Assert.False(ModelResolver.ShouldFailClosedWhenDedicatedPoolUnavailable(ModelTypes.Chat));
    }

    /// <summary>
    /// 上面那条判据只在「认定有专属绑定」时才被查。所以绑定判据本身写窄一格，
    /// 整条失败关闭就等于没有——这是 predicate-and-wiring-discipline 形状 1。
    ///
    /// 具体窄法：拿「按 id 查回来的池数量 > 0」当「有绑定」。绑定的池被删掉时查回 0 条，
    /// 于是判成「没绑定」，解析继续往默认池 / expectedModel 直连 / legacy 走，
    /// embedding 照样能拿到 chat 模型——正是失败关闭要拦的那一种情况。
    /// </summary>
    [Fact]
    public void 绑定的池被删掉后仍算有专属绑定()
    {
        // 配置里绑了两个池 id，但库里一个都查不到（被删 / 跨库迁移遗留）
        Assert.True(ModelResolver.HasDedicatedBinding(new[] { "pool-已删除", "pool-也没了" }));
    }

    [Fact]
    public void 压根没绑定才算没有专属绑定()
    {
        Assert.False(ModelResolver.HasDedicatedBinding(null));
        Assert.False(ModelResolver.HasDedicatedBinding(Array.Empty<string>()));
    }
}
