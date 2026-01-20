import { useState, useEffect } from 'react';
import { Users, ChevronRight, X } from 'lucide-react';
import { getUsers } from '@/services';
import type { AdminUser } from '@/types/admin';

interface AuthzUserBarProps {
  selectedUserId: string | null;
  onSelectUser: (userId: string | null) => void;
}

export function AuthzUserBar({ selectedUserId, onSelectUser }: AuthzUserBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (expanded && users.length === 0) {
      loadUsers();
    }
  }, [expanded]);

  const loadUsers = async () => {
    setLoading(true);
    const res = await getUsers({ page: 1, pageSize: 50 });
    if (res.success) {
      setUsers((res.data.items || []) as AdminUser[]);
    }
    setLoading(false);
  };

  const selectedUser = users.find((u) => u.userId === selectedUserId);

  return (
    <div
      className="rounded-2xl overflow-hidden transition-all duration-300"
      style={{
        background: 'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%)',
        backdropFilter: 'blur(20px) saturate(180%)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 4px 24px -4px rgba(0,0,0,0.3)',
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* 用户按钮 */}
        <button
          type="button"
          className="flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-200 hover:bg-white/6"
          style={{
            background: expanded ? 'rgba(214, 178, 106, 0.12)' : 'rgba(255,255,255,0.04)',
            border: expanded ? '1px solid rgba(214, 178, 106, 0.25)' : '1px solid rgba(255,255,255,0.08)',
          }}
          onClick={() => {
            if (expanded) {
              setExpanded(false);
              onSelectUser(null);
            } else {
              setExpanded(true);
            }
          }}
        >
          <Users size={16} style={{ color: expanded ? 'rgba(214, 178, 106, 0.9)' : 'var(--text-secondary)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            用户
          </span>
          <ChevronRight
            size={14}
            className="transition-transform duration-200"
            style={{
              transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
              color: 'var(--text-muted)',
            }}
          />
        </button>

        {/* 展开后的用户列表 */}
        <div
          className="flex items-center gap-2 overflow-hidden transition-all duration-300"
          style={{
            maxWidth: expanded ? '800px' : '0',
            opacity: expanded ? 1 : 0,
          }}
        >
          {loading ? (
            <div className="text-xs px-3" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </div>
          ) : (
            <div className="flex items-center gap-2 overflow-x-auto py-1 px-1" style={{ scrollbarWidth: 'none' }}>
              {users.map((user) => (
                <UserCard
                  key={user.userId}
                  user={user}
                  isSelected={user.userId === selectedUserId}
                  onClick={() => onSelectUser(user.userId === selectedUserId ? null : user.userId)}
                />
              ))}
              {users.length === 0 && (
                <div className="text-xs px-3" style={{ color: 'var(--text-muted)' }}>
                  暂无用户
                </div>
              )}
            </div>
          )}
        </div>

        {/* 选中的用户显示 */}
        {selectedUser && !expanded && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              查看:
            </span>
            <div
              className="flex items-center gap-2 px-2 py-1 rounded-lg"
              style={{ background: 'rgba(214, 178, 106, 0.1)' }}
            >
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium"
                style={{ background: 'var(--gold-gradient)', color: '#1a1206' }}
              >
                {(selectedUser.displayName || selectedUser.username || '?')[0].toUpperCase()}
              </div>
              <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                {selectedUser.displayName || selectedUser.username}
              </span>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-white/10"
                onClick={() => onSelectUser(null)}
              >
                <X size={12} style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface UserCardProps {
  user: AdminUser;
  isSelected: boolean;
  onClick: () => void;
}

function UserCard({ user, isSelected, onClick }: UserCardProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const initial = (user.displayName || user.username || '?')[0].toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl transition-all duration-200 hover:scale-105"
        style={{
          background: isSelected
            ? 'linear-gradient(135deg, rgba(214, 178, 106, 0.2) 0%, rgba(214, 178, 106, 0.1) 100%)'
            : 'rgba(255,255,255,0.04)',
          border: isSelected ? '1px solid rgba(214, 178, 106, 0.4)' : '1px solid rgba(255,255,255,0.08)',
          boxShadow: isSelected ? '0 4px 12px -2px rgba(214, 178, 106, 0.2)' : 'none',
        }}
        onClick={onClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium shrink-0"
          style={{
            background: isSelected ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.08)',
            color: isSelected ? '#1a1206' : 'var(--text-secondary)',
          }}
        >
          {initial}
        </div>
        <span
          className="text-xs font-medium whitespace-nowrap"
          style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}
        >
          {user.displayName || user.username}
        </span>
      </button>

      {/* Tooltip */}
      {showTooltip && (
        <div
          className="absolute left-1/2 -translate-x-1/2 top-full mt-2 px-3 py-2 rounded-lg z-50 whitespace-nowrap"
          style={{
            background: 'rgba(30, 30, 30, 0.95)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.1)',
            boxShadow: '0 8px 24px -4px rgba(0,0,0,0.4)',
          }}
        >
          <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {user.displayName || user.username}
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            角色: {user.systemRoleKey || (user.role === 'ADMIN' ? 'admin' : 'none')}
          </div>
        </div>
      )}
    </div>
  );
}
