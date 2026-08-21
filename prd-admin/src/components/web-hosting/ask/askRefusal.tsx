import { BookX, LogIn, MessageCircleOff, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ASK_ERROR_CODES } from './askTypes';

/**
 * 提问被拒的几种形态。
 *
 * 它们的共同点只有「问不了」，除此之外全都不同：谁能解决、要做什么、还能不能重试。
 * 旧版把它们混成一句灰色小字塞在面板底部，用户只看到「问不了」，不知道是自己没登录、
 * 还是这个站点今天问完了、还是这个站点压根没有可读的正文——三种情况的下一步天差地别。
 */
export type AskRefusalKey = 'need-login' | 'quota-exceeded' | 'no-content' | 'disabled';

export interface AskRefusalConfig {
  icon: LucideIcon;
  title: string;
  /** 为什么问不了，一句话，讲人话不讲错误码 */
  body: string;
  /** 语气：blocked=用户能自己解决；exhausted=等或找主人；dead=这个站点就是不能问 */
  tone: 'blocked' | 'exhausted' | 'dead';
  /** 有没有用户能点的动作；只有 need-login 有 */
  action?: 'login';
  /** 输入框被禁用时的占位文案——不能都写「暂不可用」，那等于把拒绝理由又藏回去 */
  placeholder: string;
}

export const ASK_REFUSAL_REGISTRY: Record<AskRefusalKey, AskRefusalConfig> = {
  'need-login': {
    icon: LogIn,
    title: '这个页面要登录后才能提问',
    body: '主人把提问限制为登录访客——登录之后回到这一页，提问面板就能用了。',
    tone: 'blocked',
    action: 'login',
    placeholder: '登录后即可提问',
  },
  'quota-exceeded': {
    icon: Wallet,
    title: '这个站点今天的提问额度用完了',
    body: '额度按站点每天重置，明天再来就能继续问；急着要答案可以直接找页面主人。',
    tone: 'exhausted',
    placeholder: '今日额度已用完，明天再来',
  },
  'no-content': {
    icon: BookX,
    title: '读不到这个页面的正文',
    body: '这个站点是图片、视频或需要脚本渲染的页面，提取不到可供回答的文字，所以问了也答不准。',
    tone: 'dead',
    placeholder: '这个页面没有可供回答的正文',
  },
  disabled: {
    icon: MessageCircleOff,
    title: '这个站点没有开启提问',
    body: '页面主人可以在站点卡片的「提问设置」里打开。',
    tone: 'dead',
    placeholder: '这个站点没有开启提问',
  },
};

/**
 * 该显示哪一种拒绝，还是不拒绝（返回 null）。
 *
 * 抽成纯函数的原因见 predicate-and-wiring-discipline：这里是**优先级**判断，
 * 「未登录」要压过服务端返回的任何错误码——没登录时拿到的额度错误是上一次会话的残留，
 * 报给用户只会让他去等一个根本不需要等的额度。写在 JSX 的连环三元里，这条优先级
 * 一改就没人知道。
 */
export function resolveAskRefusal(args: {
  isAuthenticated: boolean;
  allowAnonymous: boolean;
  gateErrorCode?: string | null;
}): AskRefusalKey | null {
  const { isAuthenticated, allowAnonymous, gateErrorCode } = args;
  if (!isAuthenticated && !allowAnonymous) return 'need-login';
  switch (gateErrorCode) {
    case ASK_ERROR_CODES.quotaExceeded: return 'quota-exceeded';
    case ASK_ERROR_CODES.noContent: return 'no-content';
    case ASK_ERROR_CODES.disabled: return 'disabled';
    case ASK_ERROR_CODES.unauthorized: return 'need-login';
    default: return null;
  }
}

const TONE_STYLE: Record<AskRefusalConfig['tone'], { bg: string; border: string; fg: string }> = {
  blocked: { bg: 'var(--bg-card)', border: 'var(--border-default)', fg: 'var(--accent-primary)' },
  exhausted: { bg: 'var(--semantic-warning-soft)', border: 'var(--semantic-warning-border)', fg: 'var(--semantic-warning-text)' },
  dead: { bg: 'var(--bg-card)', border: 'var(--border-subtle)', fg: 'var(--text-muted)' },
};

/** 拒绝卡：三种形态各有图标、各有语气色、各有下一步，不再是同一句灰字。 */
export function AskRefusalCard({ refusal, onLogin }: { refusal: AskRefusalKey; onLogin: () => void }) {
  const cfg = ASK_REFUSAL_REGISTRY[refusal];
  const tone = TONE_STYLE[cfg.tone];
  const Icon = cfg.icon;

  return (
    <div
      style={{
        marginTop: 14, padding: 14, borderRadius: 12,
        background: tone.bg, border: `1px solid ${tone.border}`,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={16} style={{ color: tone.fg, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{cfg.title}</span>
      </div>
      <p style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-secondary)', margin: 0 }}>{cfg.body}</p>
      {cfg.action === 'login' && (
        <button
          type="button"
          onClick={onLogin}
          style={{
            alignSelf: 'flex-start', marginTop: 2,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 9, border: 'none', cursor: 'pointer',
            background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)',
            fontSize: 12.5, fontWeight: 500,
          }}
        >
          <LogIn size={13} /> 去登录
        </button>
      )}
    </div>
  );
}
