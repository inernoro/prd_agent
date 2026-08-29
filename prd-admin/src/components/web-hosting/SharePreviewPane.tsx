import { Check, Copy, Eye, Globe, HelpCircle, Lock, User, Users } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import { VISIBILITY_ACCESS_HINT, VISIBILITY_LABEL, type ShareVisibility } from './shareVisibility';

// 文案与放行范围的 SSOT 在 ./shareVisibility；这里只做再导出，避免既有 import 路径全改一遍。
export { VISIBILITY_ACCESS_HINT, VISIBILITY_LABEL };
export type { ShareVisibility };

/**
 * 访客会先撞上哪道门 —— 由可见性与密码共同决定，两者是「与」的关系：
 * 登录可见 + 有密码 = 先要登录，再要密码。
 * 抽成纯函数是为了这条组合逻辑可以被测红：写在 JSX 里只能靠断言文案字面量。
 */
export type VisitorGate =
  /** public 无密码：全开 */
  | 'open'
  /** public + 密码：只有密码这一道 */
  | 'password'
  /** logged-in 无密码：任何登录用户都进得来，**不看团队** */
  | 'any-login'
  /** logged-in + 密码：登录 + 密码，团队成员免密 */
  | 'any-login-then-password'
  /** owner-only 无密码：只有我和这个站点已共享团队的成员 */
  | 'team-only'
  /** owner-only + 密码：团队外的人在密码之前就被挡住了 */
  | 'team-only-with-password';

export function resolveVisitorGate(visibility: ShareVisibility, hasPassword: boolean): VisitorGate {
  // 三档各自不同，**不能把 owner-only 与 logged-in 合成同一个门**。
  // 后端 EnforceShareVisibilityAsync 里 logged-in 那一支只判「有没有登录」，
  // 一个团队外的陌生人只要登录了就照样进得来；把它说成「团队外打不开」是
  // 往更安全的方向谎报——owner 会以为外人进不来而放心发出去。
  if (visibility === 'owner-only') return hasPassword ? 'team-only-with-password' : 'team-only';
  if (visibility === 'logged-in') return hasPassword ? 'any-login-then-password' : 'any-login';
  return hasPassword ? 'password' : 'open';
}

/**
 * 这个地址是不是「还没生成」的示意串。
 *
 * 抽成导出的函数是为了能被直接测：判据写在 JSX 里只能靠渲染断言，
 * 而这条判据的后果（扫出一个 404）恰恰是渲染断言最看不出来的那种。
 */
export function isPlaceholderShareUrl(url: string): boolean {
  return /[{}]/.test(url);
}

/**
 * 门的文案。每一条都对着后端真实行为写：可见性先判、密码后判，
 * 且团队内部人免密（IsTeamInsiderForShareAsync）。
 */
const GATE_COPY: Record<VisitorGate, { title: string; hint: string }> = {
  open: {
    title: '访客直接看到正文',
    hint: '任何拿到链接的人都能打开，没有任何拦截。',
  },
  password: {
    title: '访客先看到密码门',
    hint: '输对密码后才进入正文；团队成员免密码，直接进。密码可以口述，也可以连着链接一起复制。',
  },
  'any-login': {
    title: '任何登录用户都能打开',
    hint: '这一档只挡未登录的人——团队外的陌生人只要登录了同样看得到正文。要限定在团队内，改选「仅我和协作者」。',
  },
  'any-login-then-password': {
    title: '访客先登录，再输密码',
    hint: '未登录进不来；登录之后团队外的人还要输对密码，团队成员免密码直接进。',
  },
  'team-only': {
    title: '团队外的人打开只看到「无权限」',
    hint: '这一档放行的是我自己和这个站点已共享团队的成员——不是只有我。要真正谁都打不开，先把站点的团队共享撤掉。',
  },
  'team-only-with-password': {
    title: '团队外的人打开只看到「无权限」',
    hint: '团队外的人在密码之前就被挡住了，密码拦不到额外的人；能进来的团队成员又免密码。要靠密码控制范围，改选「登录可见」或「公开」。',
  },
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
  const urlIsPlaceholder = isPlaceholderShareUrl(shareUrl);
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
          {/*
            链接还没生成时父组件给的是**示意地址**（带 {} 占位段）。那种串扫出来是一条
            不存在的路由——扫的人拿到 404，比没有二维码更糟。所以只有拿到真地址才画可扫的码，
            否则画一个明确「还没有」的占位块。判据认花括号：URL 的路径段里不会有它，
            而它正是父组件标注占位的写法。
          */}
          {urlIsPlaceholder ? (
            <div
              className="flex h-[56px] w-[56px] items-center justify-center rounded text-center text-[9px] leading-tight"
              style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}
            >
              生成后<br />出现二维码
            </div>
          ) : (
            <QRCodeSVG value={shareUrl} size={56} level="M" />
          )}
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
