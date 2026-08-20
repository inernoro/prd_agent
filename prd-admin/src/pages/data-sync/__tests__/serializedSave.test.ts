import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createSerializedSaver } from '../serializedSave';

type Settings = { enabled: boolean; origins: string[]; siteLabel: string };

/**
 * 建一个把 latest 真的存住的宿主，模拟组件里的 ref + setState。
 * 关键点是 `getLatest` 返回的是**被 commit 改过的那一份**，
 * 而不是一份永远不变的初始快照——组件里传 props 快照就是这个 bug。
 */
function makeHost(initial: Settings, persist?: (value: Settings) => Promise<{ ok: boolean; confirmed?: Partial<Settings>; error?: string }>) {
  let latest: Settings | null = initial;
  let busy = false;
  const commits: Settings[] = [];
  const sent: Settings[] = [];
  const errors: string[] = [];

  const save = createSerializedSaver<Settings>({
    getLatest: () => latest,
    commit: (value) => {
      latest = value;
      commits.push(value);
    },
    persist: async (value) => {
      sent.push(value);
      return persist ? persist(value) : { ok: true };
    },
    setBusy: (b) => {
      busy = b;
    },
    isBusy: () => busy,
    onError: (m) => errors.push(m),
    fallbackErrorMessage: '保存失败',
  });

  return { save, sent, commits, errors, current: () => latest };
}

const INITIAL: Settings = { enabled: true, origins: ['https://a.example', 'https://b.example'], siteLabel: '本站' };

describe('对外同步名单的连续改动串行化', () => {
  it('第二次移除必须看到第一次的结果，不能把已撤销的机器放回去', async () => {
    const host = makeHost(INITIAL);

    await host.save((prev) => ({ ...prev, origins: prev.origins.filter((o) => o !== 'https://a.example') }));
    await host.save((prev) => ({ ...prev, origins: prev.origins.filter((o) => o !== 'https://b.example') }));

    // 发给服务端的第二份必须两台都不在——这是「撤销不被覆盖」的实际判据，
    // 因为票据鉴权读的是服务端那份，不是界面上那份。
    expect(host.sent).toHaveLength(2);
    expect(host.sent[0].origins).toEqual(['https://b.example']);
    expect(host.sent[1].origins).toEqual([]);
    expect(host.current()?.origins).toEqual([]);
  });

  it('保存在途时不接新的改动，避免两份整份覆盖写叠在一起', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = makeHost(INITIAL, async () => {
      await gate;
      return { ok: true };
    });

    const first = host.save((prev) => ({ ...prev, origins: prev.origins.filter((o) => o !== 'https://a.example') }));
    // 在途时再点一次：应当被丢弃，而不是排在后面用旧值再覆盖一遍。
    await host.save((prev) => ({ ...prev, enabled: false }));
    expect(host.sent).toHaveLength(1);

    release!();
    await first;
    expect(host.current()?.enabled).toBe(true);
  });

  it('存不上要回滚到改动前，不能让界面显示的名单比服务端窄', async () => {
    const host = makeHost(INITIAL, async () => ({ ok: false, error: '服务端拒绝' }));

    await host.save((prev) => ({ ...prev, origins: [] }));

    expect(host.errors).toEqual(['服务端拒绝']);
    expect(host.current()?.origins).toEqual(INITIAL.origins);
  });

  it('服务端回的那一份优先于本地乐观算出来的那一份', async () => {
    const host = makeHost(INITIAL, async () => ({ ok: true, confirmed: { origins: ['https://server-said.example'] } }));

    await host.save((prev) => ({ ...prev, origins: [] }));

    expect(host.current()?.origins).toEqual(['https://server-said.example']);
  });
});

/**
 * 接线守卫（predicate-and-wiring-discipline 形状 2）：上面那组测试只证明
 * 「helper 每次都对 getLatest() 求值」。真正会复发的改法是在**调用方**把 getLatest
 * 换回一份快照（`() => provider` 而不是 `() => providerRef.current`），
 * 或者让 ProviderCard 重新算好整份名单再传进来。这两种改法删掉之后上面四条仍然全绿，
 * 所以必须由源码扫描钉住。
 */
describe('串行化在 DataSyncPage 上真的接上了', () => {
  const source = readFileSync(new URL('../DataSyncPage.tsx', import.meta.url), 'utf8');

  it('getLatest 读的是 ref 而不是渲染期快照', () => {
    expect(source).toMatch(/getLatest:\s*\(\)\s*=>\s*providerRef\.current/);
  });

  it('ProviderCard 收的是「怎么改」而不是「改成什么」', () => {
    expect(source).toMatch(/onSave:\s*\(mutate:\s*\(prev:\s*ProviderSettings\)\s*=>\s*ProviderSettings\)/);
    // 传值进来就等于又回到快照覆盖写。
    expect(source).not.toMatch(/onSave:\s*\(next:\s*ProviderSettings\)/);
  });

  it('页面用的是共享的 createSerializedSaver，没有另抄一份', () => {
    expect(source).toContain("import { createSerializedSaver } from './serializedSave'");
    expect(source).toContain('createSerializedSaver<ProviderSettings>');
  });
});
