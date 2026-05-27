using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 救机会 / 系统重跑端点的状态门槛守卫测试。
/// 防止下次有人放宽条件（例如把 RerunSubmission 改回"任意状态都能调"）后没人发现。
/// </summary>
public class ReviewAgentStateGuardsTests
{
    private static ReviewSubmission Sub(string status, bool? isPassed = null, int rerun = 0)
        => new() { Status = status, IsPassed = isPassed, RerunCount = rerun };

    // ── CanUseSystemRerun (Error 状态独占) ──────────────────

    [Fact]
    public void SystemRerun_仅Error状态_允许()
    {
        ReviewAgentController.CanUseSystemRerun(Sub(ReviewStatuses.Error)).ShouldBeTrue();
    }

    [Fact]
    public void SystemRerun_Done状态_拒绝()
    {
        ReviewAgentController.CanUseSystemRerun(Sub(ReviewStatuses.Done, isPassed: false)).ShouldBeFalse();
        ReviewAgentController.CanUseSystemRerun(Sub(ReviewStatuses.Done, isPassed: true)).ShouldBeFalse();
    }

    [Fact]
    public void SystemRerun_Queued_Running_拒绝()
    {
        ReviewAgentController.CanUseSystemRerun(Sub(ReviewStatuses.Queued)).ShouldBeFalse();
        ReviewAgentController.CanUseSystemRerun(Sub(ReviewStatuses.Running)).ShouldBeFalse();
    }

    // ── CanReuploadOnFailure (Done + 未通过 + 救机会未用) ────

    [Fact]
    public void ReuploadOnFailure_Done未通过且未用救机会_允许()
    {
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Done, isPassed: false, rerun: 0)).ShouldBeTrue();
    }

    [Fact]
    public void ReuploadOnFailure_已通过_拒绝()
    {
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Done, isPassed: true, rerun: 0)).ShouldBeFalse();
    }

    [Fact]
    public void ReuploadOnFailure_救机会已用尽_拒绝()
    {
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Done, isPassed: false, rerun: 1)).ShouldBeFalse();
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Done, isPassed: false, rerun: 2)).ShouldBeFalse();
    }

    [Fact]
    public void ReuploadOnFailure_非Done状态_拒绝()
    {
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Queued, isPassed: false)).ShouldBeFalse();
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Running, isPassed: false)).ShouldBeFalse();
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Error, isPassed: false)).ShouldBeFalse();
    }

    [Fact]
    public void ReuploadOnFailure_IsPassed为null_拒绝()
    {
        // 评审异常或刚提交，IsPassed 还没被赋值的 case
        ReviewAgentController.CanReuploadOnFailure(Sub(ReviewStatuses.Done, isPassed: null)).ShouldBeFalse();
    }
}
