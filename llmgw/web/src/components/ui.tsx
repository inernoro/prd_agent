// 轻量自包含 UI 原语（不复用 prd-admin 的 design/*，本 mini-app 独立组件风格）。

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export function Chip({ label, color, bg, title }: { label: string; color: string; bg: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '0 6px',
        height: 17,
        fontSize: 'var(--fs-micro)',
        fontWeight: 600,
        flexShrink: 0,
        color,
        background: bg,
      }}
    >
      {label}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="lg-spin" style={{ color: 'var(--accent)' }} />;
}

export function SectionLoader({ text }: { text?: string }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 40,
        color: 'var(--text-muted)',
        fontSize: 'var(--fs-caption)',
      }}
    >
      <Spinner size={22} />
      {text ? <span>{text}</span> : null}
    </div>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'ghost';

const BTN_STYLE: Record<BtnVariant, CSSProperties> = {
  primary: { background: 'var(--accent)', color: 'var(--accent-contrast)', border: '1px solid transparent' },
  secondary: { background: 'var(--bg-input)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' },
  ghost: { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid transparent' },
};

export function Button({
  variant = 'secondary',
  size = 'md',
  children,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; children: ReactNode }) {
  // 高度落在控件基准区间（32~38），字号走 --fs-secondary：按钮文字是要读的，不能用 12px 角标档。
  const h = size === 'sm' ? 32 : 36;
  return (
    <button
      {...rest}
      style={{
        ...BTN_STYLE[variant],
        height: h,
        padding: size === 'sm' ? '0 10px' : '0 14px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--fs-secondary)',
        fontWeight: 500,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        opacity: rest.disabled ? 0.5 : 1,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s, opacity 0.15s, border-color 0.15s, color 0.15s',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Card({ children, style, className }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <div
      className={className}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-card)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 页面级提示条（错误 / 成功 / 说明）。
 *
 * 此前每个页面自己拍一套 errorStyle / noticeStyle，且有一批写的是 `var(--danger)`
 * 与 `var(--success)` —— 这两个 token 在 theme.css 里**从未定义过**，于是整条
 * `color` 声明作废：报错文字根本没变红，用 color-mix 的地方连底色和边框都一起丢了。
 * 语义色只有 --ok / --warn / --err / --info 四个（外加 -bg），一律从这里取。
 */
export function InlineAlert({ tone = 'info', children }: { tone?: 'error' | 'ok' | 'info'; children: ReactNode }) {
  const token = tone === 'error' ? 'err' : tone === 'ok' ? 'ok' : 'info';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        padding: '9px 11px',
        border: `1px solid color-mix(in srgb, var(--${token}) 32%, transparent)`,
        borderRadius: 'var(--radius-sm)',
        background: `var(--${token}-bg)`,
        color: `var(--${token})`,
        fontSize: 'var(--fs-body)',
        lineHeight: 'var(--lh-body)',
      }}
    >
      {children}
    </div>
  );
}

export function ReadOnlyNotice({ children = '当前角色可以查看这些配置，但不能修改。需要变更时请联系 Owner 或 Admin。' }: { children?: ReactNode }) {
  return (
    // 整句话，走正文档：12px 承载成句解释正是「字号乱」的观感来源（规则三守卫会拦）。
    <div role="status" style={{ padding: '9px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 'var(--lh-body)' }}>
      {children}
    </div>
  );
}

export function TabBar<K extends string>({
  items,
  activeKey,
  onChange,
}: {
  items: { key: K; label: string }[];
  activeKey: K;
  onChange: (k: K) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, overflowX: 'auto', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, scrollbarWidth: 'none' }}>
      {items.map((it) => {
        const active = it.key === activeKey;
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            style={{
              background: 'transparent',
              border: 'none',
              minHeight: 44,
              padding: '10px 14px',
              fontSize: 'var(--fs-body)',
              fontWeight: active ? 600 : 500,
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
              whiteSpace: 'nowrap',
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
