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

  it('同一档里分数更低的那次照旧丢弃', () => {
    useBookshelfStore.getState().recordExam(makeResult(6, 11));
    useBookshelfStore.getState().recordExam(makeResult(4, 11));
    expect(useBookshelfStore.getState().examResults.v1.correct).toBe(6);
  });
});
