import { Check, Copy, Eye, Globe, HelpCircle, Lock, User, Users } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

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

/**
 * 门的文案。owner-only 那两档要单独说「无权限」而不是「要登录」——
 * 团队外的人就算登录了也进不去，说成「登录就能看」是错误引导。
 */
const GATE_COPY: Record<VisitorGate, { title: string; hint: string }> = {
  password: {
    title: '访客先看到密码门',
    hint: '输对密码后才进入正文。密码可以口述，也可以连着链接一起复制。',
  },
  login: {
    title: '别人打开只看到「无权限」',
    hint: '仅我可见是默认档：链接可以先建好自己核对，确认无误再改成登录可见或公开。',
  },
  'login-then-password': {
    title: '访客先登录，再输密码',
    hint: '两道门都过了才进入正文；团队成员免密码，直接进。',
  },
  open: {
    title: '访客直接看到正文',
    hint: '任何拿到链接的人都能打开，没有任何拦截。',
  },
};

export const VISIBILITY_LABEL: Record<ShareVisibility, string> = {
  'owner-only': '仅我可见',
  'logged-in': '登录可见',
  public: '公开',
};

/**
 * 分享弹窗右侧的「对外是什么样 · 实时」（设计稿屏 5）。
 *
 * 为什么要有它：可见性、密码、有效期三个开关的组合结果是「访客打开链接时看到什么」，
 * 但用户在旧版里只能看到三个各自独立的控件，得自己在脑子里合成结果。
 * 这一栏把结果画出来，改任何一项都立刻变。
 *
 * 四块从上到下：地址栏（这条链接长什么样）→ 访客看到的那一屏 → 三条核对清单
 * → 二维码与复制。最后一块是**出口**：核对完就在这儿把东西拿走，不用等弹窗跳到下一屏。
 */
export function SharePreviewPane({
  visibility,
  hasPassword,
  password,
  expiresInDays,
  askCount,
  askInherited,
  shareUrl,
  onCopy,
}: {
  visibility: ShareVisibility;
  hasPassword: boolean;
  password: string;
  expiresInDays: number;
  /** 这条链接会展示几条开场问题；0 = 不展示 */
  askCount: number;
  /** true = 用户没动过开场问题那一栏，跟着站点题库走（日后 owner 改题库这条链接会跟着变） */
  askInherited: boolean;
  /** 生成前是示意地址（token 还没有），生成后是真地址 */
  shareUrl: string;
  onCopy: () => void;
}) {
  const gate = resolveVisitorGate(visibility, hasPassword);
  const copy = GATE_COPY[gate];
  const GateIcon = gate === 'open' ? Globe : gate === 'password' ? Lock : visibility === 'owner-only' ? User : Users;

  // 三条核对清单：能确定的画对勾，跟着别处走的画问号 —— 后者不是「没设置」，
  // 是「这条链接不自己定，随站点题库变」，两者语义不同不能同一个图标
  const checks: Array<{ ok: boolean; text: string }> = [
    { ok: true, text: VISIBILITY_LABEL[visibility] },
    { ok: true, text: expiresInDays === 0 ? '永久有效，不会自动失效' : `${expiresInDays} 天后自动失效` },
    askInherited
      ? { ok: false, text: '开场问题继承站点题库' }
      : { ok: true, text: askCount > 0 ? `这条链接单独选了 ${askCount} 条开场问题` : '这条链接不显示开场问题' },
  ];

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
        <Eye size={12} /> 对外是什么样 · 实时
      </div>

      {/* 地址栏示意：让用户先看见「这条链接长什么样」，再看它打开是什么 */}
      <div
        className="flex items-center gap-1.5 rounded-t-lg px-2.5 py-1.5"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', borderBottom: 'none' }}
      >
        <span className="flex gap-1">
          <i className="block rounded-full" style={{ width: 5, height: 5, background: 'var(--text-muted)', opacity: 0.5 }} />
          <i className="block rounded-full" style={{ width: 5, height: 5, background: 'var(--text-muted)', opacity: 0.5 }} />
        </span>
        <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{shareUrl}</span>
      </div>

      {/* 访客看到的那一屏（示意，不是截图） */}
      <div
        className="-mt-2.5 flex flex-col items-center justify-center gap-2 rounded-b-lg px-3 py-6 text-center"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
      >
        <GateIcon size={22} style={{ color: gate === 'open' ? 'var(--semantic-warning-text)' : 'var(--accent-primary)' }} />
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{copy.title}</div>
        <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{copy.hint}</div>
      </div>

      {/* 核对清单 */}
      <ul className="flex flex-col gap-1.5 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
        {checks.map((c, i) => (
          <li key={i} className="flex items-start gap-1.5">
            {c.ok
              ? <Check size={12} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-fg-emerald)' }} />
              : <HelpCircle size={12} className="mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />}
            <span>{c.text}</span>
          </li>
        ))}
      </ul>

      {gate === 'open' && (
        <div
          className="rounded-lg px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)', border: '1px solid var(--semantic-warning-border)' }}
        >
          这条链接没有任何拦截。内容如果不该被转发出去，至少加一道密码。
        </div>
      )}

      {/* 出口：二维码 + 一次把链接和密码都拿走 */}
      <div
        className="flex items-start gap-2.5 rounded-lg p-2.5"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="shrink-0 rounded bg-white p-1">
          <QRCodeSVG value={shareUrl} size={56} level="M" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate font-mono text-[10.5px]" style={{ color: 'var(--text-secondary)' }}>{shareUrl}</div>
          {hasPassword && password && (
            <div className="font-mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>密码 {password}</div>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="mt-0.5 inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-[11.5px]"
            style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
          >
            <Copy size={11} />
            {hasPassword ? '复制链接 + 密码' : '复制链接'}
          </button>
        </div>
      </div>
    </div>
  );
}
