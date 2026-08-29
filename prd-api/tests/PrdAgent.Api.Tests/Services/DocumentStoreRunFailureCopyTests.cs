using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 「失败了该跟用户说哪句话」的判定。三条都对应 2026-08-29 正式环境实测到的那次失败：
/// 用户点了「一键整理」，run 停在「生成摘要」，服务端异常是「未找到可用模型」，
/// 而用户看到的却是「语音转写暂时失败。请点击重试；原始音频已保留，不需要重新录制」。
/// </summary>
public class DocumentStoreRunFailureCopyTests
{
    private static DocumentStoreAgentRun Restyle() => new()
    {
        Kind = DocumentStoreAgentRunKind.Transcribe,
        RestyleOfRunId = "prior-run",
    };

    private static DocumentStoreAgentRun Transcribe() => new()
    {
        Kind = DocumentStoreAgentRunKind.Transcribe,
    };

    [Fact]
    public void Restyle_DoesNotClaimSpeechToTextFailed()
    {
        var copy = DocumentStoreRunFailureCopy.Resolve(
            Restyle(),
            new InvalidOperationException("摘要生成失败: upstream 503"));

        Assert.Equal(DocumentStoreRunFailureCopy.RestyleFailed, copy.Code);
        // 转写这一步压根没跑，不许出现「转写」「重录」这类字眼
        Assert.DoesNotContain("转写", copy.UserMessage);
        Assert.DoesNotContain("重新录制", copy.UserMessage);
        Assert.Contains("整理没能生成", copy.UserMessage);
        // 原文没动这件事要说出来：用户最怕的就是「我校对过的原文没了」
        Assert.Contains("原文", copy.UserMessage);
    }

