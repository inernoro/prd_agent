/**
 * 离线校对队列的两条判据（都是 Codex P1 抓出来的真缺陷，这里把它们钉成会红的用例）：
 *
 * 1. 队列必须**认笔记**——不认的话，从侧栏切到另一条录音会把 A 的校对写进 B。
 * 2. 队列必须**落盘**——只活在 React state 里的话，刷新一次横幅那句
 *    「联网后自动上传」就成了空头承诺。落的是 sessionStorage：存的是录音正文全文，
 *    不满足 no-localstorage.md 例外清单的「非敏感」那一条。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllOfflineEdits,
  clearOfflineEdit,
  decideOfflineFlush,
  isStaleOfflineEdit,
  isFlushable,
  loadOfflineEdit,
  saveOfflineEdit,
  type QueuedOfflineEdit,
} from '../recordingOfflineQueue';

const NOTE_A = 'note-a';
const NOTE_B = 'note-b';
const USER_A = 'user-a';
const USER_B = 'user-b';

/*
 * 这套用例跑在 node 环境（本仓库这一批纯函数测试都不起 jsdom），所以自己搭一个
 * 最小的 sessionStorage。搭的是**真实语义**（存进去、读出来、删掉），不是把被测模块
 * 的行为抄一遍——判据仍然由被测模块给出，桩只提供它依赖的浏览器接口。
 */
beforeAll(() => {
  if (typeof globalThis.window !== 'undefined' && globalThis.window.sessionStorage) return;
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: store };
});

function edit(noteId: string, savedAt: number, content = '改过的原文', ownerId = USER_A): QueuedOfflineEdit {
  return { ownerId, noteId, count: 2, content, savedAt };
}

