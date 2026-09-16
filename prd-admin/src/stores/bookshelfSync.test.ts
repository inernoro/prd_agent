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
    readBookIds: [], bookNotes: {}, examResults: {}, syncState: 'local', failedAttempts: 0,
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

describe('一句话心得同样要能往返', () => {
  // 和成绩快照同一类风险：写进去读不回来，页面照常渲染、其它测试照常绿，
  // 只有用户换台设备打开时才发现自己写的字没了。上次就漏了读方向，这次两头都钉住。
  it('写方向：心得进快照', async () => {
    saveMock.mockResolvedValue({ success: true, data: {} });
    useBookshelfStore.getState().setNote('b-lamp', '下次接需求先答那三问再动手');
    await settle();
    const payload = saveMock.mock.calls[0][0] as { bookNotes: Record<string, string> };
    expect(payload.bookNotes['b-lamp']).toBe('下次接需求先答那三问再动手');
  });

  it('读方向：服务端的心得落进 store', async () => {
    loadMock.mockResolvedValue({
      success: true,
      data: { readBookIds: [], bookNotes: { 'b-lamp': '用在扫码那条链路上' }, examResults: {}, updatedAt: null },
    });
    await useBookshelfStore.getState().loadFromServer();
    expect(useBookshelfStore.getState().bookNotes['b-lamp']).toBe('用在扫码那条链路上');
  });

  it('清空即删除，不留空串占位', async () => {
    saveMock.mockResolvedValue({ success: true, data: {} });
    useBookshelfStore.getState().setNote('b-lamp', '先写一句');
    await settle();
    useBookshelfStore.getState().setNote('b-lamp', '   ');
    await settle();
    expect('b-lamp' in useBookshelfStore.getState().bookNotes).toBe(false);
  });

  it('旧记录没有这个字段时按「还没写过」处理', async () => {
    loadMock.mockResolvedValue({
      success: true,
      data: { readBookIds: [], examResults: {}, updatedAt: null },
    });
    await useBookshelfStore.getState().loadFromServer();
    expect(useBookshelfStore.getState().bookNotes).toEqual({});
  });
});

describe('慢回来的 GET 不许把手上更新的那份盖回去', () => {
  /*
   * 这条守的是 dirty 判据够不着的那一瞬：GET 在飞 → 用户改了一笔 → PUT 成功把 dirty
   * 清回 false → GET 这才回来。此刻 dirty 是 false，可那份快照读的是改动之前的版本。
   * 照常替换的后果是双向的：用户刚做的事在眼前消失，下一次 flush 还会把这份倒退的快照
   * 写回服务端——本地和服务端一起退，两边都没有第二个副本。
   *
   * 把 loadFromServer 里那句 `mutationRev !== revAtStart` 删掉，这条必须红。
   */
  it('GET 在飞的期间改过东西，哪怕那笔改动已经推送成功，也不接受这份快照', async () => {
    useBookshelfStore.setState({
      readBookIds: ['b-old'], bookNotes: {}, examResults: {},
      syncState: 'synced', dirty: false, failedAttempts: 0,
    });

    let resolveLoad!: (v: unknown) => void;
    loadMock.mockReturnValue(new Promise((r) => { resolveLoad = r; }));
    saveMock.mockResolvedValue({ success: true, data: {} });

    const loading = useBookshelfStore.getState().loadFromServer();

    // GET 还没回来，用户标了一本新的；防抖到点后 PUT 成功，dirty 被清回 false
    useBookshelfStore.getState().toggleRead('b-new');
    await settle();
    expect(useBookshelfStore.getState().dirty).toBe(false);

    // 慢了半拍的 GET 这时才回来，带的是改动之前那一版
    resolveLoad({
      success: true,
      data: { readBookIds: ['b-old'], bookNotes: {}, examResults: {}, updatedAt: null },
    });
    await loading;

    expect(useBookshelfStore.getState().readBookIds).toContain('b-new');
  });

  it('GET 在飞的期间什么都没改，该接受的还是要接受（判据不许一刀切）', async () => {
    useBookshelfStore.setState({
      readBookIds: [], bookNotes: {}, examResults: {},
      syncState: 'local', dirty: false, failedAttempts: 0,
    });
    loadMock.mockResolvedValue({
      success: true,
      data: { readBookIds: ['b-server'], bookNotes: {}, examResults: {}, updatedAt: null },
    });
    await useBookshelfStore.getState().loadFromServer();
    expect(useBookshelfStore.getState().readBookIds).toEqual(['b-server']);
    expect(useBookshelfStore.getState().syncState).toBe('synced');
  });
});
