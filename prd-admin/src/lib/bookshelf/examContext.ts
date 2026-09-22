/**
 * 结业考的「上下文」—— 同一个分数，读过和没读过是两个结论。
 *
 * 为什么需要这一层：考试一直没有门槛，一本没读也能考。那不是漏洞，是定位——
 * 考试是尺子不是闸门（「已读」是自己点的勾，加门槛只会逼人点假已读，
 * 把仅有的真实记录也污染掉）。但尺子必须说清它量的是什么：
 * 裸考 5/7 说明「底子在、这两处判断还没形成」，读完 11 本还错 5/7 说明
 * 「这两处没读透」，两句话指向完全不同的下一步。
 *
 * 判据收敛在这里，前端组件与看板都从这里取，不许各写一遍（形状 3）。
 * 后端 team 端点的同名口径见 BookshelfController 的注释。
 */

/** 考试时相对这一卷书目的姿态。 */
export type ExamStance =
  | 'blind'      // 一本没读就考：摸底
  | 'partial'    // 读了一部分
  | 'complete';  // 整卷读完才考：真正的结业考

/**
 * 裸考的判据只有一条：交卷时这一卷一本都没读。
 * 看板的「通关人数」不计裸考——否则读完 11 本的人和没读的人显示成一样，那个数字就废了。
 */
export function stanceOf(readAtExam: number, totalAtExam: number): ExamStance {
  const read = Number.isFinite(readAtExam) ? Math.max(0, readAtExam) : 0;
  const total = Number.isFinite(totalAtExam) ? Math.max(0, totalAtExam) : 0;
  if (read <= 0) return 'blind';
  if (total > 0 && read >= total) return 'complete';
  return 'partial';
}

/** 看板口径：读过 + 通过才算通关。裸考通过单独计，不混进这个数。 */
export function countsAsPassed(passed: boolean, readAtExam: number, totalAtExam: number): boolean {
  return passed && stanceOf(readAtExam, totalAtExam) !== 'blind';
}

/** 按钮该叫什么：一本没读时它是摸底，不是赴考。 */
export function examEntryLabel(readAtExam: number, totalAtExam: number, questionCount: number): string {
  return stanceOf(readAtExam, totalAtExam) === 'blind'
    ? `先摸个底 · ${questionCount} 题`
    : `结业考 · ${questionCount} 题`;
}

/**
 * 得分率。题数为零（存量脏数据）一律算 0，不让它靠除零冒充高分。
 */
function scoreRate(correct: number, total: number): number {
  return total > 0 ? correct / total : 0;
}

/**
 * 这一次成绩要不要盖掉手上那份。**前端这一侧的唯一判定源**，
 * 与服务端 `BookshelfExamScoring.IsBetter` 逐条对应。
 *
 * 为什么先比通关：只比分数会把裸考满分的人锁死——一本没读先摸底考了满分，
 * 读完整卷再考一次还是满分，分数没涨于是这次被丢弃，已读数永远停在 0，
 * 书读完了、试也考过了，看板上却永远不通关。
 *
 * 为什么比率不比绝对数：题目是策展内容、改版会增减。拿答对数当分数，
 * 某卷从 10 题改到 5 题之后，手上那份 6/10（60%）会挡住新的 5/5（100%）——
 * 而前端这道挡下去是**直接 return**，服务端那个正确的比较连跑的机会都没有。
 *
 * 2026-09-16 的教训：这两处判据本来就是分开写的两份（形状 3）。
 * 先改了服务端比率、忘了这一边，于是「两边口径一致」这句话在提交信息里
 * 成了假话。现在前端这一侧收敛到这一个函数，别再在组件或 store 里手写第二份。
 */
export function isBetterExam(
  prev: { correct: number; total: number; passed: boolean; readAtExam: number; totalAtExam: number } | undefined,
  next: { correct: number; total: number; passed: boolean; readAtExam: number; totalAtExam: number },
): boolean {
  if (!prev) return true;
  const prevCounts = countsAsPassed(prev.passed, prev.readAtExam, prev.totalAtExam);
  const nextCounts = countsAsPassed(next.passed, next.readAtExam, next.totalAtExam);
  if (nextCounts !== prevCounts) return nextCounts;
  return scoreRate(next.correct, next.total) > scoreRate(prev.correct, prev.total);
}
