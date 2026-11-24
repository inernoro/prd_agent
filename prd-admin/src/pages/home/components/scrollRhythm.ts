import { useEffect, useRef } from 'react';

/**
 * scrollRhythm —— 首页的滚动律动引擎：层次（视差）+ 阻尼（滞后回弹）。
 *
 * 为什么要自己写一小段而不是上 Lenis 之类的平滑滚动库：**不劫持滚动**。
 * 改写 wheel 事件那类方案会破坏触控板惯性、键盘翻页、搜索定位和无障碍焦点滚动，
 * 代价远大于收益。这里页面滚动完全是原生的，只有**视觉**带惯性 —— 用户的手感没变，
 * 但画面像有重量。
 *
 * 三个量：
 *   - `y`        真实 scrollY，跟手，无延迟
 *   - `damped`   弹簧追随 y 的滞后值 —— 视差用它，所以画面比手指"沉"半拍
 *   - `lag`      y - damped，即「这一刻还没跟上的距离」。滚得越快越大，停下归零。
 *                这就是阻尼感的来源：面板按 lag 位移，松手后弹回原位。
 *
 * 全页共用**一个** rAF 循环，订阅者在回调里直接写 DOM style（transform，GPU 合成），
 * 不走 React state —— 十几个区块每帧 setState 会把主线程吃干净。
 * 没有订阅者时循环自动停；标签页隐藏时也停。
 */

export interface ScrollFrame {
  /** 真实滚动位置 */
  y: number;
  /** 弹簧滞后位置。视差取它 */
  damped: number;
  /** y - damped：还没跟上的距离，滚得越快越大 */
  lag: number;
  /** 视口高度，省得每个订阅者自己量 */
  vh: number;
}

type Subscriber = (frame: ScrollFrame) => void;

const subscribers = new Set<Subscriber>();
let raf = 0;
let running = false;
let damped = Number.NaN;

/** 追随系数。0.12 大约 8 帧跟上九成 —— 再小就"拖"，再大就没有阻尼感了 */
const FOLLOW = 0.12;

function tick() {
  const y = window.scrollY;
  const vh = window.innerHeight;
  if (Number.isNaN(damped)) damped = y;
  damped += (y - damped) * FOLLOW;
  // 距离足够近就吸附，避免永远差 0.0001 像素导致 rAF 停不下来
  if (Math.abs(y - damped) < 0.05) damped = y;

  const frame: ScrollFrame = { y, damped, lag: y - damped, vh };
  subscribers.forEach((fn) => fn(frame));

  /*
   * 追上了就停。
   *
   * 以前只要还有订阅者就无条件排下一帧 —— 而 `/home` 一打开就挂着二十来个订阅，
   * 于是人不动、页面也不动的时候，每秒仍有几十帧在给一屏之外的元素写样式。
   * 白烧 CPU 和电，看不出来，也没人会报。
   *
   * 停下之后由 scroll / resize / 切回本页三个信号重新拉起来（见下面的监听），
   * 所以「停」不会让它错过下一次滚动。
   */
  const settled = damped === y;
  if (subscribers.size > 0 && !settled) raf = requestAnimationFrame(tick);
  else running = false;
}

function ensureRunning() {
  if (running || subscribers.size === 0 || document.hidden) return;
  running = true;
  raf = requestAnimationFrame(tick);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else {
      ensureRunning();
    }
  });
}

if (typeof window !== 'undefined') {
  // 循环停在「已追上」那一帧，靠这两个信号重新起步。passive：只读不拦，不影响滚动性能
  window.addEventListener('scroll', ensureRunning, { passive: true });
  window.addEventListener('resize', ensureRunning, { passive: true });
}

export function subscribeScroll(fn: Subscriber): () => void {
  subscribers.add(fn);
  ensureRunning();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      running = false;
      cancelAnimationFrame(raf);
    }
  };
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface ParallaxOptions {
  /**
   * 视差速度。正值随滚动向下漂（显得更近），负值向上漂（显得更远）。
   * 同一屏里给标题和面板相反的符号，两者就分出前后层了 —— 这是"层次感"的全部秘密。
   * 合理区间 ±0.12；再大就会在长页面上把元素甩出容器。
   */
  speed?: number;
  /**
   * 阻尼位移系数：按「还没跟上的距离」额外位移。0 表示不要阻尼，只要视差。
   * 0.06 时快速滚动大约多出 6~10px 的滞后，松手弹回 —— 有重量但不晕。
   */
  damping?: number;
  /** 阻尼位移的绝对值上限（px），防止极端快滚时甩得太夸张 */
  dampingMax?: number;
}

/**
 * 把一个元素挂到律动引擎上。返回的 ref 绑到要位移的那层 DOM。
 *
 * 位置量（offsetTop / height）在挂载与 resize 时缓存一次，逐帧只做算术 ——
 * 每帧调 getBoundingClientRect 会触发强制回流，十几个区块一起来就是掉帧的正主。
 */
export function useParallax<T extends HTMLElement>({
  speed = 0,
  damping = 0,
  dampingMax = 14,
}: ParallaxOptions) {
  const ref = useRef<T>(null);
  const optsRef = useRef({ speed, damping, dampingMax });
  optsRef.current = { speed, damping, dampingMax };

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;

    let top = 0;
    let height = 0;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      top = rect.top + window.scrollY;
      height = rect.height;
    };
    measure();

    /* 布局会变（图片加载、字体替换、展开区块），量一次不够 */
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);

    el.style.willChange = 'transform';

    const unsubscribe = subscribeScroll(({ damped, lag, vh }) => {
      const { speed: sp, damping: dp, dampingMax: dm } = optsRef.current;
      // 元素中心相对视口中心的偏移：进入视口时为正，离开时为负，居中时为 0
      const delta = damped + vh / 2 - (top + height / 2);
      const parallax = delta * sp;
      const drag = dp === 0 ? 0 : Math.max(-dm, Math.min(dm, lag * dp));
      el.style.transform = `translate3d(0, ${(parallax + drag).toFixed(2)}px, 0)`;
    });

    return () => {
      unsubscribe();
      ro.disconnect();
      window.removeEventListener('resize', measure);
      el.style.transform = '';
      el.style.willChange = '';
    };
  }, []);

  return ref;
}
