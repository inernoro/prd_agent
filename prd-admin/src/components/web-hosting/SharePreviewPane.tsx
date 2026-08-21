import { Eye, Globe, Lock, User, Users } from 'lucide-react';

export type ShareVisibility = 'owner-only' | 'logged-in' | 'public';

/**
 * 访客会先撞上哪道门 —— 由可见性与密码共同决定，两者是「与」的关系：
 * 登录可见 + 有密码 = 先要登录，再要密码。
 * 抽成纯函数是为了这条组合逻辑可以被测红：写在 JSX 里只能靠断言文案字面量。
 */
export type VisitorGate = 'password' | 'login' | 'login-then-password' | 'open';

export function resolveVisitorGate(visibility: ShareVisibility, hasPassword: boolean): VisitorGate {
  if (visibility === 'owner-only') return hasPassword ? 'login-then-password' : 'login';
  if (visibility === 'logged-in') return hasPassword ? 'login-then-password' : 'login';
  return hasPassword ? 'password' : 'open';
}

const GATE_COPY: Record<VisitorGate, { title: string; hint: string }> = {
  password: { title: '访客先看到密码门', hint: '输对密码后才进入正文' },
  login: { title: '访客先被要求登录', hint: '登录后才能看到正文，名单里会有他的昵称' },
  'login-then-password': { title: '访客先登录，再输密码', hint: '两道门都过了才进入正文' },
  open: { title: '访客直接看到正文', hint: '任何拿到链接的人都能打开，没有任何拦截' },
};

export const VISIBILITY_LABEL: Record<ShareVisibility, string> = {
  'owner-only': '仅我 / 团队',
  'logged-in': '登录可见',
  public: '公开',
};

/**
 * 分享弹窗右侧的「对外是什么样」实时预览（设计稿屏 5）。
 *
 * 为什么要有它：可见性、密码、有效期三个开关的组合结果是「访客打开链接时看到什么」，
 * 但用户在旧版里只能看到三个各自独立的控件，得自己在脑子里合成结果。
 * 这一栏把结果画出来，改任何一项都立刻变。
 */
export function SharePreviewPane({
  visibility,
  hasPassword,
  password,
  expiresInDays,
  linkType,
  askCount,
}: {
  visibility: ShareVisibility;
  hasPassword: boolean;
  password: string;
  expiresInDays: number;
  linkType: 'long' | 'short';
  /** 这条链接会展示几条开场问题；0 = 不展示 */
  askCount: number;
}) {
  const gate = resolveVisitorGate(visibility, hasPassword);
  const copy = GATE_COPY[gate];
  const GateIcon = gate === 'open' ? Globe : gate === 'password' ? Lock : visibility === 'owner-only' ? User : Users;

  return (
    <div
      className="flex flex-col gap-3 rounded-xl p-3"
      style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
        <Eye size={12} /> 对外是什么样 · 实时
      </div>

      {/* 访客看到的那一屏（示意，不是截图） */}
      <div
        className="flex flex-col items-center justify-center gap-2 rounded-lg px-3 py-6 text-center"
        style={{ background: 'var(--bg-card)', border: '1px dashed var(--border-default)' }}
      >
        <GateIcon size={22} style={{ color: gate === 'open' ? 'var(--semantic-warning-text)' : 'var(--accent-primary)' }} />
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{copy.title}</div>
        <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{copy.hint}</div>
        {hasPassword && password && (
          <div className="mt-1 rounded px-2 py-1 font-mono text-[12px]" style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
            {password}
          </div>
        )}
      </div>

      {/* 这条链接的三件事，逐条对齐上面的开关 */}
      <ul className="flex flex-col gap-1 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
        <li>· 可见性：{VISIBILITY_LABEL[visibility]}</li>
        <li>· 有效期：{expiresInDays === 0 ? '永久有效' : `${expiresInDays} 天后自动失效`}</li>
        <li>· 链接形式：{linkType === 'long' ? '字母长链（不可枚举）' : '数字短链（可被枚举）'}</li>
        {askCount > 0 && <li>· 提问面板会带 {askCount} 条开场问题</li>}
      </ul>

      {gate === 'open' && (
        <div
          className="rounded-lg px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)', border: '1px solid var(--semantic-warning-border)' }}
        >
          这条链接没有任何拦截。内容如果不该被转发出去，至少加一道密码。
        </div>
      )}
    </div>
  );
}
