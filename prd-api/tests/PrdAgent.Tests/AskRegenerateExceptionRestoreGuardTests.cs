using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「重新生成」的异常出口也必须把 owner 的手写标记还回去（Codex 第二十四轮 P1）。
///
/// 这一发进场时清掉了 source 与版本戳两笔，还原原本只写在 await 之后。EnsureAsync
/// 只要在返回结果之前抛出（首次查库、取快照、末尾盖戳任一处失败），还原就永远不执行——
/// 站点停在「source=auto、戳为空」，owner 手写的题当场失去保护，之后任何一次自动生成
/// （配置读取、分享首访）都能覆盖掉它，而接口只回一个错误，没人知道保护已经没了。
/// 这打的正是本功能声明要守的不变量。
///
/// 为什么是源码扫描而不是行为断言：要还的那两笔由控制器方法的**控制流**决定，
/// 而 Mongo 判据那一层（AskRegenerateRestoreTests，打真库）验的是「这一笔落不落下去」，
/// 覆盖不到「异常时到底调没调它」。控制器依赖过重、无法在单测里构造，所以退而求其次
/// 扫源码——但断言的是结构（EnsureAsync 被 try 包住、catch 里还原并 rethrow），
/// 不是某一行的字面写法。删掉 try/catch 就会红。
/// </summary>
public class AskRegenerateExceptionRestoreGuardTests
{
    [Fact]
    public void 生成抛异常时必须先还原再抛出()
    {
        var source = File.ReadAllText(Path.Combine(LocateSrcRoot(),
            "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));

        // EnsureAsync 的调用必须在一个 try 块里
        var call = source.IndexOf("_askOpeners.EnsureAsync(siteId", StringComparison.Ordinal);
        Assert.True(call > 0, "没找到 EnsureAsync 调用，测试该跟着改");

        var before = source[..call];
        var lastTry = before.LastIndexOf("try", StringComparison.Ordinal);
        var lastCatch = before.LastIndexOf("catch", StringComparison.Ordinal);
        Assert.True(lastTry > lastCatch,
            "EnsureAsync 没有被 try 包住：它抛出时进场清掉的 source 与版本戳永远还不回去");

        // 紧随其后的 catch 必须还原并 rethrow
        var after = source[call..];
        var tail = after[..Math.Min(after.Length, 700)];
        Assert.Matches(new Regex(@"catch\s*\{[^}]*RestorePriorAskSourceAsync[^}]*throw;", RegexOptions.Singleline), tail);
    }

    /// <summary>还原只许有一处实现：正常出口与异常出口共用，抄两遍就会改一处忘一处。</summary>
    [Fact]
    public void 还原逻辑只有一处实现()
    {
        var source = File.ReadAllText(Path.Combine(LocateSrcRoot(),
            "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs"));

        // RestoreAskSourceFilter 是那一笔更新的判据，只应在还原方法里被用一次
        var uses = Regex.Matches(source, @"UpdateOneAsync\(RestoreAskSourceFilter\(").Count;
        Assert.True(uses == 1, $"还原被写了 {uses} 处，应当只有 RestorePriorAskSourceAsync 一处");
    }

    private static string LocateSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln"))) return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
