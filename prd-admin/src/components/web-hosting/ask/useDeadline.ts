import { useEffect, useState } from 'react';

/** 单次 setTimeout 的上限。给得再离谱的 deadline 也不会一觉睡过去（浏览器对超长延时的行为不可靠）。 */
const MAX_CHUNK_MS = 3_600_000;

/**
 * 等到某个真实时刻，到点了才执行 `onReached`。
 *
 * 为什么不是一句 setTimeout(deadline - now)：浏览器对超长延时不可靠，所以要分段睡；
 * 而分段之后就必须**自己重排下一段**，否则「最多睡一小时」会退化成「一小时后执行一次」——
 * 按天的配额窗口离现在还有好几个小时时，那一次执行拿到的仍是旧状态，之后再没有第二次。
 *
 * 这段判断此前在两处各写了一遍（提交闸门与额度快照），只有一处做了分段重排，
 * 于是闸门到点解开、头上的剩余次数却还写着 0，直到下一次请求才对上
 * （predicate-and-wiring-discipline 形状 3：判据分裂，改一处忘一处）。收敛到这里。
 *
 * `deadline` 为 null / undefined 时不装定时器。
 */
export function useDeadline(deadline: number | null | undefined, onReached: () => void, enabled = true) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !deadline) return;
    const remaining = Math.max(deadline - Date.now(), 0);
    const timer = window.setTimeout(() => {
      if (Date.now() >= deadline) onReached();
      else setTick((n) => n + 1); // 还没到点，重排下一段
    }, Math.min(remaining, MAX_CHUNK_MS) + 500);
    return () => window.clearTimeout(timer);
    // onReached 故意不进依赖：调用方多半传内联箭头函数，进了依赖每次渲染都会重装定时器，
    // 于是永远排不到点上。到点时读的是这一轮渲染的那个闭包，对这两处调用方都成立。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, deadline, tick]);
}
