/**
 * 「只认最新那次请求的结果」（Codex review 第八轮 P2）。
 *
 * 治的是切项目时的慢响应覆盖：从 `/settings/A#backup` 切到 `/settings/B#backup`，
 * React Router 复用同一个组件实例，A 的请求还在飞；A 慢一点回来，它的 setData
 * 就落在 B 的后面，B 的设置页上摆着 A 的备份目标、目录和失败详情。
 *
 * 这个仓库的 web 测试没有 DOM 环境，组件里的竞态断不出来，所以判定抽成了模块。
 * 下面这两条按**真实时序**跑两次异步请求，断言只有最新那次被采纳——不是去源码里
 * 找某个字符串在不在（形状 4：断言实现的字面存在，证明不了行为）。
 */
import { describe, expect, it } from 'vitest';
import { createLatestOnly } from '../../web/src/lib/latest-only.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('只认最新那次请求的结果', () => {
  it('先发的慢请求回来时已经不算数了', async () => {
    const latest = createLatestOnly();
    const applied: string[] = [];

    async function load(name: string, delayMs: number): Promise<void> {
      const isCurrent = latest.begin();
      await sleep(delayMs);
      if (!isCurrent()) return;
      applied.push(name);
    }

    // A 慢（30ms）、B 快（5ms）：真实里就是切走之后老请求才回来。
    const a = load('A', 30);
    const b = load('B', 5);
    await Promise.all([a, b]);

    // 只有 B 落地。少了这条判据，applied 会是 ['B', 'A']——最后写进去的是 A。
    expect(applied).toEqual(['B']);
  });

  it('只有一次请求时照常生效', async () => {
    const latest = createLatestOnly();
    const isCurrent = latest.begin();
    await sleep(1);
    expect(isCurrent()).toBe(true);
  });
});
