using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class DocumentChunkerTests
{
    [Fact]
    public void 短文本不切块()
    {
        var chunks = DocumentChunker.Split("这是一段很短的文本。");
        Assert.Single(chunks);
        Assert.Equal("这是一段很短的文本。", chunks[0]);
    }

    [Fact]
    public void 空输入返回空表()
    {
        Assert.Empty(DocumentChunker.Split(null));
        Assert.Empty(DocumentChunker.Split(""));
        Assert.Empty(DocumentChunker.Split("   \n\n  "));
    }

    [Fact]
    public void 长文本被切成多块且每块不超过上限太多()
    {
        var text = string.Join("。", Enumerable.Range(1, 400).Select(i => $"这是第{i}句话内容"));
        var chunks = DocumentChunker.Split(text);

        Assert.True(chunks.Count > 1, "长文本必须被切开");
        // 允许略超（切点对齐会带一点尾巴），但不能失控
        Assert.All(chunks, c => Assert.True(
            c.Length <= DocumentChunker.TargetChunkSize + 100,
            $"块长 {c.Length} 超出预期上限"));
    }

    [Fact]
    public void 相邻块有重叠_答案不会被切口劈成两半()
    {
        var text = string.Join("。", Enumerable.Range(1, 300).Select(i => $"第{i}段内容说明"));
        var chunks = DocumentChunker.Split(text);

        Assert.True(chunks.Count >= 2);
        // 前一块的尾部应当能在后一块的头部找到痕迹
        var tail = chunks[0][^40..];
        Assert.Contains(tail[^10..], chunks[1][..Math.Min(200, chunks[1].Length)]);
    }

    /// <summary>
    /// 死循环守卫。切点回退到起点附近时若不强制前进，pos 永远不动——
    /// 这种死循环只在特定文本形状下触发，是那种测试不写就只能线上撞见的。
    /// </summary>
    [Fact]
    public void 无自然切点的长文本不会死循环()
    {
        // 没有任何标点和换行，逼 FindBreakPoint 走硬切分支
        var text = new string('字', DocumentChunker.TargetChunkSize * 5);

        var task = Task.Run(() => DocumentChunker.Split(text));
        Assert.True(task.Wait(TimeSpan.FromSeconds(5)), "切块疑似死循环");
        Assert.True(task.Result.Count >= 4);
    }

    [Fact]
    public void 过短的尾块并进上一块_不产生碎块()
    {
        var text = new string('甲', DocumentChunker.TargetChunkSize) + "。" + new string('乙', 10);
        var chunks = DocumentChunker.Split(text);
        Assert.All(chunks, c => Assert.True(
            c.Length >= DocumentChunker.MinChunkSize,
            $"出现了 {c.Length} 字的碎块"));
    }

    [Fact]
    public void 哈希_同内容同模型稳定()
    {
        var a = DocumentChunker.ComputeHash("一段内容", "bge-m3");
        var b = DocumentChunker.ComputeHash("一段内容", "bge-m3");
        Assert.Equal(a, b);
    }

    /// <summary>
    /// 增量建索引的核心判据：换了模型，哈希必须变。
    ///
    /// 只哈内容的话，换 embedding 模型后所有块哈希不变 → 增量逻辑认为"都没变" →
    /// 一条都不重建 → 库里永远是旧模型的向量，检索静默用错向量空间且无任何报错。
    /// </summary>
    [Fact]
    public void 哈希_换模型必须变_否则换模型后不会重建索引()
    {
        var a = DocumentChunker.ComputeHash("一段内容", "bge-m3");
        var b = DocumentChunker.ComputeHash("一段内容", "text-embedding-3-small");
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void 哈希_内容变则变()
    {
        var a = DocumentChunker.ComputeHash("一段内容", "bge-m3");
        var b = DocumentChunker.ComputeHash("另一段内容", "bge-m3");
        Assert.NotEqual(a, b);
    }

    /// <summary>
    /// 源文件里不许出现裸 NUL 字节。
    ///
    /// Review 第一轮（#1357）抓出：分隔符当初直接写成了字面 NUL 而不是 C# 转义 `\0`，
    /// git 据此把整个 .cs 判成 binary —— 之后这个文件不再有行级 diff，合并、评审、
    /// 源码扫描全部失灵。运行时哈希输入不变，所以任何行为测试都发现不了；
    /// 只有从字节层面看这个文件才看得出来。
    /// </summary>
    [Fact]
    public void 源文件不得含裸NUL字节_否则git把整个文件当二进制()
    {
        var path = LocateSource("prd-api/src/PrdAgent.Core/Models/DocumentChunker.cs");
        var bytes = File.ReadAllBytes(path);
        Assert.DoesNotContain((byte)0, bytes);
    }

    private static string LocateSource(string relative)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir); // 找不到仓库根就让用例红，而不是静默跳过
        var path = Path.Combine(dir!.FullName, relative.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(path), $"未找到被守文件：{path}");
        return path;
    }
}
