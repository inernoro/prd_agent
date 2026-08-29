using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 错误流块转异常时，**结构化失败码不许被丢掉**。
///
/// 背景（2026-08-29）：网关解析失败时会给出 `GatewayRouteFailure` 的结构化码
///（appCaller 未绑池 / 池空 / 平台被关 …），业务层据它区分「配置没配好」与「上游暂时抖动」——
/// 前者重试一万次也好不了，说「请点击重试」是骗人的。
/// 但把 error 块转成异常这件事，几个 Worker 各写各的：一处带了码，另一处仍然
/// `new InvalidOperationException($"...{chunk.ErrorMessage}")` 只搬文案，
/// 于是那条链路上的配置失败照旧被判成暂时故障，为它写的文案分支永远走不到
/// （predicate-and-wiring-discipline 形状 2：建了一半，删掉不会红；Codex 两轮各抓到一处）。
///
/// 这条守卫扫全仓：谁再手工拼 `chunk.ErrorMessage` 抛异常，这里就红，
/// 提示改用 `GatewayRouteFailureException.FromChunk`。
/// </summary>
public class GatewayErrorChunkCodeGuardTests
{
    /// <summary>
    /// 手工把错误块文案塞进异常的形状：`new XxxException(...chunk.ErrorMessage...)`。
    /// 插值写法与 `?? 兜底` 写法都算——两种都把码丢了。
    /// </summary>
    private static readonly Regex HandRolled = new(
        @"new\s+\w*Exception\s*\([^;]{0,200}?\w*[Cc]hunk\.ErrorMessage",
        RegexOptions.Compiled);

    /// <summary>
    /// 缓迁清单：这些调用点也丢码，但它们的失败文案链路目前**不读**结构化码，
    /// 改造前要先确认各自下游怎么用这句话（贸然改会动到用户可见文案）。
    /// 记在这里而不是把判据放宽——放宽了，新写的调用点就再也不会红。
    /// 对应台账：doc/debt.knowledge-base.md「错误码在转异常时被丢掉」。
    /// </summary>
    private static readonly string[] PendingMigration =
    [
        "prd-api/src/PrdAgent.Api/Controllers/Api/ModelLabController.cs",
        "prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs",
        "prd-api/src/PrdAgent.Api/Controllers/Api/PlatformsController.cs",
        "prd-api/src/PrdAgent.Api/Services/ArenaRunWorker.cs",
        "prd-api/src/PrdAgent.Infrastructure/Services/ModelDomainService.cs",
        "prd-api/src/PrdAgent.Infrastructure/Services/VisualAgent/MultiImageComposeService.cs",
        "prd-api/src/PrdAgent.Infrastructure/Services/VisualAgent/ImageDescriptionService.cs",
    ];

    [Fact]
    public void 错误块转异常必须走统一工厂()
    {
        var root = RepoRoot();
        var offenders = new List<string>();
        foreach (var file in Directory.EnumerateFiles(
                     Path.Combine(root, "prd-api", "src"), "*.cs", SearchOption.AllDirectories))
        {
            var text = StripComments(File.ReadAllText(file));
            if (!HandRolled.IsMatch(text)) continue;
            var rel = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (Array.Exists(PendingMigration, p => p == rel)) continue;
            offenders.Add(rel);
        }

        Assert.True(
            offenders.Count == 0,
            "这些地方把 error 流块的文案拼进异常却丢了 ErrorCode，改用 "
                + "GatewayRouteFailureException.FromChunk(chunk, \"场景前缀\")："
                + string.Join(", ", offenders));
    }

    [Fact]
    public void 判据本身能认出坏形状()
    {
        // 判据自己要会红：否则上面那条永远绿，等于没有守卫
        Assert.Matches(HandRolled, "throw new InvalidOperationException($\"LLM 调用失败: {chunk.ErrorMessage}\");");
        Assert.Matches(HandRolled, "throw new InvalidOperationException(chunk.ErrorMessage ?? \"LLM_ERROR\");");
        Assert.DoesNotMatch(HandRolled, "throw GatewayRouteFailureException.FromChunk(chunk, \"LLM 调用失败\");");
    }

    [Fact]
    public void 缓迁清单不许含已经改好的文件()
    {
        // 清单是欠账，不是免死金牌：文件改好了却留在清单里，下次退回去也不会红
        var root = RepoRoot();
        foreach (var rel in PendingMigration)
        {
            var full = Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(full), $"缓迁清单里的文件不存在，清理它：{rel}");
            Assert.True(
                HandRolled.IsMatch(StripComments(File.ReadAllText(full))),
                $"{rel} 已经不丢码了，把它从缓迁清单里删掉");
        }
    }

    /// <summary>
    /// 注释先剃掉再扫。不剃的话，讲清楚这条守卫在防什么的那段注释（里面必然要写出坏形状）
    /// 会把定义工厂的那个文件自己判红——一条会误报的守卫，很快就会被人加白名单绕过去。
    /// </summary>
    private static string StripComments(string source)
    {
        var withoutBlock = Regex.Replace(source, @"/\*.*?\*/", string.Empty, RegexOptions.Singleline);
        return Regex.Replace(withoutBlock, @"^\s*//.*$", string.Empty, RegexOptions.Multiline);
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