describe('离线校对队列', () => {
  beforeEach(() => {
    clearOfflineEdit(NOTE_A, USER_A);
    clearOfflineEdit(NOTE_B, USER_A);
    clearOfflineEdit(NOTE_A, USER_B);
  });

  it('队列认笔记：A 的内容不会被当成 B 的补传上去', () => {
    const now = Date.now();
    expect(isFlushable(edit(NOTE_A, now), NOTE_A, USER_A)).toBe(true);
    expect(isFlushable(edit(NOTE_A, now), NOTE_B, USER_A)).toBe(false);
  });

  it('落盘之后另一次加载还能接回来（刷新不丢）', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now, '第一次改'));
    const restored = loadOfflineEdit(NOTE_A, USER_A);
    expect(restored?.content).toBe('第一次改');
    expect(restored?.count).toBe(2);
  });

  it('另一条笔记读不到这一条的队列', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now));
    expect(loadOfflineEdit(NOTE_B, USER_A)).toBeNull();
  });

  /*
   * 过期的草稿是用户的正文，删不得——此前读一次就当场清掉，用户几处校对
   * 连一句提示都没有就消失了（Codex 第二十轮 P1）。现在照常接回来，
   * 传不传由 decideOfflineFlush 裁决、由用户在横幅上点。
   */
  it('放太久的队列照常接回来，只是不再自动补传', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now));
    const muchLater = now + 4 * 24 * 60 * 60 * 1000;
    const restored = loadOfflineEdit(NOTE_A, USER_A);
    expect(restored?.content).toBe('改过的原文');
    expect(isStaleOfflineEdit(restored, muchLater)).toBe(true);
    expect(decideOfflineFlush(restored, '2026-08-28T00:00:00Z', muchLater)).toBe('stale');
  });

  it('补传成功后清空，不会二次覆盖', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now));
    clearOfflineEdit(NOTE_A, USER_A);
    expect(loadOfflineEdit(NOTE_A, USER_A)).toBeNull();
  });

  it('空内容不算可补传的队列（避免把笔记写成空白）', () => {
    const now = Date.now();
    expect(isFlushable(edit(NOTE_A, now, ''), NOTE_A, USER_A)).toBe(false);
  });

  it('换个账号读不到上一位留下的草稿（共享浏览器不串人）', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now, 'A 的稿子'));
    expect(loadOfflineEdit(NOTE_A, USER_B)).toBeNull();
    expect(isFlushable(edit(NOTE_A, now), NOTE_A, USER_B)).toBe(false);
  });

  it('没有账号 id 时不落盘（宁可这一次丢掉，也不留一份不知道属于谁的草稿）', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now, '无主稿子', ''));
    expect(loadOfflineEdit(NOTE_A, '')).toBeNull();
    expect(loadOfflineEdit(NOTE_A, USER_A)).toBeNull();
  });

  /*
   * 补传是整篇覆盖写：服务端那份在离线期间被改过就不能直接盖，否则另一台设备
   * （或同事）的新内容整篇消失，两边都不会有提示（Codex 第七轮 P1）。
   */
  describe('补传前的版本基线', () => {
    const base: QueuedOfflineEdit = {
      ownerId: USER_A,
      noteId: NOTE_A,
      count: 1,
      content: '离线改的内容',
      savedAt: Date.now(),
      baseUpdatedAt: '2026-08-28T00:00:00Z',
    };

    it('服务端那份变过就算冲突', () => {
      expect(decideOfflineFlush(base, '2026-08-28T01:00:00Z')).toBe('remote-changed');
    });

    it('没变就照常补传', () => {
      expect(decideOfflineFlush(base, '2026-08-28T00:00:00Z')).toBe('flush');
    });

    /*
     * 「比不了」以前当成「没冲突照传」，于是初次加载时条目请求偶发失败会给出 null 基线，
     * 照传就是拿一个空基线把同事的新版本静默盖掉（Codex 第二十轮 P1）。
     * 现在一律停下来问用户——多点一下 vs 盖错了没法撤。
     */
    it('比不了就停下来问用户，不再当成没冲突照传', () => {
      expect(decideOfflineFlush({ ...base, baseUpdatedAt: null }, '2026-08-28T01:00:00Z')).toBe('unknown-base');
      expect(decideOfflineFlush(base, null)).toBe('unknown-base');
      expect(decideOfflineFlush(base, undefined)).toBe('unknown-base');
    });

    it('放太久的草稿单独一种理由，不冒充「被别人改过」', () => {
      const old = { ...base, savedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 };
      expect(isStaleOfflineEdit(old)).toBe(true);
      expect(decideOfflineFlush(old, '2026-08-28T00:00:00Z')).toBe('stale');
    });

    it('基线跟着草稿一起存下来，重开页面还认得', () => {
      saveOfflineEdit(base);
      expect(loadOfflineEdit(NOTE_A, USER_A)?.baseUpdatedAt).toBe('2026-08-28T00:00:00Z');
      clearOfflineEdit(NOTE_A, USER_A);
    });
  });

  /*
   * 存不住就不许报存住了：横幅那句「无需重做」是拿落盘换来的（Codex 第七轮 P1）。
   */
  describe('落盘结果如实返回', () => {
    it('存住返回 true', () => {
      expect(saveOfflineEdit({
        ownerId: USER_A, noteId: NOTE_A, count: 1, content: 'x', savedAt: Date.now(),
      })).toBe(true);
      clearOfflineEdit(NOTE_A, USER_A);
    });

    it('存不住返回 false：写入抛异常（隐私模式 / 配额满）', () => {
      const store = (globalThis as unknown as { window: { sessionStorage: Storage } }).window.sessionStorage;
      const original = store.setItem;
      store.setItem = () => { throw new Error('QuotaExceededError'); };
      try {
        expect(saveOfflineEdit({
          ownerId: USER_A, noteId: NOTE_A, count: 1, content: 'x', savedAt: Date.now(),
        })).toBe(false);
      } finally {
        store.setItem = original;
      }
    });

    it('缺账号或缺笔记时不落盘，也如实返回 false', () => {
      expect(saveOfflineEdit({ ownerId: '', noteId: NOTE_A, count: 1, content: 'x', savedAt: Date.now() })).toBe(false);
      expect(saveOfflineEdit({ ownerId: USER_A, noteId: '', count: 1, content: 'x', savedAt: Date.now() })).toBe(false);
    });
  });

  /*
   * 草稿是用户的正文。键里带账号只决定「恢复谁的草稿」，挡不住同一台设备上的下一个人
   * 去翻本地存储——所以人一登出就得清干净（Codex 第九轮 P1）。
   */
  describe('登出清场', () => {
    it('清掉本机所有账号的草稿，不只清当前这个', () => {
      saveOfflineEdit({ ownerId: USER_A, noteId: NOTE_A, count: 1, content: 'A 的稿子', savedAt: Date.now() });
      saveOfflineEdit({ ownerId: USER_B, noteId: NOTE_B, count: 1, content: 'B 的稿子', savedAt: Date.now() });
      clearAllOfflineEdits();
      expect(loadOfflineEdit(NOTE_A, USER_A)).toBeNull();
      expect(loadOfflineEdit(NOTE_B, USER_B)).toBeNull();
    });

    it('只动自己的键，别人的本地存储不受牵连', () => {
      const store = (globalThis as unknown as { window: { sessionStorage: Storage } }).window.sessionStorage;
      store.setItem('unrelated-key', '别人的东西');
      saveOfflineEdit({ ownerId: USER_A, noteId: NOTE_A, count: 1, content: 'x', savedAt: Date.now() });
      clearAllOfflineEdits();
      expect(store.getItem('unrelated-key')).toBe('别人的东西');
      store.removeItem('unrelated-key');
    });
  });
});

/*
 * 存的是用户录音的正文全文（会议、访谈、商务沟通的原话），不满足 no-localstorage.md
 * 例外清单要求的「非敏感」，所以只能进 sessionStorage——关掉标签页就没了，
 * 横幅也必须照这个边界说话（Codex 第二十轮 P1）。
 * 判据扫源码：改回 localStorage 不会有任何行为测试变红，只有这条会。
 */
describe('草稿不进 localStorage', () => {
  it('模块只碰 sessionStorage', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../recordingOfflineQueue.ts'),
      'utf-8',
    );
    expect(source).toContain('window.sessionStorage');
    expect(source).not.toContain('window.localStorage');
  });
});
