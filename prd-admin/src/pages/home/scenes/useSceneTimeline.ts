import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * 场景节拍器 —— 让一幕「演给你看」，而不是一上来就是做完的样子。
 *
 * 用法：给一串每拍停留时长（ms），拿回当前拍号和一个挂在面板上的 ref。
 *
 *   const { beat, ref } = useSceneTimeline([900, 1600, 700, ...]);
 *
 * 四条行为约定：
 *   · 面板**进入视口才开始走**，滚出去就停在原地不空转（也顺带省掉离屏的绘制）；
 *   · 走完最后一拍会停一会儿再从头来，让人有机会看第二遍；
 *   · `prefers-reduced-motion` 下**直接落到最后一拍**——不演过程，但结果要完整，
 *     否则关掉动效的人看到的就是一个空画布（`expectation-management`：
 *     少给动画可以，少给内容不行）。
 *   · **`gates` 里的拍不由时钟进入，由「上一个动作真的完成了」触发**（见下）。
 *
 * ## 为什么要有 gates：定时移动，触发式推进
 *
 * 老写法是纯时钟：时间一到 `beat++`，于是「指针开始走」和「事情发生」是同一毫秒。
 * 指针飞过去要走位时长，事却在第 0 毫秒就成了 —— 观众看到的必然是
 * 「还没点到就已经生效」。
 *
 * 上一版靠插「走位空拍」把两者错开，能用，但**正确性挂在我手调的毫秒数上**：
 * 谁把走位时长从 460 改成 900，那个 560ms 的空拍就不够了，bug 悄悄回来。
 *
 * 现在改成连锁：时钟只负责**让手移动**；要进入一个 gated 拍时先把手派过去，
 * 手真的落到目标上再 `release()`，这一拍才开始 —— 上一个扳手扣下，才引发下一个。
 * 时序不再由数字保证，而是由「谁先谁后」的结构保证。
 *
 * 兜底很要紧：手可能根本不存在（窄屏不画指针、reduced-motion、目标元素没渲染）。
 * 所以 arm 的同时挂一个 `gateTimeoutMs` 的保险，超时照常放行 —— 退化成老的纯时钟行为，
 * 绝不会把整幕卡死。
 */
export function useSceneTimeline(
  holds: number[],
  options: {
    loop?: boolean;
    restartDelay?: number;
    /** 这些拍不由时钟直接进入：先 arm，等 release() 才真正开始 */
    gates?: ReadonlySet<number>;
    /** 保险丝：arm 后这么久还没人 release 就自行放行（手不存在时退化成纯时钟） */
    gateTimeoutMs?: number;
  } = {},
) {
  const { loop = true, restartDelay = 2600, gates, gateTimeoutMs = 1400 } = options;
  const [beat, setBeat] = useState(0);
  /** 正在等「手到位」的那一拍；没有就是 null */
  const [armed, setArmed] = useState<number | null>(null);
  /** 面板是否在视口里。给调用方用来关掉离屏的常驻动画（星点、扫光）。 */
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatRef = useRef(0);
  const holdsRef = useRef(holds);
  holdsRef.current = holds;
  const gatesRef = useRef(gates);
  gatesRef.current = gates;
  /** release 的落点。每次 arm 换一个新函数，防止上一拍的 release 迟到把这一拍提前放行 */
  const releaseRef = useRef<(() => void) | null>(null);
  const fuseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) {
      setBeat(holdsRef.current.length - 1);
      setVisible(true);
      return undefined;
    }

    const clear = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (fuseRef.current) { clearTimeout(fuseRef.current); fuseRef.current = null; }
      releaseRef.current = null;
      setArmed(null);
    };

    /** 真正进入某一拍 */
    const enter = (next: number) => {
      setArmed(null);
      releaseRef.current = null;
      if (fuseRef.current) { clearTimeout(fuseRef.current); fuseRef.current = null; }
      beatRef.current = next;
      setBeat(next);
      step();
    };

    const step = () => {
      const total = holdsRef.current.length;
      const current = beatRef.current;
      const last = current >= total - 1;
      const wait = last ? restartDelay : holdsRef.current[current];
      timer.current = setTimeout(() => {
        if (last && !loop) return;
        const next = last ? 0 : current + 1;
        if (!gatesRef.current?.has(next)) { enter(next); return; }
        // gated：先把手派过去，等它落地。fired 保证只放行一次（release 与保险丝赛跑）
        let fired = false;
        const go = () => { if (fired) return; fired = true; enter(next); };
        releaseRef.current = go;
        setArmed(next);
        fuseRef.current = setTimeout(go, gateTimeoutMs);
      }, wait);
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) { clear(); step(); }
        else clear();
      },
      // 0.3 而不是 0：面板刚露出一条边就开演，用户往下滚到位时已经错过前几拍了
      { threshold: 0.3 },
    );
    io.observe(node);

    return () => { clear(); io.disconnect(); };
  }, [loop, restartDelay, gateTimeoutMs]);

  /** 手已经落到 armed 那一拍的目标上了 —— 可以开始这一拍。多次调用无害。 */
  const release = useCallback(() => { releaseRef.current?.(); }, []);

  return { beat, ref, visible, armed, release };
}

/**
 * 打字机 —— 只在 `active` 为真时逐字吐出，用于「用户正在输入」那一拍。
 * 不用逐字符 setState 刷渲染，按帧算该显示到第几个字，避免长句子刷爆。
 */
export function useTypewriter(text: string, active: boolean, durationMs = 1400): string {
  const [shown, setShown] = useState('');

  useEffect(() => {
    if (!active) { setShown(''); return undefined; }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) { setShown(text); return undefined; }

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const n = Math.round(p * text.length);
      setShown(text.slice(0, n));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, active, durationMs]);

  return shown;
}

/**
 * 进场包装：某个元素从第几拍开始出现。
 * 返回可直接摊进 style 的对象——四幕里「新东西落位」的动作全走这一个，
 * 保证淡入距离与曲线一致（散着写必然各自漂移）。
 */
export function enterAt(beat: number, at: number, options: { rise?: number; delay?: number } = {}): CSSProperties {
  const { rise = 10, delay = 0 } = options;
  const on = beat >= at;
  return {
    opacity: on ? 1 : 0,
    transform: on ? 'translateY(0) scale(1)' : `translateY(${rise}px) scale(0.985)`,
    transition: `opacity .5s cubic-bezier(.19,1,.22,1) ${delay}ms, transform .5s cubic-bezier(.19,1,.22,1) ${delay}ms`,
    pointerEvents: on ? 'auto' : 'none',
  };
}
