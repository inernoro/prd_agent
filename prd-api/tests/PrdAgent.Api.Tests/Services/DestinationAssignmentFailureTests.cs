using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 归属失败的那句话会原样进浏览器的提示框（Codex P2，2026-09-15）。
///
/// 此前记的是 <c>Exception.Message</c>：Mongo / 网络 / 驱动抛出来的消息里常带库名、
/// 主机、副本集与协议状态，它经 run 落库、经终态事件下发，最后显示在一个用户能截图的
/// 提示框里。判断收敛成有限枚举之后，分支再也碰不到句子本身。
/// </summary>
public sealed class DestinationAssignmentFailureTests
{
    public static TheoryData<Exception> LeakyExceptions() =>
    [
        new InvalidOperationException(
            "A timeout occurred after 30000ms selecting a server; "
            + "topology prd-mongo-primary.internal:27017, database prdagent"),
        new IOException("Unable to read data from prd-mongo-primary.internal:27017"),
        new InvalidOperationException("mongodb://root:hunter2@prd-mongo-primary.internal:27017"),
    ];

    [Theory]
    [MemberData(nameof(LeakyExceptions))]
    public void DescribeNeverLeaksTheUnderlyingMessage(Exception error)
    {
        var described = DestinationAssignmentFailure.Describe(error);

        described.ShouldBe(DestinationAssignmentFailure.Unexpected);
        // companion：这些异常的 Message 里确实有值得挡住的东西，否则上面那条会对着空气判绿。
        error.Message.ShouldNotBeNullOrWhiteSpace();
        described.ShouldNotContain(
            "prd-mongo-primary",
            customMessage: "用户看到的那句话里不许出现主机名");
        described.ShouldNotContain(
            error.Message,
            customMessage: "用户看到的那句话不许是异常自己的消息");
    }

    [Fact]
    public void PermissionFailuresGetTheirOwnNextStep()
    {
        // 「你在目标团队的权限已变更」是用户能行动的那一句（external-cause-first：要不要紧 + 下一步）；
        // 把它并进兜底文案，用户只会收到一句「发生错误」。
        DestinationAssignmentFailure
            .Describe(new UnauthorizedAccessException("无权将网页分享到部分团队"))
            .ShouldBe(DestinationAssignmentFailure.PermissionChanged);
    }
}
