using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class KnowledgeRetrievalTests
{
    [Fact]
    public void 排序排除同维异模型与坏向量并有界取前五()
    {
        var rows = Enumerable.Range(0, 9).Select(i => new DocumentEmbedding
        {
            EntryId = i.ToString(), Model = "model-a", Dimension = 2,
            Text = "原文", Vector = EmbeddingVector.Encode(new[] { 1f, i * 0.1f }),
        }).ToList();
        rows.Add(new DocumentEmbedding { Model = "model-b", Dimension = 2, Vector = EmbeddingVector.Encode(new[] { 1f, 0f }) });
        rows.Add(new DocumentEmbedding { Model = "model-a", Dimension = 2, Vector = new byte[3] });
        var query = new EmbeddingBatch { Success = true, Model = "model-a", Dimension = 2, Vectors = new List<float[]> { new[] { 1f, 0f } } };
        var result = KnowledgeRetrieval.Rank(rows, query);
        Assert.Equal(5, result.Count);
        Assert.Equal(new[] { "0", "1", "2", "3", "4" }, result.Select(x => x.EntryId));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[0]")]
    [InlineData("[1,999]")]
    [InlineData("我猜测答案是42 [1]")]
    [InlineData("```json\n[1]\n```")]
    [InlineData("null")]
    public void 没有可验证选择就拒答(string output)
        => Assert.Equal(KnowledgeRetrieval.Refusal, KnowledgeRetrieval.Answer(output, new[] { Hit() }));

    [Fact]
    public void 输出只包含服务器摘录和固定原文链接()
    {
        var hit = Hit() with { Text = "原文含 [恶意链接](https://evil.example) 和 <script>。" };
        var answer = KnowledgeRetrieval.Answer("[1,1]", new[] { hit });
        Assert.Contains("/document-store?store=store&entry=entry", answer);
        Assert.Contains(@"\[恶意链接\]\(https://evil\.example\)", answer);
        Assert.DoesNotContain("[引用:", answer);
        Assert.Single(KnowledgeRetrieval.Select("[1,1]", 1));
    }

    private static KnowledgeHit Hit() => new("store", "entry", "标题", 0, "有依据的原文", "hash", "model-a", 1);
}
