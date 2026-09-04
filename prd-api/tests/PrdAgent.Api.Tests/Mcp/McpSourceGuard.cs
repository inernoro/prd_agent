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
    /// 按目录枚举被守文件（返回仓库相对路径）。
    ///
    /// 存在的理由是一次真实漏检：上一版幂等键守卫把三个开放层控制器的路径**写死**在
    /// [InlineData] 里，于是第四个（文学创作）从一开始就不在守卫视野里，同一处截断
    /// 缺陷在那儿又活了一轮，靠自动 review 才捞出来。枚举比清单可靠 —— 新增一个
    /// 开放层控制器时，它自动进闸，不需要谁记得回来补一行。
    /// </summary>
    public static string[] EnumerateRelative(string repoRelativeDir, string searchPattern)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))) dir = dir.Parent;
        dir.ShouldNotBeNull("找不到仓库根，无法枚举被守文件");
        var full = Path.Combine(dir!.FullName, repoRelativeDir);
        Directory.Exists(full).ShouldBeTrue($"被守目录不在了：{repoRelativeDir}（改名了就同步改这里）");
        var found = Directory.GetFiles(full, searchPattern)
            .Select(f => Path.GetRelativePath(dir.FullName, f).Replace('\\', '/'))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToArray();
        found.Length.ShouldBeGreaterThan(0, $"{repoRelativeDir} 下没有匹配 {searchPattern} 的文件，守卫等于空转");
        return found;
    }

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
