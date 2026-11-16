import { useAuthStore } from '@/stores/authStore';
import type { ReactNode } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import './workspace.css';

export function compact(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    notation: value >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}
export function WorkspaceMetric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  tone?: 'warning' | 'danger' | 'good';
}) {
  return (
    <div className={`ws-metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value ?? '—'}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
export function WorkspacePanel({
  title,
  hint,
  action,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ws-panel ${className}`}>
      <header className="ws-panel-head">
        <div>
          <h2>{title}</h2>
          {hint && <span>{hint}</span>}
        </div>
        {action}
      </header>
      <div className="ws-panel-body">{children}</div>
    </section>
  );
}
export function WorkspaceEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ws-empty">
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function WorkspaceSearch({
  value,
  onChange,
  placeholder = '搜索',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="ws-search">
      <Search size={14} />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function PersonAvatar({
  person,
  size = 28,
}: {
  person: {
    displayName: string;
    avatarFileName?: string | null;
    avatarUrl?: string | null;
  };
  size?: number;
}) {
  return (
    <span
      className="ws-avatar"
      style={{ width: size, height: size }}
      title={person.displayName}
    >
      {person.avatarFileName || person.avatarUrl ? (
        <UserAvatar
          src={person.avatarUrl || resolveAvatarUrl(person)}
          alt={`${person.displayName}的头像`}
          loading="lazy"
        />
      ) : (
        <span role="img" aria-label={`${person.displayName}的姓名头像`}>
          {Array.from(person.displayName)[0] || '人'}
        </span>
      )}
    </span>
  );
}
export function WorkspaceLink({
  children,
  onClick,
  permission,
}: {
  children: ReactNode;
  onClick: () => void;
  permission?: string;
}) {
  const allowed = useAuthStore(
    (state) =>
      !permission ||
      state.isRoot ||
      state.permissions.includes('super') ||
      state.permissions.includes(permission),
  );
  if (!allowed) return null;
  return (
    <button type="button" className="ws-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={13} />
    </button>
  );
}
