using System;
using System.IO;
using System.Linq;
using Shouldly;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 源码守卫的共用件。
///
/// 为什么要有源码守卫：接入台这一块反复出现「删掉之后全量测试照样绿」的接线 ——
/// 额度用哪个取消令牌、审计行从哪个主体取主人、覆盖正文有没有带乐观并发条件。
/// 这些都不是行为能在单测里复现的东西（要么得让 Mongo 与驱动在同一微秒里赛跑，
/// 要么得起半个鉴权管线），但它们坏掉的代价是真实的。
///
/// 三个共用件放一处，是因为这套助手已经被抄到第三个文件了 —— 判据分裂的老形状，
/// 抄三份迟早各漂各的。
/// </summary>
internal static class McpSourceGuard
{
    /// <summary>按仓库相对路径读源码。文件改名了就同步改调用处，别把断言删掉。</summary>
    public static string Read(string repoRelativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))) dir = dir.Parent;
        dir.ShouldNotBeNull("找不到仓库根，无法做源码守卫");
        var full = Path.Combine(dir!.FullName, repoRelativePath);
        File.Exists(full).ShouldBeTrue($"被守的文件不在了：{repoRelativePath}（改名了就同步改这里）");
        return File.ReadAllText(full);
    }

    /// <summary>
    /// 去掉注释行再判。
    ///
    /// 不去掉的话，被守那处的**解释文字**就能左右结论：ShouldNotContain 会被一句
    /// 「不是 http.User」判红（真发生过），ShouldContain 则更糟 —— 注释满足断言，守卫假绿。
    /// </summary>
    public static string StripComments(string source) => string.Join('\n',
        source.Split('\n').Where(line => !line.TrimStart().StartsWith("//", StringComparison.Ordinal)));

    /// <summary>
    /// 切出一段（含注释）。从**定义**切，不是从第一次出现 —— 后者常常是调用点。
    /// 切不出来直接判红：守卫盯的东西改名了，比断言悄悄落空好。
    /// </summary>
    public static string Slice(string source, string beginMarker, string endMarker)
    {
        var begin = source.IndexOf(beginMarker, StringComparison.Ordinal);
        begin.ShouldBeGreaterThanOrEqualTo(0, $"源码里找不到 {beginMarker}（改名了就同步改这里）");
        var end = source.IndexOf(endMarker, begin, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(begin, $"源码里找不到 {endMarker}（改名了就同步改这里）");
        return source[begin..end];
    }
}
