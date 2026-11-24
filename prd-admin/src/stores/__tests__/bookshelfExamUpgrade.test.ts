import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 守卫：裸考满分之后读完整卷再考满分，本地记录必须升级。
 *
 * 旧判据是 `result.correct <= prev.correct` 就丢弃，于是这条真实路径永远卡住：
 * 一本没读先摸个底考了满分（裸考不计通关）→ 读完整卷 → 再考一次还是满分 →
 * 正确数没涨于是这次被丢掉 → readAtExam 永远停在 0 → 看板上永远不通关。
 * 用户做对了每一步，系统给不出他应得的结论。
 *
 * 服务端同一套判据在 BookshelfExamScoring.IsBetter，两边都要守。
 */

vi.mock('@/services/real/bookshelf', () => ({
  getMyBookshelfProgress: vi.fn(async () => ({ success: false })),
  saveMyBookshelfProgress: vi.fn(async () => ({ success: true })),
}));

const { useBookshelfStore } = await import('../bookshelfStore');

function makeResult(correct: number, readAtExam: number) {
  return {
    volumeId: 'v1',
    correct,
    total: 7,
    passed: correct / 7 >= 0.6,
    readAtExam,
    totalAtExam: 11,
    takenAt: new Date().toISOString(),
  };
}

describe('结业考成绩的本地合并', () => {
  beforeEach(() => {
    useBookshelfStore.setState({ examResults: {} });
  });

  it('裸考满分后读完整卷再考满分，记录升级为非裸考', () => {
    useBookshelfStore.getState().recordExam(makeResult(7, 0));
    expect(useBookshelfStore.getState().examResults.v1.readAtExam).toBe(0);

    useBookshelfStore.getState().recordExam(makeResult(7, 11));
    expect(
      useBookshelfStore.getState().examResults.v1.readAtExam,
      '同分但从裸考升级为读完再考，这一次必须盖掉旧记录',
    ).toBe(11);
  });

  it('已经通关之后再裸考一次，不会把记录降级', () => {
    useBookshelfStore.getState().recordExam(makeResult(6, 11));
    useBookshelfStore.getState().recordExam(makeResult(7, 0));
    expect(useBookshelfStore.getState().examResults.v1.readAtExam).toBe(11);
    expect(useBookshelfStore.getState().examResults.v1.correct).toBe(6);
  });

  /*
   * 2026-09-16 的回归：服务端改成比得分率之后，前端这一份还在比答对数。
   * 而前端这道挡下去是直接 return，服务端那个正确的比较连跑的机会都没有——
   * 判据分裂成两份、只改了一份（形状 3）。
   */
  it('卷子改版后比的是得分率：6/10 挡不住 5/5', () => {
    useBookshelfStore.getState().recordExam({
      volumeId: 'v1', correct: 6, total: 10, passed: true,
      readAtExam: 11, totalAtExam: 11, takenAt: new Date().toISOString(),
    });
    useBookshelfStore.getState().recordExam({
      volumeId: 'v1', correct: 5, total: 5, passed: true,
      readAtExam: 11, totalAtExam: 11, takenAt: new Date().toISOString(),
    });
    const r = useBookshelfStore.getState().examResults.v1;
    expect(r.total, '5/5（100%）被 6/10（60%）挡住了：这一侧比的还是答对数').toBe(5);
    expect(r.correct).toBe(5);
  });

  it('同一档里分数更低的那次照旧丢弃', () => {
    useBookshelfStore.getState().recordExam(makeResult(6, 11));
    useBookshelfStore.getState().recordExam(makeResult(4, 11));
    expect(useBookshelfStore.getState().examResults.v1.correct).toBe(6);
  });
});
