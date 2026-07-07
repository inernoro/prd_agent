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
        fontSize: 10,
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
        fontSize: 12,
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
  const h = size === 'sm' ? 30 : 36;
  return (
    <button
      {...rest}
      style={{
        ...BTN_STYLE[variant],
        height: h,
        padding: size === 'sm' ? '0 10px' : '0 14px',
        borderRadius: 'var(--radius-sm)',
        fontSize: size === 'sm' ? 12 : 13,
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
    <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
      {items.map((it) => {
        const active = it.key === activeKey;
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '9px 10px',
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              color: active ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: active ? '1px solid var(--text-primary)' : '1px solid transparent',
              marginBottom: -1,
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
