import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * 场景节拍器 —— 让一幕「演给你看」，而不是一上来就是做完的样子。
 *
 * 用法：给一串每拍停留时长（ms），拿回当前拍号和一个挂在面板上的 ref。
 *
 *   const { beat, ref } = useSceneTimeline([900, 1600, 700, ...]);
 *
 * 三条行为约定：
 *   · 面板**进入视口才开始走**，滚出去就停在原地不空转（也顺带省掉离屏的绘制）；
 *   · 走完最后一拍会停一会儿再从头来，让人有机会看第二遍；
 *   · `prefers-reduced-motion` 下**直接落到最后一拍**——不演过程，但结果要完整，
 *     否则关掉动效的人看到的就是一个空画布（`expectation-management`：
 *     少给动画可以，少给内容不行）。
 */
export function useSceneTimeline(holds: number[], options: { loop?: boolean; restartDelay?: number } = {}) {
  const { loop = true, restartDelay = 2600 } = options;
  const [beat, setBeat] = useState(0);
  /** 面板是否在视口里。给调用方用来关掉离屏的常驻动画（星点、扫光）。 */
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatRef = useRef(0);
  const holdsRef = useRef(holds);
  holdsRef.current = holds;

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
    };

    const step = () => {
      const total = holdsRef.current.length;
      const current = beatRef.current;
      const last = current >= total - 1;
      const wait = last ? restartDelay : holdsRef.current[current];
      timer.current = setTimeout(() => {
        if (last && !loop) return;
        const next = last ? 0 : current + 1;
        beatRef.current = next;
        setBeat(next);
        step();
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
  }, [loop, restartDelay]);

  return { beat, ref, visible };
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
