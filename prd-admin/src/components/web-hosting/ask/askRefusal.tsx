import { BookX, Clock, LogIn, MessageCircleOff, RotateCw, Wallet } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import type { LucideIcon } from 'lucide-react';
import { ASK_ERROR_CODES } from './askTypes';

/**
 * 提问被拒的几种形态（设计稿屏 11「失败态 · 主宰与视觉相干河」那一列）。
 *
 * 它们的共同点只有「问不了」，除此之外全都不同：谁能解决、要做什么、还能不能重试。
 * 两种额度尤其不能合并——
 *   访客维度 = 你这一小时问得太多，等一会儿、或者登录换更宽的额度；
 *   站点维度 = 这一页今天的额度（所有访客共用）被别人问光了，你等到明天，或者去评论区找作者。
 * 压成一张「额度用完」，等于把后端已经算出来的信息又丢了一次。
 */
export type AskRefusalKey =
  | 'need-login'
  | 'quota-visitor'
  | 'quota-site'
  | 'quota-exceeded'
  | 'no-content'
  | 'disabled';

export interface AskRefusalConfig {
  icon: LucideIcon;
  title: string;
  /**
   * 兜底正文。后端这几档的 message 里带着真实数字（每小时几次、还剩多久、
   * 本页整体还有几次），有就用后端的——静态文案顶多说个大概，
   * 把带数字的话换成不带数字的话是净损失。
   */
  body: string;
  /** 语气：blocked=用户能自己解决；exhausted=等或找作者；dead=这个站点就是不能问 */
  tone: 'blocked' | 'exhausted' | 'dead';
  /**
   * 用户能点的动作。
   *
   * `login-if-anonymous`：只对匿名访客给「去登录」。已登录的人撞的是自己账号那一档，
   * 送他去登录一圈回来还是同一个额度——一个按了没用的按钮比没有按钮更像功能坏了。
   * 具体给不给由 AskRefusalCard 按 isAuthenticated 解析成 'login' 或者不给。
   */
  action?: 'login' | 'retry' | 'login-if-anonymous';
  /** 动作按钮上的字——每一档的下一步不同，措辞也不该一样 */
  actionLabel?: string;
  /** 输入框被禁用时的占位文案——不能都写「暂不可用」，那等于把拒绝理由又藏回去 */
  placeholder: string;
}

export const ASK_REFUSAL_REGISTRY: Record<AskRefusalKey, AskRefusalConfig> = {
  'need-login': {
    icon: LogIn,
    title: '需要登录才能提问',
    body: '作者只允许登录后提问。登录后可以问，你的昵称会出现在访客名单里。',
    tone: 'blocked',
    action: 'login',
    actionLabel: '登录并继续提问',
    placeholder: '登录后即可提问',
  },
  'quota-visitor': {
    icon: Clock,
    title: '访客维度：你这一小时问得太多',
    body: '你这一小时的提问次数已用完，等一会儿会自己恢复。匿名访客按 IP 计数，登录后按账号计，额度更宽。',
    tone: 'exhausted',
    // 只有匿名访客才该看到「去登录」：他登录之后计数口径从 IP 换成账号，额度确实更宽。
    // 已登录的人撞的就是自己账号那一档，把他送去登录一圈回来还是同一个额度——
    // 给一个按了没用的按钮，比不给按钮更让人觉得这功能坏了。
    action: 'login-if-anonymous',
    actionLabel: '登录换更宽的额度',
    placeholder: '这一小时问得太多了，等一会儿',
  },
  'quota-site': {
    icon: Wallet,
    title: '站点维度：本页今日额度用完',
    body: '这一页今天的问答次数（所有访客共用）已经用完，明天恢复。评论区仍然可用，急着要答案可以在那里问作者。',
    tone: 'exhausted',
    placeholder: '本页今日额度已用完，明天再来',
  },
  'quota-exceeded': {
    icon: Wallet,
    title: '提问额度已用完',
    body: '这一次没能问出去，因为额度用完了。稍后再试，或者去评论区找作者。',
    tone: 'exhausted',
    placeholder: '额度已用完，稍后再试',
  },
  'no-content': {
    icon: BookX,
    title: '读不到本页正文',
    body: '正文取回失败，所以不能回答——我们不猜。可以重试，或直接在评论区问作者。',
    tone: 'dead',
    action: 'retry',
    actionLabel: '重试读取',
    placeholder: '读不到本页正文，可以重试',
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
    case ASK_ERROR_CODES.quotaVisitor: return 'quota-visitor';
    case ASK_ERROR_CODES.quotaSiteDaily: return 'quota-site';
    // 不带维度的旧码（以及别的通用额度来源）只能给笼统那一档
    case ASK_ERROR_CODES.quotaExceeded: return 'quota-exceeded';
    case ASK_ERROR_CODES.noContent: return 'no-content';
    case ASK_ERROR_CODES.disabled: return 'disabled';
    case ASK_ERROR_CODES.unauthorized: return 'need-login';
    default: return null;
  }
}

