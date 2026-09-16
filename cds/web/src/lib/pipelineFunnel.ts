/**
 * 流水线漏斗的三段分流——唯一一份。
 *
 * 2026-09-15 从 `pages/reports/CompactStrip.tsx` 挪到 lib：判断句那一侧也要用它，
 * 而 lib 不该反过来依赖 pages。放在这里，图、明细行与判断句读的是同一个函数。
 */
import type { PipelineFunnel } from './api';

export interface FunnelSegments {
  /** 还没起过预览的改动数。 */
  undeployed: number;
  /** 起了预览但没人验的改动数（「货堆」）。 */
  heap: number;
  /** 已验完的改动数。 */
  accepted: number;
}

/**
 * 把一个漏斗拆成流水线的三段：没起预览 / 待验收 / 已验完。
 *
 * **三段相加恒等于 changes**，靠的是逐级夹取（deployed 夹进 changes，accepted 再夹进
 * deployed），不是各段各自 max(0, …)。分别夹会在脏数据上失守：验过的比部署的还多时
 * （报告挂在一条从没部署过的分支上就会这样），heap 被夹成 0 而 accepted 原样留着，
 * 三段之和大于 changes，画出来就是分段条比总长还长、数字对不上。
 *
 * 总览、放大态每一行、以及第一屏那句判断共用这一个函数。这件事此前有两份实现、
 * 口径不同，而两份都「看起来对」——Codex review 连着抓到两次，第二次是判断句
 * 用 `accepted >= changes` 自己判，于是屏幕上「都验过了」配一张画着未验收方块的图。
 */
export function splitFunnel(f: PipelineFunnel): FunnelSegments {
  const changes = Math.max(0, f.changes);
  const deployed = Math.max(0, Math.min(changes, f.deployed));
  const accepted = Math.max(0, Math.min(deployed, f.accepted));
  return { undeployed: changes - deployed, heap: deployed - accepted, accepted };
}
