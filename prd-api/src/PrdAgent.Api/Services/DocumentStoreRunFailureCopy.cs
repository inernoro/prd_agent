using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 知识库后台任务失败时，对普通用户说的那句话。
///
/// 两件事此前是错的，都在 2026-08-29 正式环境实测里现了形：
/// 1. Worker 按「Kind == Transcribe」一律当成语音转写失败，而「换个整理方式」（restyle）
///    建的也是 Transcribe run——它跳过 ASR、只重生成摘要。于是整理失败时用户收到的是
///    「语音转写暂时失败。请点击重试；原始音频已保留，不需要重新录制」：转写好好的，
///    原文一个字没动，这句话既不对、也让人以为要重录。
/// 2. 「模型没配」被当成上游暂时抖动，排进自动重试。重试一万次也是同一个结果。
///
/// 判「是不是配置问题」只认网关给的**结构化失败码**（<see cref="GatewayRouteFailure"/>），
/// 不去匹配错误文案——那份判据本来就在 GatewayRouteFailure 里写着，
/// 自己再照文案抄一份，等于把同一个判断分成两处各自漂移，而且只覆盖得到自己想到的那几种写法
/// （appCaller 未绑池、池空、平台被关，措辞各不相同，一条都匹配不上）。
/// </summary>
public static class DocumentStoreRunFailureCopy
{
    /// <summary>这一步要用的模型没配好。再点一百次也是同一个结果，所以不许自动重试。</summary>
    public const string ModelNotConfigured = "MODEL_NOT_CONFIGURED";

    /// <summary>「换个整理方式」失败：录音与原文都没动，只是这次整理没生成出来。</summary>
    public const string RestyleFailed = "RESTYLE_FAILED";

    /// <param name="Code">写进 run.FailureCode 的机器可判定分类；没有分类时为 null。</param>
    /// <param name="AutomaticRetryAllowed">这一类值不值得自动重试（配额另由 Worker 判）。</param>
    /// <param name="RetryingMessage">确定会自动重试时改说的那句；为 null 表示两种情形同一句话。</param>
    public sealed record Copy(
        string? Code,
        string UserMessage,
        bool AutomaticRetryAllowed,
        string? RetryingMessage = null)
    {
        public string MessageFor(bool willRetry)
            => willRetry && RetryingMessage != null ? RetryingMessage : UserMessage;
    }

    /// <summary>
    /// 判据顺序是有讲究的：
    /// 1. **配置类失败**优先于一切。它可能发生在 ASR 那一步，也可能发生在整理那一步；
    ///    两种都不该说「暂时失败，请点击重试」——那是把配置问题说成网络抖动，
    ///    用户按提示重试只会再失败一次（no-rootless-tree：不编一个不存在的恢复路径）。
    /// 2. 再看这条 run 到底跑的是哪一步：restyle 跳过 ASR，任何失败都与录音无关。
    /// 3. 剩下的才是真正的语音转写失败，沿用原有分档。
    /// </summary>
    public static Copy Resolve(DocumentStoreAgentRun run, Exception ex)
    {
        var routeFailureCode = ExtractRouteFailureCode(ex);
        if (GatewayRouteFailure.IsConfigurationFault(routeFailureCode)
            || (routeFailureCode == null && LooksLikeMissingModel(ex)))
        {
            return new Copy(
                ModelNotConfigured,
                $"{GatewayRouteFailure.UserMessage(routeFailureCode ?? GatewayRouteFailure.ModelPoolEmpty)}"
                    + IntactSuffix(run),
                AutomaticRetryAllowed: false);
        }

        var isRestyle = !string.IsNullOrEmpty(run.RestyleOfRunId);
        if (isRestyle)
        {
            return new Copy(
                RestyleFailed,
                "整理没能生成。录音与原文都没有改动，可以稍后再试，或换一种整理方式。",
                AutomaticRetryAllowed: false);
        }

        var isTranscription = ex is SubtitleAsrException
            || run.Kind == DocumentStoreAgentRunKind.Transcribe
            || run.Kind == DocumentStoreAgentRunKind.Subtitle;
        if (!isTranscription)
        {
            return new Copy(
                Code: null,
                "内容处理暂时失败。请稍后重试；已上传的原始内容仍会保留。",
                AutomaticRetryAllowed: true);
        }

        var failure = AudioTranscriptionUserError.Classify(ex);
        return new Copy(
            failure.Code,
            AudioTranscriptionUserError.ForRetryOutcome(failure, willRetry: false),
            failure.AutomaticRetryAllowed,
            RetryingMessage: AudioTranscriptionUserError.ForRetryOutcome(failure, willRetry: true));
    }

    /// <summary>
    /// 「你的东西还在」这句要按这条 run 处理的是什么来说。
    /// 录音链路的人最怕的是「我校对过的原文没了」，所以点名录音与原文；
    /// 而 reprocess 跑的可能是一篇普通文档，压根没有录音——对它说「录音都在」是句空话
    /// （Codex 第四十五轮 P2）。
    /// </summary>
    private static string IntactSuffix(DocumentStoreAgentRun run)
        => run.Kind is DocumentStoreAgentRunKind.Transcribe or DocumentStoreAgentRunKind.Subtitle
            ? "你的录音与原文都在，一个字没动。"
            : "已有内容没有改动。";

    /// <summary>
    /// 上游没给结构化码时的兜底：只认「没有可用模型」这一种最常见的措辞。
    /// 这是**降级路径**，不是判据——新代码一律让 <see cref="GatewayRouteFailureException"/>
    /// 或 ASR 诊断把码带出来，别再往这里加同义词（predicate-and-wiring-discipline：
    /// 同一个自由文本解析器第二次被要求加同义词，就是该换结构化字段的信号）。
    /// </summary>
    private static bool LooksLikeMissingModel(Exception ex)
    {
        var message = ex.Message ?? string.Empty;
        return message.Contains("未找到可用模型", StringComparison.OrdinalIgnoreCase)
            || message.Contains("no available model", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>网关的结构化失败码：整理那一路走类型化异常，ASR 那一路走诊断字典。</summary>
    private static string? ExtractRouteFailureCode(Exception ex)
    {
        if (ex is GatewayRouteFailureException routeFailure)
            return routeFailure.FailureCode;

        if (ex is SubtitleAsrException asr
            && asr.Diagnostic.TryGetValue(SubtitleAsrException.FailureCodesKey, out var raw)
            && raw is IEnumerable<string> codes)
        {
            // 一条链上试了几个 appCaller：只要还有一个是「上游故障」这类会自愈的，
            // 就不按配置问题收手；全是配置问题时才判死
            var all = codes.Where(c => !string.IsNullOrEmpty(c)).ToList();
            if (all.Count > 0 && all.TrueForAll(GatewayRouteFailure.IsConfigurationFault))
                return all[0];
        }

        return null;
    }
}
