/**
 * 离线校对队列的两条判据（都是 Codex P1 抓出来的真缺陷，这里把它们钉成会红的用例）：
 *
 * 1. 队列必须**认笔记**——不认的话，从侧栏切到另一条录音会把 A 的校对写进 B。
 * 2. 队列必须**落盘**——只活在 React state 里的话，刷新一次横幅那句
 *    「联网后自动上传，无需重做」就成了空头承诺。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearOfflineEdit,
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
 * 最小的 localStorage。搭的是**真实语义**（存进去、读出来、删掉），不是把被测模块
 * 的行为抄一遍——判据仍然由被测模块给出，桩只提供它依赖的浏览器接口。
 */
beforeAll(() => {
  if (typeof globalThis.window !== 'undefined' && globalThis.window.localStorage) return;
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: store };
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
    expect(isFlushable(edit(NOTE_A, now), NOTE_A, USER_A, now)).toBe(true);
    expect(isFlushable(edit(NOTE_A, now), NOTE_B, USER_A, now)).toBe(false);
  });

  it('落盘之后另一次加载还能接回来（刷新不丢）', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now, '第一次改'));
    const restored = loadOfflineEdit(NOTE_A, USER_A, now);
    expect(restored?.content).toBe('第一次改');
    expect(restored?.count).toBe(2);
  });

  it('另一条笔记读不到这一条的队列', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now));
    expect(loadOfflineEdit(NOTE_B, USER_A, now)).toBeNull();
  });

  it('放太久的队列不再补传，并且当场清掉（覆盖新版本比丢掉更糟）', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now));
    const muchLater = now + 4 * 24 * 60 * 60 * 1000;
    expect(loadOfflineEdit(NOTE_A, USER_A, muchLater)).toBeNull();
    // 过期那次读取顺手清掉，之后即使把时钟拨回来也不会突然复活
    expect(loadOfflineEdit(NOTE_A, USER_A, now)).toBeNull();
  });

  it('补传成功后清空，不会二次覆盖', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now));
    clearOfflineEdit(NOTE_A, USER_A);
    expect(loadOfflineEdit(NOTE_A, USER_A, now)).toBeNull();
  });

  it('空内容不算可补传的队列（避免把笔记写成空白）', () => {
    const now = Date.now();
    expect(isFlushable(edit(NOTE_A, now, ''), NOTE_A, USER_A, now)).toBe(false);
  });

  it('换个账号读不到上一位留下的草稿（共享浏览器不串人）', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now, 'A 的稿子'));
    expect(loadOfflineEdit(NOTE_A, USER_B, now)).toBeNull();
    expect(isFlushable(edit(NOTE_A, now), NOTE_A, USER_B, now)).toBe(false);
  });

  it('没有账号 id 时不落盘（宁可这一次丢掉，也不留一份不知道属于谁的草稿）', () => {
    const now = Date.now();
    saveOfflineEdit(edit(NOTE_A, now, '无主稿子', ''));
    expect(loadOfflineEdit(NOTE_A, '', now)).toBeNull();
    expect(loadOfflineEdit(NOTE_A, USER_A, now)).toBeNull();
  });
});