const TONE_STYLE: Record<AskRefusalConfig['tone'], { bg: string; border: string; fg: string }> = {
  blocked: { bg: 'var(--bg-card)', border: 'var(--border-default)', fg: 'var(--accent-fg-blue)' },
  exhausted: { bg: 'var(--semantic-warning-soft)', border: 'var(--semantic-warning-border)', fg: 'var(--semantic-warning-text)' },
  dead: { bg: 'var(--semantic-danger-soft)', border: 'var(--semantic-danger-border)', fg: 'var(--accent-fg-danger)' },
};

/** 拒绝卡：每一档各有图标、各有语气色、各有下一步，不再是同一句灰字。 */
export function AskRefusalCard({
  refusal, serverMessage, onLogin, onRetry,
}: {
  refusal: AskRefusalKey;
  /** 后端这次给的原话；它带真实数字，优先于注册表里的兜底文案 */
  serverMessage?: string | null;
  onLogin: () => void;
  onRetry: () => void;
}) {
  // 直接读登录态，不做成 prop：这张卡现在挂在 AskThread 下面，而 AskThread 有两个宿主
  // （坞与内嵌面板）。做成 prop 就要求两个宿主都记得传，而「有个宿主忘了传」在这个 PR 里
  // 已经发生过好几次了——判据自己去取，谁也漏不掉。
  const isAuthenticated = useAuthStore((st) => st.isAuthenticated);
  const cfg = ASK_REFUSAL_REGISTRY[refusal];
  const tone = TONE_STYLE[cfg.tone];
  const Icon = cfg.icon;
  const body = serverMessage?.trim() || cfg.body;
  // 解析成一个值，别把这个条件散进下面五处 cfg.action === 'login' 判断里——
  // 散开就是同一个判据抄五份，改一处漏四处。
  const action: 'login' | 'retry' | undefined = cfg.action === 'login-if-anonymous'
    ? (isAuthenticated ? undefined : 'login')
    : cfg.action;

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
        <span style={{ fontSize: 13, fontWeight: 600, color: tone.fg }}>{cfg.title}</span>
      </div>
      <p style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-secondary)', margin: 0 }}>{body}</p>
      {action && (
        <button
          type="button"
          onClick={action === 'login' ? onLogin : onRetry}
          style={{
            alignSelf: 'flex-start', marginTop: 2,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 9, cursor: 'pointer',
            // 主动作（登录）用实心，重试是次动作用描边——两者不该长得一样重
            border: action === 'login' ? 'none' : `1px solid ${tone.border}`,
            background: action === 'login' ? 'var(--button-primary-bg)' : 'transparent',
            color: action === 'login' ? 'var(--button-primary-fg)' : tone.fg,
            fontSize: 12.5, fontWeight: 500,
          }}
        >
          {action === 'login' ? <LogIn size={13} /> : <RotateCw size={13} />}
          {cfg.actionLabel}
        </button>
      )}
    </div>
  );
}
