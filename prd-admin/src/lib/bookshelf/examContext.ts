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
