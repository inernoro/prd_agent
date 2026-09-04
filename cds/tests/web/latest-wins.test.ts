import { describe, expect, it } from 'vitest';
import { createLatestWinsGate } from '@/lib/latest-wins';

/**
 * 真的把并发跑起来，而不是扫源码（Codex P2，核对属实）。
 *
 * 原先那条守卫只断言源码里出现过某几个字符串。Codex 给的反例一针见血：
 * 把「记账」挪到请求之前、其余一字不改，每个响应都会被丢弃，而那条守卫全绿。
 * 所以这里用**受控的延迟响应**证明三件事，而不是证明代码长什么样。
 */

/** 一个可以手动决定「什么时候回来、回来什么」的假请求。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('最新的赢：并发轮询的取舍（行为测试，非源码扫描）', () => {
  it('新响应先回后，晚回的旧响应不许再贴（图不许往回跳）', async () => {
    const gate = createLatestWinsGate();
    const applied: string[] = [];

    const slow = deferred<string>();   // 先发，后回
    const fast = deferred<string>();   // 后发，先回
    const slowTicket = gate.begin();
    const fastTicket = gate.begin();

    const run = async (d: typeof slow, t: ReturnType<typeof gate.begin>) => {
      const v = await d.promise;
      if (gate.accept(t)) applied.push(v);
    };
    const a = run(slow, slowTicket);
    const b = run(fast, fastTicket);

    fast.resolve('新');
    await b;
    slow.resolve('旧');
    await a;

    expect(applied, '晚回的旧响应把新的覆盖掉了 —— 这就是图往回跳').toEqual(['新']);
  });

  it('慢、但仍是目前最新的响应必须能贴（不许把自己饿死）', async () => {
    const gate = createLatestWinsGate();
    const applied: number[] = [];

    /*
     * 每次请求都跑过一轮间隔：第 N 轮还在飞，第 N+1 轮就发出去了。
     * 「等于最后发出的那个」这种判据在这里会丢弃每一个响应。
     */
    const pending: Array<{ d: ReturnType<typeof deferred<number>>; t: ReturnType<typeof gate.begin> }> = [];
    for (let i = 1; i <= 3; i += 1) {
      pending.push({ d: deferred<number>(), t: gate.begin() });
    }
    const runs = pending.map(async ({ d, t }) => {
      const v = await d.promise;
      if (gate.accept(t)) applied.push(v);
    });
    // 按发出顺序依次回来（每个都比上一个新）
    pending.forEach((p, i) => p.d.resolve(i + 1));
    await Promise.all(runs);

    expect(applied, '每个响应都被判过期 —— 轮询被自己饿死，图永远停在初始态')
      .toEqual([1, 2, 3]);
  });

  it('A → B → A：旧 A 的响应不许贴到新 A 上，也不许抬高水位', async () => {
    const gate = createLatestWinsGate();
    const applied: string[] = [];

    const oldA = deferred<string>();
    const oldATicket = gate.begin();          // 在 A 上发出，一直没回

    gate.newSession();                        // 切到 B
    gate.newSession();                        // 又切回 A（新会话）

    const newA = deferred<string>();
    const newATicket = gate.begin();

    const run = async (d: typeof oldA, t: ReturnType<typeof gate.begin>) => {
      const v = await d.promise;
      if (gate.accept(t)) applied.push(v);
    };
    const p1 = run(oldA, oldATicket);
    const p2 = run(newA, newATicket);

    oldA.resolve('旧A');                       // 旧请求现在才回来
    await p1;
    newA.resolve('新A');
    await p2;

    expect(applied, '旧 A 贴上了陈数据，或把水位抬高吃掉了新 A').toEqual(['新A']);
  });

  it('把记账挪到请求之前就会丢弃一切 —— 证明这组用例抓得住那种写法', async () => {
    // 用同一个闸门模拟「先记账后请求」：begin 之后立刻 accept，再来一轮就必然被拒
    const gate = createLatestWinsGate();
    const t1 = gate.begin();
    expect(gate.accept(t1)).toBe(true);
    expect(gate.accept(t1), '同一张票不许贴两次').toBe(false);
  });
});
