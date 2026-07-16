import { describe, it, expect } from 'vitest';
import { runLayerWithSharedAbort } from '../../src/services/deploy-layer-runner.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('deploy-layer-runner 层内共享 abort 执行器', () => {
  it('全部成功时正常返回，signal 不触发', async () => {
    const seen: string[] = [];
    let aborted = false;
    await runLayerWithSharedAbort(['a', 'b', 'c'], async (item, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      seen.push(item);
    });
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(aborted).toBe(false);
  });

  it('首个失败会 abort 共享 signal，踢醒仍在等待的兄弟', async () => {
    const events: string[] = [];
    await expect(runLayerWithSharedAbort(['fail', 'wait'], async (item, signal) => {
      if (item === 'fail') {
        await tick();
        events.push('fail-throw');
        throw new Error('boom');
      }
      // 兄弟停在「排队等待」，只有 signal abort 才醒
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          events.push('sibling-kicked');
          reject(new Error('kicked'));
        }, { once: true });
      });
    })).rejects.toThrow(/boom|kicked/);
    expect(events).toContain('fail-throw');
    expect(events).toContain('sibling-kicked');
  });

  it('等全部闭包终结（含 finally）才向上抛错——不留脱管兄弟', async () => {
    const finalized: string[] = [];
    let slowDone = false;
    await expect(runLayerWithSharedAbort(['fast-fail', 'slow'], async (item) => {
      try {
        if (item === 'fast-fail') throw new Error('boom');
        // 慢兄弟：不理会 abort，模拟正在跑的构建，跑完自己的收尾
        await new Promise<void>((r) => setTimeout(r, 30));
        slowDone = true;
      } finally {
        finalized.push(item);
      }
    })).rejects.toThrow('boom');
    // 抛错时两个闭包的 finally 都必须已执行
    expect(finalized.sort()).toEqual(['fast-fail', 'slow']);
    expect(slowDone).toBe(true);
  });

  it('pickError 决定多错并存时抛哪个（supersede 优先场景）', async () => {
    class SupersededLike extends Error {}
    const result = runLayerWithSharedAbort(
      ['a', 'b'],
      async (item) => {
        if (item === 'a') throw new Error('generic');
        throw new SupersededLike('superseded');
      },
      {
        pickError: (errors) => errors.find((e) => e instanceof SupersededLike) ?? errors[0],
      },
    );
    await expect(result).rejects.toBeInstanceOf(SupersededLike);
  });

  it('空清单直接返回', async () => {
    await expect(runLayerWithSharedAbort([], async () => { throw new Error('never'); })).resolves.toBeUndefined();
  });
});