    [Fact]
    public void MissingModel_StopsRetryingAndPointsAtConfiguration()
    {
        var copy = DocumentStoreRunFailureCopy.Resolve(
            Restyle(),
            new GatewayRouteFailureException(
                GatewayRouteFailure.ModelPoolEmpty,
                "摘要生成失败: 未找到可用模型: AppCallerCode=document-store.transcribe-summary::chat, ModelType=chat"));

        Assert.Equal(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        // 配置问题不是网络抖动：自动重试与「请点击重试」都是在骗人
        Assert.False(copy.AutomaticRetryAllowed);
        Assert.DoesNotContain("请点击重试", copy.UserMessage);
        Assert.Contains("模型", copy.UserMessage);
        // 上游细节（AppCallerCode / ModelType）不进用户文案
        Assert.DoesNotContain("AppCallerCode", copy.UserMessage);
        Assert.DoesNotContain("chat", copy.UserMessage, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MissingModel_AlsoAppliesToTheAsrStage()
    {
        var copy = DocumentStoreRunFailureCopy.Resolve(
            Transcribe(),
            new InvalidOperationException("未找到可用模型: AppCallerCode=document-store.subtitle::asr"));

        Assert.Equal(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.False(copy.AutomaticRetryAllowed);
    }

    [Fact]
    public void RealTranscriptionFailure_KeepsItsOwnWording()
    {
        var copy = DocumentStoreRunFailureCopy.Resolve(
            Transcribe(),
            new InvalidOperationException("Whisper endpoint returned 503"));

        Assert.Equal(AudioTranscriptionUserError.UpstreamTemporary, copy.Code);
        Assert.True(copy.AutomaticRetryAllowed);
        // 会自动重试与不会自动重试是两句话，不许合成一句
        Assert.Contains("请点击重试", copy.MessageFor(willRetry: false));
        Assert.Contains("自动重试", copy.MessageFor(willRetry: true));
    }

    [Fact]
    public void NonTranscriptionKinds_KeepTheGenericWording()
    {
        var copy = DocumentStoreRunFailureCopy.Resolve(
            new DocumentStoreAgentRun { Kind = DocumentStoreAgentRunKind.AutoLink },
            new InvalidOperationException("boom"));

        Assert.Null(copy.Code);
        Assert.Contains("内容处理暂时失败", copy.UserMessage);
    }

    /// <summary>
    /// 转写成功、整理失败这一档，绝不能说成语音转写失败——原文好好地躺在笔记里，
    /// 「不需要重新录制」这种话只会把人往重录上引。
    /// </summary>
    [Fact]
    public void ResolveSummarySkipped_ShouldNotClaimTranscriptionFailed()
    {
        var copy = DocumentStoreRunFailureCopy.ResolveSummarySkipped(
            Transcribe(),
            new InvalidOperationException("摘要生成失败: 上游返回 500"));

        Assert.Equal(DocumentStoreRunFailureCopy.SummarySkipped, copy.Code);
        Assert.DoesNotContain("转写", copy.UserMessage);
        Assert.DoesNotContain("重新录制", copy.UserMessage);
        Assert.Contains("原文", copy.UserMessage);
    }

    /// <summary>整理这一步的模型没配好，同样要如实说是配置问题，而不是「稍后重试」。</summary>
    [Fact]
    public void ResolveSummarySkipped_ShouldStillRecognizeConfigurationFault()
    {
        var copy = DocumentStoreRunFailureCopy.ResolveSummarySkipped(
            Transcribe(),
            new GatewayRouteFailureException(
                GatewayRouteFailure.AppCallerPoolUnbound,
                "摘要生成失败: 未绑定模型池"));

        Assert.Equal(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.False(copy.AutomaticRetryAllowed);
        Assert.Contains("原文", copy.UserMessage);
    }
}


/// <summary>
/// 配置类失败必须按网关给的**结构化码**判，不是照文案猜。
/// 这几条对应 Codex 第四十五轮 P2：appCaller 未绑池、池空、平台被关，
/// 三种措辞各不相同，照文案匹配一条都认不出来，于是全都落进了「暂时失败，自动重试」。
/// </summary>
public class DocumentStoreRunFailureCopyRouteCodeTests
{
    private static DocumentStoreAgentRun Transcribe() => new()
    {
        Kind = DocumentStoreAgentRunKind.Transcribe,
    };

    [Theory]
    [InlineData(GatewayRouteFailure.AppCallerPoolUnbound)]
    [InlineData(GatewayRouteFailure.ModelPoolEmpty)]
    [InlineData(GatewayRouteFailure.RouteConfigIncompatible)]
    [InlineData(GatewayRouteFailure.PlatformDisabled)]
    [InlineData(GatewayRouteFailure.OfferingUnresolvable)]
    [InlineData(GatewayRouteFailure.LogicalModelCapabilityMismatch)]
    public void ConfigurationFaults_AreRecognisedByCodeNotWording(string code)
    {
        // 文案里一个「未找到可用模型」都没有：只有结构化码能认出它
        var copy = DocumentStoreRunFailureCopy.Resolve(
            Transcribe(),
            new GatewayRouteFailureException(code, "AppCallerCode=document-store.subtitle::asr 未配置"));

        Assert.Equal(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.False(copy.AutomaticRetryAllowed);
        Assert.DoesNotContain("请点击重试", copy.UserMessage);
    }

    [Theory]
    [InlineData(GatewayRouteFailure.ProviderUnavailable)]
    [InlineData(GatewayRouteFailure.ProviderQuotaExceeded)]
    [InlineData(GatewayRouteFailure.ModelPoolAllUnavailable)]
    [InlineData(GatewayRouteFailure.GatewayConfigUnavailable)]
    public void TemporaryFaults_KeepRetrying(string code)
    {
        // 这几种会自愈，不该被当成配置问题判死
        var copy = DocumentStoreRunFailureCopy.Resolve(
            Transcribe(),
            new GatewayRouteFailureException(code, "上游炸了"));

        Assert.NotEqual(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.True(copy.AutomaticRetryAllowed);
    }

    [Fact]
    public void AsrChain_ReadsCodesFromDiagnostics()
    {
        var ex = new SubtitleAsrException(
            "ASR 模型调度失败: transcript-agent.transcribe::asr 未配置",
            new Dictionary<string, object?>
            {
                ["stage"] = "调度失败",
                [SubtitleAsrException.FailureCodesKey] = new List<string>
                {
                    GatewayRouteFailure.AppCallerPoolUnbound,
                    GatewayRouteFailure.ModelPoolEmpty,
                },
            });

        var copy = DocumentStoreRunFailureCopy.Resolve(Transcribe(), ex);

        Assert.Equal(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.False(copy.AutomaticRetryAllowed);
    }

    [Fact]
    public void AsrChain_KeepsRetryingWhenAnyCandidateFailedTemporarily()
    {
        // 链上还有一个是「上游故障」：那一路会自愈，不许按配置问题收手
        var ex = new SubtitleAsrException(
            "ASR 模型调度失败",
            new Dictionary<string, object?>
            {
                [SubtitleAsrException.FailureCodesKey] = new List<string>
                {
                    GatewayRouteFailure.ModelPoolEmpty,
                    GatewayRouteFailure.ProviderUnavailable,
                },
            });

        var copy = DocumentStoreRunFailureCopy.Resolve(Transcribe(), ex);

        Assert.NotEqual(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.True(copy.AutomaticRetryAllowed);
    }

    [Fact]
    public void ReprocessRun_DoesNotClaimTheRecordingIsIntact()
    {
        // reprocess 跑的可能是一篇普通文档，压根没有录音（Codex 第四十五轮 P2）
        var copy = DocumentStoreRunFailureCopy.Resolve(
            new DocumentStoreAgentRun { Kind = DocumentStoreAgentRunKind.Reprocess },
            new GatewayRouteFailureException(GatewayRouteFailure.ModelPoolEmpty, "池空"));

        Assert.Equal(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.DoesNotContain("录音", copy.UserMessage);
        Assert.Contains("没有改动", copy.UserMessage);
    }

    [Fact]
    public void RecordingRun_StillSaysTheRecordingAndTranscriptAreIntact()
    {
        var copy = DocumentStoreRunFailureCopy.Resolve(
            Transcribe(),
            new GatewayRouteFailureException(GatewayRouteFailure.ModelPoolEmpty, "池空"));

        Assert.Contains("录音与原文都在", copy.UserMessage);
    }
}


/// <summary>
/// 错误流块转异常这件事只许有一处实现，且必须把码带上。
/// Codex 第四十六轮 P1：`reprocess` 那一路仍在自己 new InvalidOperationException，
/// 只搬了文案、丢了码——于是为它写的那条文案分支在生产里永远走不到
/// （形状 2：建了一半，删掉不会红）。
/// </summary>
public class GatewayRouteFailureFromChunkTests
{
    [Fact]
    public void FromChunk_CarriesTheStructuredCode()
    {
        var ex = GatewayRouteFailureException.FromChunk(
            new LLMStreamChunk
            {
                Type = "error",
                ErrorMessage = "AppCallerCode=document-store.reprocess::chat 未配置",
                ErrorCode = GatewayRouteFailure.AppCallerPoolUnbound,
            },
            "LLM 调用失败");

        Assert.Equal(GatewayRouteFailure.AppCallerPoolUnbound, ex.FailureCode);
        Assert.StartsWith("LLM 调用失败: ", ex.Message);
        Assert.Contains("未配置", ex.Message);
    }

    [Fact]
    public void FromChunk_WithoutCode_StillProducesUsableMessage()
    {
        var ex = GatewayRouteFailureException.FromChunk(
            new LLMStreamChunk { Type = "error", ErrorMessage = "上游 502" },
            "Vision 调用失败");

        Assert.Null(ex.FailureCode);
        Assert.Equal("Vision 调用失败: 上游 502", ex.Message);
    }

    [Fact]
    public void ReprocessConfigFault_ReachesTheConfiguredCopy()
    {
        // 走真实形状：处理器把 error 块转成异常 → 文案判定读它的码
        var ex = GatewayRouteFailureException.FromChunk(
            new LLMStreamChunk
            {
                Type = "error",
                ErrorMessage = "所选模型池不在该 appCaller 的允许范围内",
                ErrorCode = GatewayRouteFailure.RouteConfigIncompatible,
            },
            "LLM 调用失败");

        var copy = DocumentStoreRunFailureCopy.Resolve(
            new DocumentStoreAgentRun { Kind = DocumentStoreAgentRunKind.Reprocess },
            ex);

        Assert.Equal(DocumentStoreRunFailureCopy.ModelNotConfigured, copy.Code);
        Assert.False(copy.AutomaticRetryAllowed);
        Assert.DoesNotContain("录音", copy.UserMessage);
    }

}
