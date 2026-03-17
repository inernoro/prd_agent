import { resolveAvatarUrl } from '@/lib/avatar';
import { getUsers } from '@/services';
import type { AdminUser } from '@/types/admin';
import { Check, ChevronDown, Search, User } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 相对时间格式化 */
function fmtRelative(v?: string | null) {
  if (!v) return '';
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const sec = Math.floor(Math.abs(diff) / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const suffix = diff >= 0 ? '前' : '后';
  if (sec < 60) return `${sec}秒${suffix}`;
  if (min < 60) return `${min}分钟${suffix}`;
  if (hr < 24) return `${hr}小时${suffix}`;
  if (day < 365) return `${day}天${suffix}`;
  return '';
}

export const ROLE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  PM: { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)', text: 'rgba(59,130,246,0.95)' },
  DEV: { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.25)', text: 'rgba(34,197,94,0.95)' },
  QA: { bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.25)', text: 'rgba(168,85,247,0.95)' },
  ADMIN: { bg: 'rgba(99,102,241,0.12)', border: 'rgba(99,102,241,0.25)', text: 'var(--accent-gold)' },
};

export interface UserSearchSelectProps {
  /** 当前选中的 userId（空字符串表示未选中） */
  value: string;
  /** 选中用户回调 */
  onChange: (userId: string) => void;
  /** 预加载的用户列表（不传则组件内部自动获取） */
  users?: AdminUser[];
  /** 占位文本 */
  placeholder?: string;
  /** 是否显示"全部用户"选项（用于过滤场景） */
  showAllOption?: boolean;
  /** "全部用户"选项的文案 */
  allOptionLabel?: string;
  /** 尺寸：sm 适合过滤栏，md 适合表单 */
  uiSize?: 'sm' | 'md';
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 可搜索用户选择器（公共组件）
 *
 * 显示用户头像、昵称、用户名、角色徽章、最后活跃时间。
 * 支持按昵称、用户名、角色搜索。
 * 使用 Portal 渲染下拉面板，避免父级 stacking context 导致 z-index 问题。
 *
 * 用法：
 * - 过滤栏场景：`<UserSearchSelect value={userId} onChange={setUserId} showAllOption uiSize="sm" />`
 * - 表单场景：`<UserSearchSelect value={userId} onChange={setUserId} />`
 */
export function UserSearchSelect({
  value,
  onChange,
  users: externalUsers,
  placeholder = '搜索用户名或昵称...',
  showAllOption = false,
  allOptionLabel = '全部用户',
  uiSize = 'md',
  className,
  style,
}: UserSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 下拉面板位置（Portal 渲染需要绝对坐标）
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // 内部用户数据（当外部未提供时自动获取）
  const [internalUsers, setInternalUsers] = useState<AdminUser[]>([]);
  const [fetched, setFetched] = useState(false);

  const users = externalUsers ?? internalUsers;

  // 自动获取用户列表（仅在未提供外部用户且首次打开时）
  useEffect(() => {
    if (externalUsers || fetched) return;
    if (!open) return;
    setFetched(true);
    void getUsers({ page: 1, pageSize: 200 }).then((res) => {
      if (res.success) {
        setInternalUsers(res.data.items.filter((u) => u.status === 'Active'));
      }
    });
  }, [externalUsers, fetched, open]);

  const selected = users.find((u) => u.userId === value);
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? users.filter(
        (u) =>
          u.displayName.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q) ||
          (u.role ?? '').toLowerCase().includes(q)
      )
    : users;

