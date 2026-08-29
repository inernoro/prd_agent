using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 知识库后台任务失败时，对普通用户说的那句话。
///
/// 为什么单独一个类：此前 Worker 把「Kind == Transcribe」一律当成语音转写失败，
/// 而「换个整理方式」（restyle）建的也是 Transcribe run——它跳过 ASR、只重生成摘要。
/// 于是整理失败时用户收到的是「语音转写暂时失败。请点击重试；原始音频已保留，不需要重新录制」：
/// 转写明明好好的，原文一个字没动，这句话既不对、也让人以为要重录。
/// 2026-08-29 正式环境实测复现：run 停在「生成摘要」，服务端异常是
/// 「未找到可用模型: AppCallerCode=document-store.transcribe-summary::chat」。
/// </summary>
public static class DocumentStoreRunFailureCopy
{
    /// <summary>这一步要用的模型没配。再点一百次也是同一个结果，所以不许自动重试。</summary>
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
    /// 1. **模型没配**优先于一切。它可能发生在 ASR 那一步，也可能发生在整理那一步；
    ///    两种都不该说「暂时失败，请点击重试」——那是把配置问题说成网络抖动，
    ///    用户按提示重试只会再失败一次（no-rootless-tree：不编一个不存在的恢复路径）。
    /// 2. 再看这条 run 到底跑的是哪一步：restyle 跳过 ASR，任何失败都与录音无关。
    /// 3. 剩下的才是真正的语音转写失败，沿用原有分档。
    /// </summary>
    public static Copy Resolve(DocumentStoreAgentRun run, Exception ex)
    {
        if (LooksLikeMissingModel(ex))
        {
            return new Copy(
                ModelNotConfigured,
                "这一步需要的模型还没有配置可用的，已经停下不再重试；你的录音与原文都在，一个字没动。请联系管理员在模型池里配好之后再试。",
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
    /// 「没有可用模型」的形状。网关在候选耗尽或池未配置时抛的就是这句中文；
    /// 英文那两种写法一起认，免得换个上游实现判据就漏（形状 1：判据比它该管的范围窄）。
    /// </summary>
    private static bool LooksLikeMissingModel(Exception ex)
    {
        var message = ex.Message ?? string.Empty;
        return message.Contains("未找到可用模型", StringComparison.OrdinalIgnoreCase)
            || message.Contains("没有可用模型", StringComparison.OrdinalIgnoreCase)
            || message.Contains("no available model", StringComparison.OrdinalIgnoreCase)
            || message.Contains("no usable model", StringComparison.OrdinalIgnoreCase);
    }
}
