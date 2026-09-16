using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 结业考成绩的判定口径。
///
/// 单独成类是为了能被测到：这套判据原先写在 Controller 的 foreach 里，
/// 删掉任何一半测试都不会红（`predicate-and-wiring-discipline` 的判据：
/// 改动删掉后测试仍全绿，就需要一条守卫）。
///
/// 前端 lib/bookshelf/exams.ts 的 PASS_RATE 与 examContext.ts 的 countsAsPassed
/// 是同一套口径的展示侧副本，只负责交卷那一屏的即时反馈；落库的结论以这里为准。
/// </summary>
public static class BookshelfExamScoring
{
    /// <summary>及格线。与前端 exams.ts 的 PASS_RATE 同值。</summary>
    public const double PassRate = 0.6;

    /// <summary>及格判定。服务端自己算，不采信前端送上来的结论。</summary>
    public static bool IsPassed(int correct, int total)
        => total > 0 && correct >= 0 && correct <= total && (double)correct / total >= PassRate;

    /// <summary>
    /// 看板口径：读过 + 通过才算通关（与前端 examContext.countsAsPassed 同义）。
    /// 裸考（交卷时这一卷一本没读）不计入——否则读完整卷的人和没读的人在看板上一个样。
    /// </summary>
    public static bool CountsAsPassed(int correct, int total, int readAtExam)
        => readAtExam > 0 && IsPassed(correct, total);

    /// <summary>
    /// 这一次成绩要不要盖掉库里那份。
    ///
    /// 先比「算不算通关」，同档再比正确数。只比正确数会把裸考满分的人锁死：
    /// 一本没读先摸底考了满分，读完整卷再考一次还是满分，正确数没涨于是这一次被丢弃，
    /// ReadAtExam 永远停在 0——书读完了、试也考过了，看板上却永远不通关。
    /// 反过来（已通关的人再裸考一次）不会把记录降级。
    /// </summary>
    public static bool IsBetter(BookshelfExamResult? prev, int correct, int total, int readAtExam)
    {
        if (prev == null) return true;
        var incomingCounts = CountsAsPassed(correct, total, readAtExam);
        var prevCounts = CountsAsPassed(prev.Correct, prev.Total, prev.ReadAtExam);
        if (incomingCounts != prevCounts) return incomingCounts;
        return correct > prev.Correct;
    }
}
