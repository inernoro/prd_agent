/**
 * 提问坞四态的几何。
 *
 * 单独成文件、写成纯函数，是因为它同时被三处消费：静态落位、WAAPI 形变的起止帧、
 * 以及浮在长条上方那排提示的定位。三处各算一遍的下场在 predicate-and-wiring-discipline
 * 形状 3 里写着——原型阶段就踩过一次：长条按 1200 宽的舞台算 right，实际舞台 1152，
 * 整条偏了 24px，而三处里只有一处被改。
 */

export type AskDockState = 'collapsed' | 'bar' | 'chat' | 'rail';

export interface AskDockViewport {
  width: number;
  height: number;
  isMobile: boolean;
  /** iOS 手势条高度（env(safe-area-inset-bottom) 的实测值，非 iOS 为 0） */
  safeBottom: number;
}

export interface AskDockBox {
  /** 距视口右缘。用 right/bottom 而不是 left/top：三个状态都贴右下角，贴边的那两条才是不变量 */
  right: number;
  bottom: number;
  width: number;
  height: number;
  /** 四角圆角，形变时一起插值 */
  radius: string;
}

/** 起手长条的目标宽度。窄屏按视口收，不然两端会顶死甚至溢出 */
export function askBarWidth(v: AskDockViewport): number {
  return v.isMobile ? Math.max(220, v.width - 24) : Math.min(660, Math.max(320, v.width - 80));
}

export function askDockGeometry(state: AskDockState, v: AskDockViewport): AskDockBox {
  // 收起态与起手态都贴着视口底：手机上必须把手势条让出来，否则主操作落在系统条下面
  const floorGap = 18 + v.safeBottom;

  switch (state) {
    case 'collapsed':
      return {
        right: v.isMobile ? 14 : 18,
        bottom: floorGap,
        width: 132,
        height: 40,
        radius: '999px',
      };
    case 'bar': {
      const width = askBarWidth(v);
      return {
        right: v.isMobile ? 12 : Math.round((v.width - width) / 2),
        // 桌面端抬高一点给下方的额度小条留位；手机端没有那条，贴着底就行
        bottom: v.isMobile ? floorGap : 39 + floorGap,
        width,
        height: v.isMobile ? 50 : 54,
        radius: '999px',
      };
    }
    case 'rail':
      return { right: 0, bottom: 0, width: 44, height: v.height, radius: '14px 0px 0px 14px' };
    case 'chat':
    default:
      // 手机端整屏接管（右侧 400px 的抽屉在 375 宽的屏上等于把正文挤没）
      return v.isMobile
        ? { right: 0, bottom: 0, width: v.width, height: v.height, radius: '0px' }
        : {
            right: 0,
            bottom: 0,
            width: Math.min(400, Math.max(280, v.width - 40)),
            height: v.height,
            radius: '18px 0px 0px 18px',
          };
  }
}

/** 提示条那一排的底距：紧贴长条上沿再留一口气 */
export function askHintsBottom(v: AskDockViewport): number {
  const bar = askDockGeometry('bar', v);
  return bar.bottom + bar.height + 11;
}

/** 长条下方那条「只依据本页正文 · 还剩几次」的底距 */
export function askMetaBottom(v: AskDockViewport): number {
  return 8 + v.safeBottom;
}
