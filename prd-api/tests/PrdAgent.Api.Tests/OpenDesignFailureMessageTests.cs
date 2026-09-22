using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 守的是「远端失败时用户拿到的那句话」的三条性质：原因要交出去、追不到要明说、
/// 不许再把人指向一条已经销毁的会话。红绿闭环：把 Describe 改回固定文案，这里会红。
/// </summary>
public sealed class OpenDesignFailureMessageTests
{
    [Fact]
    public void 远端给了原因时必须把原因交到用户手上()
    {
        var message = OpenDesignFailureMessage.Describe(
            OpenDesignFailureStage.RemoteRun,
            "index.html contains an empty link target");

        Assert.Contains("index.html contains an empty link target", message);
        Assert.Contains("下一步：", message);
    }

    [Fact]
    public void 远端没给原因时必须明说追不到而不是编一个()
    {
        foreach (var blank in new string?[] { null, "", "   ", "unknown", "UNKNOWN" })
        {
            var message = OpenDesignFailureMessage.Describe(OpenDesignFailureStage.RemoteSessionEnded, blank);

            Assert.Contains("远端没有回传原因", message);
            Assert.Contains(OpenDesignFailureStage.NextStepWithoutReason, message);
        }
    }

    [Fact]
    public void 任何阶段都不许再把用户指向已经销毁的CDS会话日志()
    {
        var stages = new[]
        {
            OpenDesignFailureStage.Dispatch,
            OpenDesignFailureStage.RemoteRun,
            OpenDesignFailureStage.RemoteSessionEnded,
            OpenDesignFailureStage.StartupFailed,
            OpenDesignFailureStage.StartupDeadline,
            OpenDesignFailureStage.Deadline(TimeSpan.FromMinutes(15)),
        };

        foreach (var stage in stages)
        {
            foreach (var reason in new string?[] { null, "boom" })
            {
                var message = OpenDesignFailureMessage.Describe(stage, reason);

                Assert.DoesNotContain("会话日志", message);
                // 下一步是必填字段，任何阶段任何原因都必须渲染出来。
                Assert.Contains("下一步：", message);
            }
        }
    }

    [Fact]
    public void 超时阶段必须说出真实的超时分钟数而不是写死的十五()
    {
        var message = OpenDesignFailureMessage.Describe(
            OpenDesignFailureStage.Deadline(TimeSpan.FromMinutes(7)),
            remoteReason: null);

        Assert.Contains("7 分钟", message);
    }

    [Fact]
    public void 超长原因要截断避免把一整段日志摔到用户脸上()
    {
        var message = OpenDesignFailureMessage.Describe(
            OpenDesignFailureStage.RemoteRun,
            new string('x', 5000));

        Assert.True(message.Length < 800, $"实际长度 {message.Length}");
        Assert.Contains("…", message);
    }

    /// <summary>
    /// Describe 不再重做一遍脱敏，靠的是两个入参在落库前就已经过滤过。这条守的是那个前提：
    /// 前提塌了（CDS 事件不再脱敏），这里会红，而不是等凭据从错误文案里漏出去才发现。
    /// </summary>
    [Fact]
    public void 远端事件里的凭据在落库前就必须被抹掉()
    {
        var sanitized = InfraAgentSessionService.SanitizeCdsEventPayload(
            """{"message":"upstream rejected: Authorization: Bearer sk-live-abcdefgh12345678"}""");

        Assert.DoesNotContain("sk-live-abcdefgh12345678", sanitized);
    }
}
