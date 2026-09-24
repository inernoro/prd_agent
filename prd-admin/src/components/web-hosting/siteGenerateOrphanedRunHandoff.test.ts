import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handOffOrphanedGenerationRun,
  hasRecoverableGenerationRun,
  subscribeOrphanedGenerationRun,
} from './workbench/useSiteGenerationRun';

const hook = readFileSync(new URL('./workbench/useSiteGenerationRun.ts', import.meta.url), 'utf8');

/**
 * 创建请求在路上时工作台被关掉又重开（Codex P2，2026-09-24）。
 *
 * 旧实例卸载时只 abort 了流，创建请求照样回来，并把 runId 写进存储——可新实例的
 * reset() 早就读过存储、发现是空的，于是它停在空表单，第一条任务在看不见的地方跑，
 * 用户还能再发一条。修法：旧实例拿到结果先看自己是否已被 abort，是就把 runId 交出去
 * （存进存储 + 通知眼前空闲的实例接管），自己不再往下走。
 */
function installMemoryStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  (globalThis as { sessionStorage?: unknown }).sessionStorage = storage;
}

afterEach(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});

describe('被关掉的工作台拿到的任务要交给眼前那一个', () => {
  it('交出的任务写进存储，下次打开能接回', () => {
    installMemoryStorage();
    expect(hasRecoverableGenerationRun()).toBe(false);
    handOffOrphanedGenerationRun('run-orphan');
    expect(hasRecoverableGenerationRun()).toBe(true);
  });

  it('挂着的实例立即收到通知，退订后不再收到', () => {
    installMemoryStorage();
    const received: string[] = [];
    const unsubscribe = subscribeOrphanedGenerationRun((runId) => received.push(runId));
    handOffOrphanedGenerationRun('run-a');
    unsubscribe();
    handOffOrphanedGenerationRun('run-b');
    expect(received).toEqual(['run-a']);
  });

  it('创建返回后先判 abort，再碰任何本实例状态', () => {
    const created = hook.indexOf('const created = await createDesignArtifactRun(');
    const guard = hook.indexOf('if (abort.signal.aborted) {', created);
    const firstState = hook.indexOf('setActiveRunRuntime(created.data.runtime)', created);
    expect(created).toBeGreaterThan(-1);
    expect(guard, '创建返回后没有判断这个实例是否已被关掉').toBeGreaterThan(created);
    expect(guard).toBeLessThan(firstState);
    const branch = hook.slice(guard, guard + 200);
    expect(branch).toContain('handOffOrphanedGenerationRun(created.data.runId)');
    expect(branch).toContain('return;');
  });

  it('空闲实例订阅交接并接管，忙时不抢', () => {
    const subscribe = hook.indexOf('subscribeOrphanedGenerationRun((runId) => {');
    expect(subscribe).toBeGreaterThan(-1);
    const body = hook.slice(subscribe, subscribe + 200);
    expect(body).toContain('if (busyRef.current) return;');
    expect(body).toContain('resumeRun(runId)');
    // companion：忙闲标记在开始生成与收尾两头都有维护，否则判据是空转的。
    expect(hook.match(/busyRef\.current = true;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(hook.match(/busyRef\.current = false;/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
