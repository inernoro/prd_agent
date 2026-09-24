using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 守的是「远端失败时用户拿到的那句话」的几条性质：原因要换成人话交出去（原文进日志）、
/// 追不到要明说、不许再把人指向一条已经销毁的会话。红绿闭环：把 Describe 改回固定文案，
/// 或改回把远端原文拼进文案，这里会红。
/// </summary>
public sealed class OpenDesignFailureMessageTests
{
    /// <summary>
    /// PR #1533 评审 4081291421：远端原文（文件名、端点名、HTTP 细节）不许直接摆到用户面前。
    /// 已登记的错误码换成稳定的人话原因；原文不丢，挂在异常链里进日志。
    /// 此前这里断言的恰恰是「原文必须出现在用户文案里」——那条断言锁死的正是被评审指出的缺陷。
    /// </summary>
    [Fact]
    public void 已登记的远端错误码换成人话原因且原文只进异常链()
    {
        const string raw = "index.html contains an empty link target";
        var error = OpenDesignFailureMessage.Failure(
            OpenDesignFailureStage.RemoteRun,
            raw,
            "design_output_quality_rejected");

        Assert.DoesNotContain(raw, error.Message);
        Assert.Contains("没有通过发布前的校验", error.Message);
        Assert.Contains("下一步：", error.Message);
        var diagnostic = Assert.IsType<OpenDesignRemoteDiagnosticException>(error.InnerException);
        Assert.Equal(raw, diagnostic.Diagnostic);
        Assert.Equal("design_output_quality_rejected", diagnostic.RemoteCode);
    }

    [Fact]
    public void 未登记或没有错误码的远端原文也不进用户文案()
    {
        foreach (var code in new string?[] { null, "", "some_future_code" })
        {
            const string raw = "POST /internal/workspace/commit failed: HTTP 500 at /srv/od/worker.js:88";
            var error = OpenDesignFailureMessage.Failure(OpenDesignFailureStage.StartupFailed, raw, code);

            Assert.DoesNotContain("/internal/workspace/commit", error.Message);
            Assert.DoesNotContain("worker.js", error.Message);
            Assert.Contains(OpenDesignFailureMessage.UnmappedReason, error.Message);
            // 看不到原文，就不能让用户「按上面这条原因处理」。
            Assert.DoesNotContain("按上面这条原因", error.Message);
            Assert.Contains("下一步：", error.Message);
            Assert.Equal(raw, Assert.IsType<OpenDesignRemoteDiagnosticException>(error.InnerException).Diagnostic);
        }
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
    public void 超长原因也不会把一整段日志摔到用户脸上()
    {
        var message = OpenDesignFailureMessage.Describe(
            OpenDesignFailureStage.RemoteRun,
            new string('x', 5000));

        Assert.True(message.Length < 800, $"实际长度 {message.Length}");
        Assert.DoesNotContain("xxxx", message);
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
