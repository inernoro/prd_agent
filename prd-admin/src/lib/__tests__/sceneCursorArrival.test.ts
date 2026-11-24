import { describe, expect, it } from 'vitest';
import { arrivalKey } from '../../pages/home/components/SceneCursor';

/**
 * 守卫：**「手到位了」这件事什么时候重新判一次。**
 *
 * 首页的每一次点击都是连锁推进的：节拍器把那一拍扣住（armed），指针走过去，
 * 报一次到位，节拍器才放行。所以「什么时候重新判一次到位」直接决定用户看到的
 * 是「按下去，事情就发生」还是「手停在按钮上，一秒多之后才发生」。
 *
 * 两种翻车都真实发生过，各对应下面一组用例：
 *
 *  1. **只看落点**：扣住的那一拍和上一拍常常是同一个目标（走到发送键 → 按下发送键），
 *     落点根本不变，于是永远不重判、放行回调永远不来，只能等 1.4s 保险丝烧断。
 *  2. **只看拍号**：目标换了、新落点还没量出来就报到位，等于拿上一拍的坐标提前放行，
 *     回到最早那个「鼠标还没到发送，消息就发出去了」。
 *
 * 判据挂在纯函数上而不是组件上是有意的：坏的从来不是坐标算得对不对，是重判时机；
 * 而这台机器上的无头浏览器一帧要 400ms，动画级的判据采不到（见 SceneCursor 顶部注释）。
 */

const at = (target: string, left = 100, top = 200) => ({ left, top, target });

describe('指针到位的重判时机', () => {
  it('同一个目标上换了拍号，必须重新判一次（否则同位点击要等保险丝）', () => {
    const walk = arrivalKey(3, at('chat-send'));
    const press = arrivalKey(4, at('chat-send'));
    expect(walk).not.toBeNull();
    expect(press).not.toBe(walk);
  });

  it('拍号没变、落点也没变时不重判（同一拍里别反复报到位）', () => {
    expect(arrivalKey(4, at('chat-send'))).toBe(arrivalKey(4, at('chat-send')));
  });

  it('走到新目标：落点变了就重判', () => {
    expect(arrivalKey(4, at('tile-a', 10, 20))).not.toBe(arrivalKey(4, at('tile-b', 300, 400)));
  });

  it('目标换了但还没量到落点：这一轮不报到位', () => {
    expect(arrivalKey(5, null)).toBeNull();
  });

  it('落点带着「为谁量的」：坐标碰巧一样但目标不同，仍算两次到位', () => {
    // 两个元素恰好重叠（浮层压在按钮上就会这样）时，只比坐标会把「换了目标」漏掉
    expect(arrivalKey(4, at('tile-a', 100, 200))).not.toBe(arrivalKey(4, at('tile-b', 100, 200)));
  });
});
