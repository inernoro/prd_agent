using PrdAgent.Api.Services;
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
            new InvalidOperationException(
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
}
