/**
 * 「一键整理」那张卡片网格的状态判定（纯函数，单测覆盖）。
 *
 * 对齐设计稿 B3：四张整理方式卡各自回答「这一种整理，现在是什么状态」——
 * 已生成（带多久之前）/ 生成中（带百分比）/ 还没点过。
 *
 * 有一件事必须说清楚，否则后来人会以为是实现漏了：
 * **同一时刻只可能有一张卡是「已生成」**。后端的换风格是**原地替换**同一份笔记的摘要节
 * （`restyleTranscribeRun` 的语义就是「免重跑 ASR，原地更新」），不是每种风格各存一份。
 * 所以这张网格表达的是「当前这份摘要是用哪种方式整理的」，不是「已经攒了几种」。
 * 稿面画的也正好是一张已生成、一张生成中、两张待生成——两边对得上。
 * 若将来要做成每种各存一份，那是后端存储形态的改动，不是这里加个数组。
 */

export type OrganizeStyle = {
  key: string;
  label: string;
  description: string;
};

export type OrganizeCardState = 'done' | 'running' | 'idle';

export type OrganizeCard = {
  key: string;
  label: string;
  description: string;
  state: OrganizeCardState;
  /** 卡片副行：「已生成 · 12 秒前」/「生成中 40%」/「点击生成」 */
  hint: string;
};

/** 自定义整理不进网格——稿面把它单独做成一条虚线按钮。 */
export const CUSTOM_STYLE_KEY = 'custom';

/**
 * 「多久之前」。给不出就返回空串，由调用方退回「已生成」三个字——
 * 不编一个「刚刚」出来（no-rootless-tree）。
 */
export function formatAgo(fromIso: string | null | undefined, now: number): string {
  if (!fromIso) return '';
  const at = new Date(fromIso).getTime();
  if (Number.isNaN(at)) return '';
  const sec = Math.floor((now - at) / 1000);
  // 时钟回拨或服务端时间超前时不显示，而不是显示一个负数或「0 秒前」
  if (sec < 0) return '';
  if (sec < 60) return `${Math.max(1, sec)} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

export function describeOrganizeCards(
  styles: OrganizeStyle[],
  ctx: {
    /** 当前这份摘要用的整理方式（笔记条目的 transcribe_style_key） */
    currentStyleKey?: string | null;
    /** 这份摘要的生成时间（笔记条目的 updatedAt） */
    generatedAt?: string | null;
    /** 正在跑的那一种；没有在途 run 就不传 */
    runningStyleKey?: string | null;
    /** 在途 run 的进度 0-100 */
    runningPercent?: number | null;
    now?: number;
  },
): OrganizeCard[] {
  const now = ctx.now ?? Date.now();
  const running = ctx.runningStyleKey?.trim().toLowerCase() || '';
  const current = ctx.currentStyleKey?.trim().toLowerCase() || '';

  return styles
    .filter(style => style.key !== CUSTOM_STYLE_KEY)
    .map((style) => {
      // 在途优先于已生成：同一种方式正在重跑时，它此刻的真实状态是「生成中」
      if (running && style.key === running) {
        const percent = Math.min(100, Math.max(0, Math.round(ctx.runningPercent ?? 0)));
        return { ...style, state: 'running' as const, hint: `生成中 ${percent}%` };
      }
      if (current && style.key === current) {
        const ago = formatAgo(ctx.generatedAt, now);
        return { ...style, state: 'done' as const, hint: ago ? `已生成 · ${ago}` : '已生成' };
      }
      return { ...style, state: 'idle' as const, hint: '点击生成' };
    });
}