  // 计算下拉面板位置
  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 260),
    });
  }, []);

  // 打开时计算位置，滚动/resize 时更新
  useEffect(() => {
    if (!open) return;
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, updatePos]);

  // Close on outside click (检查 trigger 和 portal panel)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) {
        setOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Auto-focus search input
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const isCompact = uiSize === 'sm';
  const triggerHeight = isCompact ? 'h-9' : 'h-10';
  const triggerRadius = isCompact ? 'rounded-[12px]' : 'rounded-[10px]';
  const triggerFontSize = 'text-[13px]';

  const dropdownPanel = open && pos && createPortal(
    <div
      ref={panelRef}
      className="rounded-[12px] flex flex-col overflow-hidden"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: '320px',
        zIndex: 9999,
        background: 'var(--glass-bg-end, rgba(22, 22, 28, 0.98))',
        border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
        boxShadow: '0 18px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      }}
    >
      {/* Search input */}
      <div className="px-3 pt-2.5 pb-2 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full h-[32px] rounded-[8px] pl-8 pr-3 text-[13px] outline-none"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'var(--text-primary)',
            }}
            placeholder={placeholder}
            autoFocus
          />
        </div>
      </div>

      {/* User list */}
      <div className="overflow-auto flex-1 py-1">
        {/* 全部用户选项 */}
        {showAllOption && !q && (
          <div
            className="flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors hover:bg-white/8"
            style={!value ? { background: 'rgba(var(--accent-gold-rgb, 212,175,55), 0.08)' } : undefined}
            onClick={() => {
              onChange('');
              setOpen(false);
              setFilter('');
            }}
          >
            <User size={16} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{allOptionLabel}</span>
            {!value && <Check size={14} className="ml-auto shrink-0" style={{ color: 'var(--accent-gold)' }} />}
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {q ? `未找到匹配「${filter}」的用户` : '暂无可用用户'}
          </div>
        ) : (
          filtered.map((u) => {
            const ava = resolveAvatarUrl({ username: u.username, userType: u.userType, botKind: u.botKind, avatarFileName: u.avatarFileName });
            const isSelected = u.userId === value;
            const rc = ROLE_COLORS[u.role] || ROLE_COLORS.DEV;
            const isBot = String(u.userType ?? '').toLowerCase() === 'bot';
            const activeText = fmtRelative(u.lastActiveAt);
            const loginText = fmtRelative(u.lastLoginAt);
            return (
              <div
                key={u.userId}
                className="flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-white/8"
                style={isSelected ? { background: 'rgba(var(--accent-gold-rgb, 212,175,55), 0.08)' } : undefined}
                onClick={() => {
                  onChange(u.userId);
                  setOpen(false);
                  setFilter('');
                }}
              >
                <img src={ava} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" referrerPolicy="no-referrer" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {u.displayName}
                    </span>
                    <span
                      className="shrink-0 text-[9px] font-bold px-1 py-px rounded-[3px] leading-tight"
                      style={{ background: rc.bg, border: `1px solid ${rc.border}`, color: rc.text }}
                    >
                      {u.role}
                    </span>
                    {isBot && (
                      <span className="shrink-0 text-[9px] px-1 py-px rounded-[3px] leading-tight" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)', color: 'rgba(34,197,94,0.9)' }}>
                        BOT
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                      @{u.username}
                    </span>
                    {(activeText || loginText) && (
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
                        {activeText ? `活跃 ${activeText}` : loginText ? `登录 ${loginText}` : ''}
                      </span>
                    )}
                  </div>
                </div>
                {isSelected && <Check size={16} className="shrink-0" style={{ color: 'var(--accent-gold)' }} />}
              </div>
            );
          })
        )}
      </div>

      {/* Footer count */}
      <div className="px-3 py-1.5 text-[10px] shrink-0" style={{ color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        {q ? `${filtered.length} / ${users.length} 人匹配` : `共 ${users.length} 人`}
      </div>
    </div>,
    document.body,
  );

  return (
    <div className={`relative ${className ?? ''}`}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        className={`flex items-center gap-2 ${triggerHeight} w-full ${triggerRadius} px-3 cursor-pointer transition-all duration-200 text-left ${triggerFontSize}`}
        style={{
          background: 'var(--bg-input)',
          border: open ? '1px solid var(--accent-gold)' : '1px solid rgba(255,255,255,0.12)',
          color: 'var(--text-primary)',
          ...style,
        }}
        onClick={() => {
          setOpen(!open);
          if (!open) setFilter('');
        }}
      >
        <User size={isCompact ? 14 : 14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        {value && selected ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <img
              src={resolveAvatarUrl({ username: selected.username, userType: selected.userType, botKind: selected.botKind, avatarFileName: selected.avatarFileName })}
              alt=""
              className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'} rounded-full object-cover shrink-0`}
              referrerPolicy="no-referrer"
            />
            <span className="truncate">{selected.displayName}</span>
            {!isCompact && <span className="text-[11px] opacity-50 truncate">@{selected.username}</span>}
          </div>
        ) : (
          <span className="flex-1" style={{ color: 'var(--text-muted)' }}>
            {showAllOption ? allOptionLabel : placeholder}
          </span>
        )}
        <ChevronDown
          size={14}
          className="shrink-0 transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>

      {dropdownPanel}
    </div>
  );
}
