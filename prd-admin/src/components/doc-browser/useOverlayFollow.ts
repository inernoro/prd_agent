import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 划词浮层的「跟随正文」两件套：滚动位移 + 正文区矩形。
 *
 * 2026-08-25 用户："为什么浮动窗卡卡的，是什么问题是否可以优化？"
 *
 * 根因两条，叠在一起：
 *
 * 1. **每个事件都同步 setState**。scroll 走捕获阶段监听（任意可滚祖先都会触发），
 *    一帧内可能来好几次；每次都在事件回调里同步读布局再触发一次 React 提交。
 *    浮层位置于是既比内容慢一拍，又把每一帧撑长——看着就是「跟不上手」。
 * 2. **同一段逻辑抄了四份**（就地改写条、划词 AI 面板、行内评论输入条、选区高亮层），
 *    四处各有各的写法，修一处必漏另外三处（predicate-and-wiring-discipline.md 形状 3）。
 *
 * 本仓库对高频交互早有定论：gesture-unification.md「高频交互走 ref + 直接 DOM，不 setState，
 * 否则不跟手」，InlineCommentOverlay / InlineCommentConnector 都是 rAF 调度的。
 * 这里把那套收敛成唯一一份：rAF 合帧（一帧至多更新一次）+ 值没变就不更新。
 */

/** 把高频回调收敛成「每帧至多跑一次」；同一帧内后续事件直接丢弃。 */
function useRafThrottle(fn: () => void): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const rafRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);
  return useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      fnRef.current();
    });
  }, []);
}

/**
 * 跟随正文滚动平移：把 translateY 直接写进元素的 style，不经 React。
 *
 * 只留直写这一种，是因为走 state 的那种「跟不上手」：
 * 浏览器先把滚动后的正文画出来，React 下一帧才把浮层挪到位——
 * 浮层永远慢内容一帧，视觉上就是「浮层在正文上滑来滑去、跟不上手」。
 * 直接在 rAF 里写 DOM，浮层与内容在同一帧落位。
 * 这正是 gesture-unification.md 说的「高频交互走 ref + 直接 DOM transform，不 setState」，
 * 也是 InlineCommentConnector 早就在用的写法。
 */
export function useScrollFollowTransform(
  elRef: RefObject<HTMLElement>,
  scrollRef?: RefObject<HTMLElement>,
): void {
  const startRef = useRef<number | null>(null);
  const read = useCallback(
    () => (scrollRef?.current?.scrollTop ?? 0) + window.scrollY,
    [scrollRef],
  );
  const apply = useRafThrottle(() => {
    const el = elRef.current;
    if (!el) return;
    if (startRef.current == null) startRef.current = read();
    const dy = read() - startRef.current;
    const next = dy === 0 ? '' : `translateY(${-dy}px)`;
    if (el.style.transform !== next) el.style.transform = next;
  });
  useEffect(() => {
    startRef.current = read();
    const el = elRef.current;
    if (el) el.style.transform = '';
    window.addEventListener('scroll', apply, true);
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('scroll', apply, true);
      window.removeEventListener('resize', apply);
    };
  }, [elRef, read, apply]);
}

/**
 * 正文滚动区在视口里的位置。钉在正文右上角的条子靠它定位——
 * 侧栏收放、窗口缩放、正文滚动都会挪动这块区域。
 */
export function usePaneRect(scrollRef?: RefObject<HTMLElement>): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const read = useCallback(() => {
    const next = scrollRef?.current?.getBoundingClientRect() ?? null;
    setRect((prev) => {
      // getBoundingClientRect 每次都返回**新对象**，直接 setState 等于每个事件必定重渲染一次，
      // 哪怕面板一动没动。逐字段比过再决定要不要更新。
      if (prev === next) return prev;
      if (!prev || !next) return next;
      const same = prev.top === next.top && prev.left === next.left
        && prev.right === next.right && prev.bottom === next.bottom;
      return same ? prev : next;
    });
  }, [scrollRef]);
  const onScroll = useRafThrottle(read);
  useEffect(() => {
    read();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [read, onScroll]);
  return rect;
}
