/**
 * 视频生成自动路由：根据用户输入自动判定走 videogen（一镜直出）或 remotion（拆分镜）
 *
 * 路由原则（MVP v1）：
 *   1. 任何附件（PRD / Word / PDF 等） → remotion 分镜（长内容必拆分镜）
 *   2. 纯文本 > 200 字 → remotion（长描述 = 有叙事，走分镜）
 *   3. 其余（短 prompt） → videogen（一镜直出 5s 短片）
 *
 * 用户可在"高级设置"里强制指定，override 此判定。
 */

export type VideoMode = 'videogen' | 'remotion';

export type RoutePreference = 'auto' | 'videogen' | 'remotion';

export const AUTO_ROUTE_TEXT_THRESHOLD = 200;

export interface RouteInput {
  text: string;
  attachmentsCount: number;
  preference?: RoutePreference;
}

export interface RouteDecision {
  mode: VideoMode;
  /** 判定原因，给用户可见的提示条用 */
  reason: string;
  /** 是否来自用户强制偏好（true = 不显示"判断为…"toast） */
  forced: boolean;
}

export function detectVideoMode(input: RouteInput): RouteDecision {
  const { text, attachmentsCount, preference = 'auto' } = input;

  if (preference === 'videogen') {
    return { mode: 'videogen', reason: '你已设置「总是一镜直出」', forced: true };
  }
  if (preference === 'remotion') {
    return { mode: 'remotion', reason: '你已设置「总是拆分镜」', forced: true };
  }

  if (attachmentsCount > 0) {
    return {
      mode: 'remotion',
      reason: `检测到 ${attachmentsCount} 个附件，将拆分镜生成讲解视频`,
      forced: false,
    };
  }

  const trimmedLen = text.trim().length;
  if (trimmedLen > AUTO_ROUTE_TEXT_THRESHOLD) {
    return {
      mode: 'remotion',
      reason: `描述较长（${trimmedLen} 字），将拆分镜生成多镜头视频`,
      forced: false,
    };
  }

  return {
    mode: 'videogen',
    reason: '短描述，将一镜到底直出 5 秒短片',
    forced: false,
  };
}
