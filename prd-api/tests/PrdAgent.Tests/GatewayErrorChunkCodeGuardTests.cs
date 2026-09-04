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
    /// 手工把上游错误文案塞进异常的形状：`new XxxException(... 某个东西.ErrorMessage ...)`。
    /// 插值写法与 `?? 兜底` 写法都算——两种都把码丢了。
    ///
    /// **不认变量名**：此前判据写成 `\w*[Cc]hunk\.ErrorMessage`，于是同样的循环换个变量名
    /// （`response` / `part` / `item`）写就照样绿——判据比它该管的范围窄
    /// （形状 1；Codex 第四十七轮 P1）。代价是会扫到 `.ErrorMessage` 的非网关对象，
    /// 那种逐条记进下面的台账并写明为什么。
    /// </summary>
    private static readonly Regex HandRolled = new(
        @"new\s+\w*Exception\s*\([^;]{0,200}?\w+\??\.ErrorMessage",
        RegexOptions.Compiled);

    /// <summary>
    /// 存量台账：文件 + **这个文件现在有几处**。
    ///
    /// 记数而不是记文件名：只记文件名的话，这些文件后来新增的同类写法会被整片豁免，
    /// 而「清单里的文件仍然违规」那条用例照样绿——豁免就成了免死金牌
    /// （Codex 第四十七轮 P2）。记了数，多一处、少一处都会红，逼着人来更新这张表。
    ///
    /// 两类，理由不同：
    /// - 「待迁」：确实是网关的流块 / 解析结果 / 响应，码就在手边却没带上。
    ///   它们的失败文案链路目前不读这个码，改造前要逐个确认下游怎么用这句话。
    /// - 「非网关」：`.ErrorMessage` 属于别的领域对象，判据靠文本分不出来，如实记着。
    /// 对应台账：doc/debt.knowledge-base.md「错误码在转异常时被丢掉」。
    /// </summary>
    private static readonly (string Path, int Count, string Why)[] Ledger =
    [
        ("prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs", 1, "待迁：流块"),
        ("prd-api/src/PrdAgent.Api/Controllers/Api/ModelLabController.cs", 1, "待迁：流块"),
        ("prd-api/src/PrdAgent.Api/Controllers/Api/PlatformsController.cs", 1, "待迁：流块"),
        ("prd-api/src/PrdAgent.Api/Controllers/Api/ProjectRouteAgentController.cs", 1, "待迁：网关响应"),
        ("prd-api/src/PrdAgent.Api/Services/ArenaRunWorker.cs", 1, "待迁：流块"),
        ("prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs", 1, "待迁：解析结果"),
        ("prd-api/src/PrdAgent.Api/Services/TranscriptRunWorker.cs", 2, "待迁：解析结果 + 网关响应"),
        ("prd-api/src/PrdAgent.Api/Services/ReportAgent/WorkflowExecutionService.cs", 1, "非网关：工作流执行记录自己的错误"),
        ("prd-api/src/PrdAgent.Infrastructure/Services/ModelDomainService.cs", 1, "待迁：流块"),
        ("prd-api/src/PrdAgent.Infrastructure/Services/Poster/PosterAutopilotService.cs", 1, "待迁：网关响应"),
        ("prd-api/src/PrdAgent.Infrastructure/Services/VisualAgent/ImageDescriptionService.cs", 1, "待迁：流块"),
        ("prd-api/src/PrdAgent.Infrastructure/Services/VisualAgent/MultiImageComposeService.cs", 1, "待迁：流块"),
    ];

    [Fact]
    public void 错误块转异常必须走统一工厂()
    {
        var root = RepoRoot();
        var actual = ScanCounts(root);
        var expected = Ledger.ToDictionary(e => e.Path, e => e.Count);
        var complaints = new List<string>();

        foreach (var (path, count) in actual)
        {
            var allowed = expected.TryGetValue(path, out var n) ? n : 0;
            if (count > allowed)
                complaints.Add($"{path}: 现有 {count} 处，台账只认 {allowed} 处");
        }
        foreach (var (path, n) in expected)
        {
            var count = actual.TryGetValue(path, out var c) ? c : 0;
            if (count < n)
                complaints.Add($"{path}: 已减到 {count} 处，把台账改小（或删掉这一行）");
        }

        Assert.True(
            complaints.Count == 0,
            "把上游错误文案拼进异常却丢了 ErrorCode。新写的改用 "
                + "GatewayRouteFailureException.FromChunk(chunk, \"场景前缀\")；"
                + "存量在 Ledger 里按文件记数，动了就要更新：\n  "
                + string.Join("\n  ", complaints));
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
    public void 判据不认变量名()
    {
        // 换个变量名写同样的东西，判据一样要认——否则「全仓不变式」只是嘴上说说
        Assert.Matches(HandRolled, "throw new InvalidOperationException(response.ErrorMessage ?? \"LLM_ERROR\");");
        Assert.Matches(HandRolled, "throw new InvalidOperationException($\"失败: {part?.ErrorMessage}\");");
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

    /// <summary>扫出每个文件现在有几处（剃掉注释之后再数）。</summary>
    private static Dictionary<string, int> ScanCounts(string root)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var file in Directory.EnumerateFiles(
                     Path.Combine(root, "prd-api", "src"), "*.cs", SearchOption.AllDirectories))
        {
            var n = HandRolled.Matches(StripComments(File.ReadAllText(file))).Count;
            if (n == 0) continue;
            counts[Path.GetRelativePath(root, file).Replace('\\', '/')] = n;
        }
        return counts;
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
