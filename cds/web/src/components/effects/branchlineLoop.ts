/*
 * Branchline 叙事场景的帧循环（2026-09-20 从 BranchlineScene.jsx 抽出）。
 *
 * 抽出来的唯一理由是可测：循环的每个边界（滚动矩形、rAF、IntersectionObserver、
 * 可见性、WebGL 构建）都由调用方注入，行为测试在 node 里用假边界直接驱动，
 * 不必挂载组件、不必有 WebGL。组件本身只剩「把真边界接上」这一件事。
 *
 * 契约（每条都有行为测试，见 tests/web/branchline-loop-behavior.test.ts）：
 *  - 离屏不排帧、不建场景；由 IntersectionObserver（不带 rootMargin）叫醒
 *  - 第一次进入视口才构建 WebGL；构建失败只失败一次，之后静默退化成纯文字长页
 *  - reduced-motion：时钟冻结为 0、进度不插值、画完一帧即停，只由滚动 / 缩放 / 可见性 / 进入视口再画一帧
 *  - 标签页隐藏即停，回来即续
 *  - dispose：取消挂起的帧、断开观察者、卸掉监听、释放场景
 */

export const CHAPTERS = 5; // Push / Build / Preview / Observe / Ship
export const SEGMENTS = CHAPTERS - 1;

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
export const smooth = (x: number): number => x * x * (3 - 2 * x);
/** 第 i 章在进度 p 处的权重：章心为 1，半宽 w 之外为 0，中间平滑。 */
export const weight = (p: number, i: number, w: number): number => smooth(1 - clamp01(Math.abs(p - i / SEGMENTS) / w));

export interface SceneApi {
  resize(w: number, h: number): void;
  render(p: number, t: number, dt: number): void;
  dispose(): void;
}

interface RectLike { top: number; bottom: number; height: number }
interface ListenerHost {
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void): void;
}
interface StyledElement { style: { opacity: string; transform: string } }
interface ToggleableElement { classList: { toggle(cls: string, force: boolean): void } }
interface ObserverLike { observe(el: unknown): void; disconnect(): void }
type ObserverCtor = new (cb: (entries: Array<{ isIntersecting: boolean }>) => void) => ObserverLike;

export interface BranchlineLoopOptions {
  /** 叙事区根元素：进度由它的矩形算出，也是 IntersectionObserver 的观察对象 */
  root: { getBoundingClientRect(): RectLike };
  /** 五章文案（按进度写 opacity / transform）与右侧进度轨 */
  copies: StyledElement[];
  rails: ToggleableElement[];
  /** 建 WebGL 场景；抛错视为无 WebGL，只尝试一次 */
  build: () => SceneApi;
  reduced: boolean;
  win: ListenerHost & {
    innerWidth: number;
    innerHeight: number;
    requestAnimationFrame(cb: (now: number) => void): number;
    cancelAnimationFrame(id: number): void;
  };
  doc: ListenerHost & { hidden: boolean };
  /** 没有就传 null：退回滚动事件叫醒 */
  IntersectionObserver: ObserverCtor | null;
}

export interface BranchlineLoop {
  dispose(): void;
  /** 只给测试与诊断看：当前有没有挂起的帧、场景建了没 */
  readonly state: { pending: boolean; built: boolean };
}

export function createBranchlineLoop(o: BranchlineLoopOptions): BranchlineLoop {
  const { root, copies, rails, reduced, win, doc } = o;

  // 构建推迟到叙事区第一次进入视口：停在 hero 的访客不为 renderer、PMREM、几何体、HalfFloat 后期缓冲买单
  let built: SceneApi | null = null;
  let buildFailed = false;
  const ensureBuilt = (): boolean => {
    if (built) return true;
    if (buildFailed) return false;
    try { built = o.build(); } catch { buildFailed = true; } // 无 WebGL：退化成纯文字长页
    return Boolean(built);
  };

  let raf = 0; let prog = 0; let railOn = -1; let sized = false; let hidden = doc.hidden; let last = 0;

  const schedule = (): void => { if (!raf && !hidden) raf = win.requestAnimationFrame(frame); };
  const onResize = (): void => { sized = false; schedule(); };
  const onVis = (): void => { hidden = doc.hidden; last = 0; schedule(); };

  function frame(now: number): void {
    raf = 0;
    if (hidden) return;
    const rect = root.getBoundingClientRect();
    const vh = win.innerHeight;
    const inView = rect.bottom > 0 && rect.top < vh;
    // 离屏就真的停：不再重排帧。留在 hero 或页脚时一帧都不跑，由 IntersectionObserver 叫醒
    if (!inView) { last = 0; return; }
    if (!ensureBuilt() || !built) return;
    if (!sized) { built.resize(win.innerWidth, vh); sized = true; }
    const target = clamp01(-rect.top / Math.max(1, rect.height - vh));
    // 按时间插值而不是按帧：低帧率设备（软渲染约 2–3fps）上按帧插值要十几秒才跟上
    const dt = last ? Math.min(100, now - last) : 16; last = now;
    prog += (target - prog) * (reduced ? 1 : 1 - Math.exp(-dt / 140));
    const p = prog;
    for (let i = 0; i < copies.length; i++) {
      const w = weight(p, i, 0.14);
      copies[i].style.opacity = (0.06 + 0.94 * w).toFixed(3);
      copies[i].style.transform = `translateY(${((1 - w) * 1.4).toFixed(2)}rem)`;
    }
    const nearest = Math.round(p * SEGMENTS);
    if (nearest !== railOn) { railOn = nearest; rails.forEach((a, i) => a.classList.toggle('is-on', i === nearest)); }
    // reduced-motion：时钟冻结在 0，镜头呼吸、珠子脉动、星尘漂移、模块自转、域名牌浮动全部静止，只剩滚动本身驱动的变化
    built.render(p, reduced ? 0 : now * 0.001, dt / 1000);
    // reduced-motion 下时钟冻住、进度不插值，下一帧和这一帧一模一样，没必要再按刷新率重绘：
    // 画完这帧就停，等滚动 / 缩放 / 可见性 / 进入视口的门铃再画一帧
    if (!reduced) raf = win.requestAnimationFrame(frame);
  }

  // 只用它当「进入视口」的门铃；不带 rootMargin（2026-09-09 首页死机的根因就是它被转成 rem）
  const io = o.IntersectionObserver
    ? new o.IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) schedule(); })
    : null;
  if (io) io.observe(root);
  // 滚动叫醒：reduced-motion 下每次滚动都要重画一帧；没有 IntersectionObserver 的环境也靠它进场
  const onScroll = (reduced || !io) ? (): void => schedule() : null;
  if (onScroll) win.addEventListener('scroll', onScroll, { passive: true });

  win.addEventListener('resize', onResize, { passive: true });
  doc.addEventListener('visibilitychange', onVis);
  schedule();

  return {
    get state() { return { pending: raf !== 0, built: built !== null }; },
    dispose() {
      if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
      if (io) io.disconnect();
      if (onScroll) win.removeEventListener('scroll', onScroll);
      win.removeEventListener('resize', onResize);
      doc.removeEventListener('visibilitychange', onVis);
      if (built) { built.dispose(); built = null; }
    },
  };
}
