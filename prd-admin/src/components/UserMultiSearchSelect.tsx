import { resolveAvatarUrl } from '@/lib/avatar';
import { getRoleMeta } from '@/lib/roleConfig';
import { getUsers } from '@/services';
import type { AdminUser } from '@/types/admin';
import { Check, ChevronDown, Search, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface UserMultiSearchSelectProps {
  /** 当前选中的 userId 列表 */
  value: string[];
  /** 选中用户变化回调 */
  onChange: (userIds: string[]) => void;
  /** 预加载的用户列表（不传则组件内部自动获取） */
  users?: AdminUser[];
  /** 需要排除的 userId 列表（如已有成员） */
  excludeUserIds?: string[];
  /** 占位文本 */
  placeholder?: string;
  /** 尺寸：sm 适合过滤栏，md 适合表单 */
  uiSize?: 'sm' | 'md';
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 可搜索多选用户选择器
 *
 * 基于 UserSearchSelect 模式，支持多选 + 搜索 + 已选用户 chips 展示。
 * 使用 Portal 渲染下拉面板，避免父级 stacking context 导致 z-index 问题。
 */
export function UserMultiSearchSelect({
  value,
  onChange,
  users: externalUsers,
  excludeUserIds,
  placeholder = '搜索并选择用户...',
  uiSize = 'md',
  className,
  style,
}: UserMultiSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const [internalUsers, setInternalUsers] = useState<AdminUser[]>([]);
  const [fetched, setFetched] = useState(false);

  const allUsers = externalUsers ?? internalUsers;

  const excludeSet = useMemo(() => new Set(excludeUserIds ?? []), [excludeUserIds]);
  const availableUsers = useMemo(
    () => allUsers.filter((u) => !excludeSet.has(u.userId)),
    [allUsers, excludeSet],
  );

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

  const selectedUsers = useMemo(
    () => value.map((id) => allUsers.find((u) => (u.userId) === id)).filter(Boolean) as AdminUser[],
    [value, allUsers],
  );

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = availableUsers;
    if (!q) return list;
    return list.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        (u.role ?? '').toLowerCase().includes(q),
    );
  }, [availableUsers, q]);

  const toggleUser = useCallback(
    (userId: string) => {
      if (value.includes(userId)) {
        onChange(value.filter((id) => id !== userId));
      } else {
        onChange([...value, userId]);
      }
    },
    [value, onChange],
  );

  const removeUser = useCallback(
    (userId: string) => {
      onChange(value.filter((id) => id !== userId));
    },
    [value, onChange],
  );

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 300),
    });
  }, []);

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

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const isCompact = uiSize === 'sm';

  const dropdownPanel =
    open &&
    pos &&
    createPortal(
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
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--text-muted)' }}
            />
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
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {q ? `未找到匹配「${filter}」的用户` : '暂无可用用户'}
            </div>
          ) : (
            filtered.map((u) => {
              const uid = u.userId;
              const ava = resolveAvatarUrl({
                username: u.username,
                userType: u.userType,
                botKind: u.botKind,
                avatarFileName: u.avatarFileName,
              });
              const isSelected = value.includes(uid);
              const rm = getRoleMeta(u.role);
              const RoleIcon = rm.icon;
              return (
                <div
                  key={uid}
                  className="flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-white/8"
                  style={isSelected ? { background: 'rgba(var(--accent-gold-rgb, 212,175,55), 0.08)' } : undefined}
                  onClick={() => toggleUser(uid)}
                >
                  {/* Checkbox */}
                  <div
                    className="w-4 h-4 rounded shrink-0 flex items-center justify-center transition-colors"
                    style={{
                      border: isSelected ? '1.5px solid var(--accent-gold, #d4af37)' : '1.5px solid rgba(255,255,255,0.2)',
                      background: isSelected ? 'rgba(var(--accent-gold-rgb, 212,175,55), 0.15)' : 'transparent',
                    }}
                  >
                    {isSelected && <Check size={10} style={{ color: 'var(--accent-gold)' }} />}
                  </div>
                  <img src={ava} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" referrerPolicy="no-referrer" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {u.displayName}
                      </span>
                      <span
                        className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-px rounded-[3px] leading-tight"
                        style={{ background: rm.bg, border: `1px solid ${rm.border}`, color: rm.color }}
                      >
                        <RoleIcon size={9} />
                        {rm.label}
                      </span>
                    </div>
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                      @{u.username}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer count */}
        <div
          className="px-3 py-1.5 text-[10px] shrink-0 flex items-center justify-between"
          style={{ color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <span>{q ? `${filtered.length} / ${availableUsers.length} 人匹配` : `共 ${availableUsers.length} 人`}</span>
          {value.length > 0 && <span style={{ color: 'var(--accent-gold)' }}>已选 {value.length} 人</span>}
        </div>
      </div>,
      document.body,
    );

  return (
    <div className={`relative ${className ?? ''}`}>
      {/* Trigger */}
      <div
        ref={triggerRef}
        className={`flex items-center gap-2 min-h-[${isCompact ? '36px' : '40px'}] w-full ${isCompact ? 'rounded-[12px]' : 'rounded-[10px]'} px-3 py-1.5 cursor-pointer transition-all duration-200 text-[13px] flex-wrap`}
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
        <Users size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        {selectedUsers.length > 0 ? (
          <>
            {selectedUsers.map((u) => (
              <span
                key={u.userId}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-primary)',
                }}
              >
                {u.displayName}
                <X
                  size={10}
                  className="cursor-pointer opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeUser(u.userId);
                  }}
                />
              </span>
            ))}
          </>
        ) : (
          <span className="flex-1" style={{ color: 'var(--text-muted)' }}>
            {placeholder}
          </span>
        )}
        <ChevronDown
          size={14}
          className="shrink-0 transition-transform duration-150 ml-auto"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        />
      </div>

      {dropdownPanel}
    </div>
  );
}
