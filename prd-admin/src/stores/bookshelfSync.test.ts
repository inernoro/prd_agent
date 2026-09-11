/**
 * 藏书阁同步层守卫。
 *
 * 为什么要有：本文件测的每一条，删掉对应实现后页面都照常渲染、其它测试也全绿
 * ——同步失败是沉默的，只有真实用户在另一台设备上打开时才发现进度没了。
 * 这正是 predicate-and-wiring-discipline 说的「删掉不会红」，必须补守卫。
 *
 * 重点不是「保存成功了吗」，而是「保存失败时用户看不看得见、会不会自己补上」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const saveMock = vi.fn();
const loadMock = vi.fn();
vi.mock('@/services/real/bookshelf', () => ({
  saveMyBookshelfProgress: (...a: unknown[]) => saveMock(...a),
  getMyBookshelfProgress: (...a: unknown[]) => loadMock(...a),
  getBookshelfTeamBoard: vi.fn(),
}));

const { useBookshelfStore, __pushDebounceMs } = await import('./bookshelfStore');

/** 走完一次防抖窗口 + 让挂起的 promise 落地。不用 sleep 猜时间。 */
async function settle() {
  await vi.advanceTimersByTimeAsync(__pushDebounceMs + 10);
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  saveMock.mockReset();
  loadMock.mockReset();
  useBookshelfStore.setState({
    readBookIds: [], examResults: {}, syncState: 'local', failedAttempts: 0,
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('保存成功', () => {
  it('推送成功后状态变 synced，失败计数清零', async () => {
    saveMock.mockResolvedValue({ success: true, data: {} });
    useBookshelfStore.setState({ failedAttempts: 3 });
    useBookshelfStore.getState().toggleRead('b-1');
    await settle();
    expect(useBookshelfStore.getState().syncState).toBe('synced');
    expect(useBookshelfStore.getState().failedAttempts).toBe(0);
  });
});

describe('保存失败必须让用户看见', () => {
  it('接口返回 success:false 时状态变 failed', async () => {
    saveMock.mockResolvedValue({ success: false, error: { message: '炸了' } });
    useBookshelfStore.getState().toggleRead('b-1');
    await settle();
    expect(useBookshelfStore.getState().syncState).toBe('failed');
  });

  it('抛异常（断网）时状态同样变 failed，不是静默吞掉', async () => {
    saveMock.mockRejectedValue(new Error('network down'));
    useBookshelfStore.getState().toggleRead('b-1');
    await settle();
    expect(useBookshelfStore.getState().syncState).toBe('failed');
  });

  it('失败不回滚本地改动 —— 刚点的勾不许弹回去', async () => {
    saveMock.mockRejectedValue(new Error('network down'));
    useBookshelfStore.getState().toggleRead('b-1');
    await settle();
    expect(useBookshelfStore.getState().readBookIds).toContain('b-1');
  });

  it('连续失败会累加计数（用于退避与文案分级）', async () => {
    saveMock.mockRejectedValue(new Error('down'));
    useBookshelfStore.getState().toggleRead('b-1');
    await settle();
    useBookshelfStore.getState().toggleRead('b-2');
    await settle();
    expect(useBookshelfStore.getState().failedAttempts).toBe(2);
  });
});

describe('重试是安全的：每次都送完整快照', () => {
  it('失败后再操作一次，送出的快照包含此前失败的那本书', async () => {
    saveMock.mockRejectedValue(new Error('down'));
    useBookshelfStore.getState().toggleRead('b-1');
    await settle();

    saveMock.mockResolvedValue({ success: true, data: {} });
    useBookshelfStore.getState().toggleRead('b-2');
    await settle();

    const lastPayload = saveMock.mock.calls.at(-1)?.[0] as { readBookIds: string[] };
    expect(lastPayload.readBookIds).toEqual(expect.arrayContaining(['b-1', 'b-2']));
    expect(useBookshelfStore.getState().syncState).toBe('synced');
  });

  it('手动 retrySync 能把失败态救回来', async () => {
    saveMock.mockRejectedValue(new Error('down'));
    useBookshelfStore.getState().toggleRead('b-1');
    await settle();
    expect(useBookshelfStore.getState().syncState).toBe('failed');

    saveMock.mockResolvedValue({ success: true, data: {} });
    await useBookshelfStore.getState().retrySync();
    expect(useBookshelfStore.getState().syncState).toBe('synced');
  });
});

describe('防抖：快速连点不该打满请求', () => {
  it('窗口内连点五本只发一次，且快照含全部五本', async () => {
    saveMock.mockResolvedValue({ success: true, data: {} });
    ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'].forEach((id) => useBookshelfStore.getState().toggleRead(id));
    await settle();
    expect(saveMock).toHaveBeenCalledTimes(1);
    const payload = saveMock.mock.calls[0][0] as { readBookIds: string[] };
    expect(payload.readBookIds).toHaveLength(5);
  });
});

describe('拉取失败不清空本地', () => {
  it('服务端读不到时保留本地记录，停在 local 态', async () => {
    useBookshelfStore.setState({ readBookIds: ['b-local'], syncState: 'local' });
    loadMock.mockResolvedValue({ success: false, error: { message: '401' } });
    await useBookshelfStore.getState().loadFromServer();
    expect(useBookshelfStore.getState().readBookIds).toEqual(['b-local']);
    expect(useBookshelfStore.getState().syncState).toBe('local');
  });
});

describe('成绩只留更好的那次', () => {
  it('更差的成绩不覆盖，也不触发推送', async () => {
    saveMock.mockResolvedValue({ success: true, data: {} });
    const good = {
      volumeId: 'v1', correct: 4, total: 4, passed: true,
      readAtExam: 3, totalAtExam: 5, takenAt: 'T1',
    };
    useBookshelfStore.getState().recordExam(good);
    await settle();
    saveMock.mockClear();

    useBookshelfStore.getState().recordExam({ ...good, correct: 2, passed: false, takenAt: 'T2' });
    await settle();
    expect(useBookshelfStore.getState().examResults.v1.correct).toBe(4);
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe('成绩必须带着「当时读了几本」一起往返', () => {
  // 这两条各守一个方向。写方向断掉 → 服务端永远收到 0；读方向断掉 → 每次刷新后
  // 所有成绩退化成裸考、通关数一夜清零。两边都是「删掉不会红」的静默退化：
  // 本次就先漏了读方向（后端 ToPlainMap 没吐这两个字段），补守卫堵住。
  it('写方向：推给服务端的快照带上 readAtExam / totalAtExam', async () => {
    saveMock.mockResolvedValue({ success: true, data: {} });
    useBookshelfStore.getState().recordExam({
      volumeId: 'v-ai', correct: 6, total: 7, passed: true,
      readAtExam: 11, totalAtExam: 11, takenAt: 'T1',
    });
    await settle();
    const payload = saveMock.mock.calls[0][0] as {
      examResults: Record<string, { readAtExam: number; totalAtExam: number }>;
    };
    expect(payload.examResults['v-ai'].readAtExam).toBe(11);
    expect(payload.examResults['v-ai'].totalAtExam).toBe(11);
  });

  it('读方向：服务端返回的读书数要落进 store，不许丢', async () => {
    loadMock.mockResolvedValue({
      success: true,
      data: {
        readBookIds: [],
        examResults: {
          'v-ai': {
            volumeId: 'v-ai', correct: 6, total: 7, passed: true,
            readAtExam: 11, totalAtExam: 11, takenAt: 'T1',
          },
        },
        updatedAt: null,
      },
    });
    await useBookshelfStore.getState().loadFromServer();
    expect(useBookshelfStore.getState().examResults['v-ai'].readAtExam).toBe(11);
  });

  it('旧记录没有这两个字段时按裸考处理，不许拿当前书数假装读过', async () => {
    loadMock.mockResolvedValue({
      success: true,
      data: {
        readBookIds: [],
        examResults: {
          'v-ai': { volumeId: 'v-ai', correct: 6, total: 7, passed: true, takenAt: 'T1' },
        },
        updatedAt: null,
      },
    });
    await useBookshelfStore.getState().loadFromServer();
    expect(useBookshelfStore.getState().examResults['v-ai'].readAtExam).toBe(0);
  });
});
