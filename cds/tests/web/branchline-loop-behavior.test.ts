/**
 * Branchline 帧循环的行为测试（2026-09-20，Codex P1：不测源码拼写，测行为）。
 *
 * 边界全部用假的：rAF 是一个手动推进的队列、IntersectionObserver 是一个能被测试主动触发的桩、
 * WebGL 构建是一个记录调用的 spy。断言的是「在什么输入下循环排没排帧、建没建场景、释没释放」，
 * 与实现怎么写无关——把循环换成等价写法，这些测试照样绿；把契约改坏，它们就红。
 */
import { describe, expect, it } from 'vitest';
import { createBranchlineLoop, weight, type BranchlineLoopOptions, type SceneApi } from '@/components/effects/branchlineLoop';

function harness(over: Partial<{ reduced: boolean; io: boolean; hidden: boolean; buildThrows: boolean }> = {}) {
  const rect = { top: 2000, bottom: 7000, height: 5000 }; // 默认离屏（在视口下方）
  const rafQueue: Array<{ id: number; cb: (now: number) => void }> = [];
  let nextId = 1; let cancelled: number[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const host = (name: 'win' | 'doc') => ({
    addEventListener: (type: string, fn: () => void) => { (listeners[`${name}:${type}`] ||= []).push(fn); },
    removeEventListener: (type: string, fn: () => void) => { listeners[`${name}:${type}`] = (listeners[`${name}:${type}`] || []).filter((f) => f !== fn); },
  });
  const scene = { resize: [] as Array<[number, number]>, render: [] as Array<[number, number, number]>, disposed: 0, builds: 0 };
  const build = (): SceneApi => {
    scene.builds += 1;
    if (over.buildThrows) throw new Error('no webgl');
    return {
      resize: (w, h) => { scene.resize.push([w, h]); },
      render: (p, t, dt) => { scene.render.push([p, t, dt]); },
      dispose: () => { scene.disposed += 1; },
    };
  };
  let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
  let ioDisconnected = 0; let ioObserved: unknown = null;
  const IO = over.io === false ? null : class {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { ioCallback = cb; }
    observe(el: unknown) { ioObserved = el; }
    disconnect() { ioDisconnected += 1; }
  };
  const copies = [0, 1, 2, 3, 4].map(() => ({ style: { opacity: '', transform: '' } }));
  const rails = [0, 1, 2, 3, 4].map(() => ({ on: false, classList: { toggle(_c: string, force: boolean) { this_on(force); } } }));
  function this_on(_: boolean) { /* 由下面逐个绑定 */ }
  rails.forEach((r) => { r.classList = { toggle: (_c: string, force: boolean) => { r.on = force; } }; });
  const doc = { ...host('doc'), hidden: Boolean(over.hidden) };
  const opts: BranchlineLoopOptions = {
    root: { getBoundingClientRect: () => ({ ...rect }) },
    copies, rails, build,
    reduced: Boolean(over.reduced),
    win: {
      ...host('win'), innerWidth: 1400, innerHeight: 1000,
      requestAnimationFrame: (cb) => { const id = nextId++; rafQueue.push({ id, cb }); return id; },
      cancelAnimationFrame: (id) => { cancelled.push(id); const i = rafQueue.findIndex((q) => q.id === id); if (i >= 0) rafQueue.splice(i, 1); },
    },
    doc, IntersectionObserver: IO,
  };
  const loop = createBranchlineLoop(opts);
  return {
    loop, rect, scene, copies, rails, doc,
    /** 跑掉当前挂起的所有帧（一帧内新排的帧留到下一次 tick） */
    tick(now = 16) { const batch = rafQueue.splice(0); batch.forEach((q) => q.cb(now)); return batch.length; },
    pending: () => rafQueue.length,
    cancelled: () => cancelled,
    fire(name: string) { (listeners[name] || []).forEach((f) => f()); },
    listenerCount: (name: string) => (listeners[name] || []).length,
    intersect(yes = true) { ioCallback?.([{ isIntersecting: yes }]); },
    io: () => ({ disconnected: ioDisconnected, observed: ioObserved, wired: ioCallback !== null }),
    setInView() { rect.top = -1500; rect.bottom = 3500; },
    setOffscreen() { rect.top = 2000; rect.bottom = 7000; },
  };
}

describe('Branchline 帧循环：视口门', () => {
  it('离屏时跑一帧就停：不建场景、不再排帧', () => {
    const h = harness();
    expect(h.pending()).toBe(1); // 启动排了一帧去看一眼
    h.tick();
    expect(h.scene.builds).toBe(0);
    expect(h.pending(), '离屏那一帧不许再排下一帧').toBe(0);
  });

  it('IntersectionObserver 报相交才叫醒；进入视口的第一帧才建场景，之后按帧续排', () => {
    const h = harness();
    h.tick();
    expect(h.io().observed).toBeTruthy();
    h.setInView();
    h.intersect();
    expect(h.pending()).toBe(1);
    h.tick(100);
    expect(h.scene.builds).toBe(1);
    expect(h.scene.resize).toEqual([[1400, 1000]]);
    expect(h.scene.render).toHaveLength(1);
    expect(h.pending(), '普通模式在视口内按刷新率续排').toBe(1);
    h.tick(116);
    expect(h.scene.builds, '场景只建一次').toBe(1);
    expect(h.scene.render).toHaveLength(2);
  });

  it('IntersectionObserver 报不相交不叫醒；离开视口后循环自己停下，再相交才恢复', () => {
    const h = harness();
    h.tick();
    h.intersect(false);
    expect(h.pending()).toBe(0);
    h.setInView(); h.intersect(); h.tick(50); h.tick(66);
    const rendered = h.scene.render.length;
    h.setOffscreen();
    h.tick(82);
    expect(h.scene.render).toHaveLength(rendered);
    expect(h.pending(), '离屏那一帧之后不许再排').toBe(0);
    h.setInView(); h.intersect();
    h.tick(200);
    expect(h.scene.render).toHaveLength(rendered + 1);
  });

  it('没有 IntersectionObserver 时退回滚动事件叫醒', () => {
    const h = harness({ io: false });
    h.tick();
    expect(h.listenerCount('win:scroll')).toBe(1);
    h.setInView();
    h.fire('win:scroll');
    expect(h.pending()).toBe(1);
    h.tick(50);
    expect(h.scene.render).toHaveLength(1);
  });

  it('进度与文案随矩形走：章心处该章不透明、别的章几乎透明，进度轨只点亮最近的一章', () => {
    const h = harness({ reduced: true }); // reduced 不插值，进度直接等于目标，便于断言
    h.rect.height = 5000; h.rect.top = -2000; h.rect.bottom = 3000; // p = 2000 / 4000 = 0.5 → 第三章
    h.intersect(); h.tick(50);
    expect(h.scene.render[0][0]).toBeCloseTo(0.5, 5);
    expect(Number(h.copies[2].style.opacity)).toBeCloseTo(1, 3);
    expect(Number(h.copies[0].style.opacity)).toBeCloseTo(0.06, 3);
    expect(h.rails.map((r) => r.on)).toEqual([false, false, true, false, false]);
    expect(weight(0.5, 2, 0.14)).toBe(1);
  });
});

describe('Branchline 帧循环：reduced-motion', () => {
  it('时钟冻结为 0，画完一帧即停，滚动再画一帧', () => {
    const h = harness({ reduced: true });
    h.setInView();
    h.tick(1234);
    expect(h.scene.render).toEqual([[expect.any(Number), 0, 16 / 1000]]);
    expect(h.pending(), '相同画面不许按刷新率重绘').toBe(0);
    h.fire('win:scroll');
    expect(h.pending()).toBe(1);
    h.tick(2345);
    expect(h.scene.render).toHaveLength(2);
    expect(h.scene.render[1][1], '第二帧时钟仍是 0').toBe(0);
  });

  it('普通模式的时钟在走', () => {
    const h = harness();
    h.setInView();
    h.tick(1500);
    expect(h.scene.render[0][1]).toBeCloseTo(1.5, 6);
  });
});

describe('Branchline 帧循环：可见性、构建失败、释放', () => {
  it('标签页隐藏时一帧都不跑，回到前台才续', () => {
    const h = harness({ hidden: true });
    h.setInView();
    expect(h.pending(), '启动时就隐藏，连第一帧都不排').toBe(0);
    h.doc.hidden = false;
    h.fire('doc:visibilitychange');
    expect(h.pending()).toBe(1);
    h.tick(50);
    expect(h.scene.render).toHaveLength(1);
    h.doc.hidden = true;
    h.fire('doc:visibilitychange');
    h.tick(66);
    expect(h.scene.render, '隐藏后的帧不渲染').toHaveLength(1);
    expect(h.pending()).toBe(0);
  });

  it('构建抛错只尝试一次，之后退化成纯文字长页而不是每帧重试', () => {
    const h = harness({ buildThrows: true });
    h.setInView();
    h.tick(50);
    expect(h.scene.builds).toBe(1);
    expect(h.pending()).toBe(0);
    h.intersect(); h.tick(66);
    expect(h.scene.builds, '不重试').toBe(1);
    expect(h.loop.state.built).toBe(false);
  });

  it('dispose：取消挂起的帧、断开观察者、卸掉全部监听、释放场景', () => {
    const h = harness({ reduced: true });
    h.setInView(); h.tick(50);
    h.fire('win:scroll'); // 挂起一帧
    expect(h.pending()).toBe(1);
    h.loop.dispose();
    expect(h.pending()).toBe(0);
    expect(h.cancelled()).toHaveLength(1);
    expect(h.io().disconnected).toBe(1);
    expect(h.scene.disposed).toBe(1);
    for (const name of ['win:scroll', 'win:resize', 'doc:visibilitychange']) expect(h.listenerCount(name), name).toBe(0);
    expect(h.loop.state).toEqual({ pending: false, built: false });
  });

  it('resize 后下一帧重新量尺寸', () => {
    const h = harness();
    h.setInView(); h.tick(50);
    expect(h.scene.resize).toHaveLength(1);
    h.fire('win:resize');
    h.tick(66);
    expect(h.scene.resize).toHaveLength(2);
  });
});
