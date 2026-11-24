using PrdAgent.Api.Controllers.Api;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 保存失败之后到底该不该把这条 run 标成 error。
/// 写库那一支的失败无法区分「没写进去」与「写进去了但回执丢了」，无条件降级会把一条真的
/// 完成版本改写成 error，用户再也打不开它——比不标终态更糟。
/// </summary>
public sealed class MdToPptSaveFailureDispositionTests
{
    [Fact]
    public async Task WriteNeverHappened_ShouldMarkFailedWithoutProbingTheDatabase()
    {
        var probes = 0;

        var disposition = await MdToPptController.ResolveSaveFailureAsync(
            writeAmbiguous: false,
            probeCompletionPersisted: () =>
            {
                probes++;
                return Task.FromResult<bool?>(false);
            });

        disposition.ShouldBe(MdToPptController.SaveFailureDisposition.MarkFailed);
        probes.ShouldBe(0);
    }

    [Fact]
    public async Task AmbiguousWriteThatActuallyLanded_ShouldBeReportedAsSuccess()
    {
        var disposition = await MdToPptController.ResolveSaveFailureAsync(
            writeAmbiguous: true,
            probeCompletionPersisted: () => Task.FromResult<bool?>(true));

        disposition.ShouldBe(MdToPptController.SaveFailureDisposition.ReportSuccess);
    }

    [Fact]
    public async Task AmbiguousWriteThatDidNotLand_ShouldMarkFailed()
    {
        var disposition = await MdToPptController.ResolveSaveFailureAsync(
            writeAmbiguous: true,
            probeCompletionPersisted: () => Task.FromResult<bool?>(false));

        disposition.ShouldBe(MdToPptController.SaveFailureDisposition.MarkFailed);
    }

    [Fact]
    public async Task AmbiguousWriteWithUnreadableState_ShouldNotGuessAndLeaveItToTheStaleSweep()
    {
        var disposition = await MdToPptController.ResolveSaveFailureAsync(
            writeAmbiguous: true,
            probeCompletionPersisted: () => Task.FromResult<bool?>(null));

        disposition.ShouldBe(MdToPptController.SaveFailureDisposition.LeaveForStaleSweep);
    }
}
