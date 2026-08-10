using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 模型重听这条说话人路径的可信度守卫。
///
/// 素材不是编的：2026-08-10 用真实 key 打通 ASR 后，第一份产物就同时暴露了两个问题——
/// 模型的开场白被当成正文写进转录全文，且同一批句子被原样复制给两个说话人。
/// 用户最初的问题正是「说话人推断是真的吗」，所以这两条必须钉死：
/// 不该进产物的别进，编出来的切分别当真。
/// </summary>
public class ChatAudioDiarizationTrustTests
{
    /// <summary>线上真实返回，逐字保留（含开场白与复读式重复）。</summary>
    private const string RealModelOutput = """
好的，我会根据不同声音将原文分成说话人段落。以下是分段后的结果：

[说话人1] 哈喽 everybody 今天是个好日子 快乐的一天总是漫长的

[说话人1] 哎呦 迟迟转写又失败 我的天哪

[说话人2] 哈喽 everybody 今天是个好日子 快乐的一天总是漫长的

[说话人2] 哎呦 迟迟转写又失败 我的天哪
""";

    [Fact]
    public void 模型开场白不进转录正文()
    {
        var segments = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments(RealModelOutput);

        segments.ShouldAllBe(s => !s.Text.Contains("我会根据不同声音"));
        segments.ShouldAllBe(s => !s.Text.Contains("以下是分段后的结果"));
        // 开场白此前是以「无说话人」段落混进去的，所以顺带锁死：解析出说话人后不留无主段落
        segments.ShouldAllBe(s => !string.IsNullOrWhiteSpace(s.SpeakerId));
    }

    [Fact]
    public void 没有任何说话人标签时全文照旧保留()
    {
        // 这一条防的是上一条修过头：没有说话人标签时，正文不能被当成开场白丢掉
        var segments = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments("就是一段没有任何标签的原文");

        segments.Count.ShouldBe(1);
        segments[0].Text.ShouldBe("就是一段没有任何标签的原文");
    }

    [Fact]
    public void 两个说话人内容一字不差时判为编造()
    {
        var segments = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments(RealModelOutput);

        SubtitleGenerationProcessor.HasHallucinatedSpeakerSplit(segments).ShouldBeTrue();
    }

    [Fact]
    public void 真实对话不被误判为编造()
    {
        var segments = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments("""
[说话人1] 这个报价我们再谈谈
[说话人2] 交付质量达标的话价格是合理的
[说话人1] 那就按这个定
""");

        SubtitleGenerationProcessor.HasHallucinatedSpeakerSplit(segments).ShouldBeFalse();
    }

    [Fact]
    public void 标点与空白差异不影响编造判定()
    {
        // 复读式幻觉常带轻微标点差异，判据必须归一化后再比，否则一个逗号就绕过去了
        var segments = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments("""
[说话人1] 今天是个好日子，快乐的一天总是漫长的
[说话人2] 今天是个好日子 快乐的一天总是漫长的。
""");

        SubtitleGenerationProcessor.HasHallucinatedSpeakerSplit(segments).ShouldBeTrue();
    }
}
