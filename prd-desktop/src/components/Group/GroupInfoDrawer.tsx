import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { useGroupInfoDrawerStore } from '../../stores/groupInfoDrawerStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useAuthStore } from '../../stores/authStore';
import type { ApiResponse, GroupMember, GroupMemberTag } from '../../types';

function tagTheme(tag: GroupMemberTag): string {
  const r = String(tag.role || '').trim().toLowerCase();
  if (r === 'robot') return 'bg-slate-500/10 text-slate-700 border-slate-300/40 dark:bg-slate-500/15 dark:text-slate-200 dark:border-slate-400/30';
  if (r === 'pm') return 'bg-emerald-500/10 text-emerald-700 border-emerald-300/40 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-400/30';
  if (r === 'dev') return 'bg-sky-500/10 text-sky-700 border-sky-300/40 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-400/30';
  if (r === 'qa') return 'bg-violet-500/10 text-violet-700 border-violet-300/40 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-400/30';
  if (r === 'admin') return 'bg-amber-500/10 text-amber-700 border-amber-300/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-400/30';
  return 'bg-black/5 text-text-secondary border-black/10 dark:bg-white/8 dark:text-white/70 dark:border-white/15';
}

function initials(name: string): string {
  const t = String(name || '').trim();
  if (!t) return '?';
  return t.slice(0, 1).toUpperCase();
}

export default function GroupInfoDrawer() {
  const isOpen = useGroupInfoDrawerStore((s) => s.isOpen);
  const groupId = useGroupInfoDrawerStore((s) => s.groupId);
  const drawerWidth = useGroupInfoDrawerStore((s) => s.drawerWidth);
  const setDrawerWidth = useGroupInfoDrawerStore((s) => s.setDrawerWidth);
  const close = useGroupInfoDrawerStore((s) => s.close);

  const groups = useGroupListStore((s) => s.groups);
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);

  const group = useMemo(() => {
    const gid = String(groupId || '').trim();
    return groups.find((g) => g.groupId === gid) ?? null;
  }, [groups, groupId]);

  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const isOwnerOrAdmin = useMemo(() => {
    if (!currentUserId) return false;
    const me = members.find((m) => m.userId === currentUserId);
    return Boolean(me?.isOwner);
  }, [members, currentUserId]);

  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    active: boolean;
    prevUserSelect: string;
    prevCursor: string;
  } | null>(null);

  useEffect(() => {
    if (!isOpen || !groupId) return;
    setError('');
    setLoading(true);
    invoke<ApiResponse<GroupMember[]>>('get_group_members', { groupId })
      .then((resp) => {
        if (!resp?.success || !Array.isArray(resp.data)) {
          setMembers([]);
          setError(resp?.error?.message || '加载群成员失败');
          return;
        }
        setMembers(resp.data);
      })
      .catch(() => {
        setMembers([]);
        setError('加载群成员失败');
      })
      .finally(() => setLoading(false));
  }, [isOpen, groupId]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const st = dragRef.current;
      if (!st?.active) return;
      const delta = st.startX - e.clientX;
      const next = st.startWidth + delta;
      setDrawerWidth(next);
    };
    const onUp = () => {
      const st = dragRef.current;
      if (!st?.active) return;
      st.active = false;
      document.body.style.userSelect = st.prevUserSelect;
      document.body.style.cursor = st.prevCursor;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [setDrawerWidth]);

  if (!isOpen) return null;

  const gid = String(groupId || '').trim();
  const inviteLink = group?.inviteCode ? `prdagent://join/${group.inviteCode}` : '';

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div className="absolute inset-0 pointer-events-auto" onClick={close} />

      <div
        className="absolute right-0 top-0 h-full max-w-[92vw] bg-surface-light dark:bg-surface-dark border-l border-border shadow-2xl pointer-events-auto flex flex-col"
        style={{ width: `${drawerWidth}px` }}
      >
        <div
          className="absolute left-0 top-0 h-full w-2 cursor-col-resize"
          role="separator"
          aria-label="调整群信息面板宽度"
          title="拖动调整宽度"
          onPointerDown={(e) => {
            try {
              (e.currentTarget as any)?.setPointerCapture?.(e.pointerId);
            } catch {
              // ignore
            }
            const prevUserSelect = document.body.style.userSelect;
            const prevCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
            dragRef.current = {
              startX: e.clientX,
              startWidth: drawerWidth,
              active: true,
              prevUserSelect,
              prevCursor,
            };
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border opacity-50 hover:opacity-90" />
        </div>

        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary truncate">
              {group?.groupName || '群信息'}
            </div>
            <div className="text-xs text-text-secondary truncate">
              {gid ? `群ID：${gid}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5"
            title="关闭"
            aria-label="关闭"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 群聊成员 */}
          <div className="ui-glass-panel p-4 rounded-xl">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-text-primary">群聊成员</div>
              <div className="text-xs text-text-secondary">
                {group?.memberCount != null ? `共 ${group.memberCount} 人` : ''}
              </div>
            </div>

            {loading ? (
              <div className="mt-3 text-sm text-text-secondary">加载中...</div>
            ) : error ? (
              <div className="mt-3 text-sm text-red-700 dark:text-red-200">{error}</div>
            ) : (
              <div className="mt-3 grid grid-cols-4 gap-3">
                {members.slice(0, 16).map((m) => (
                  <div key={m.userId} className="min-w-0">
                    <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center text-sm font-semibold text-white bg-gradient-to-br from-primary-500/70 to-sky-500/60 border border-white/10">
                      {initials(m.displayName || m.username)}
                    </div>
                    <div className="mt-2 text-xs text-text-secondary text-center truncate" title={m.displayName || m.username}>
                      {m.displayName || m.username}
                    </div>
                    <div className="mt-1 flex flex-wrap justify-center gap-1">
                      {(m.tags || []).slice(0, 2).map((t, idx) => (
                        <span key={`${m.userId}-t-${idx}`} className={`text-[10px] leading-4 px-1.5 rounded-full border ${tagTheme(t)}`}>
                          {t.name}
                        </span>
                      ))}
                      {m.isOwner ? (
                        <span className="text-[10px] leading-4 px-1.5 rounded-full border bg-amber-500/10 text-amber-700 border-amber-300/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-400/30">
                          群主
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 资料管理（最少动作：复制邀请链接；其余动作复用现有侧栏逻辑） */}
          <div className="ui-glass-panel p-4 rounded-xl space-y-3">
            <div className="text-sm font-semibold text-text-primary">资料管理</div>

            <button
              type="button"
              className="w-full px-4 py-3 ui-control text-left text-sm text-text-primary hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              onClick={async () => {
                if (!inviteLink) return;
                try {
                  await navigator.clipboard.writeText(inviteLink);
                  alert('邀请链接已复制');
                } catch {
                  alert(inviteLink);
                }
              }}
              disabled={!inviteLink}
              title={inviteLink ? '复制邀请链接' : '无邀请码'}
            >
              复制邀请链接
              <div className="mt-1 text-xs text-text-secondary truncate">{inviteLink || '无'}</div>
            </button>

            <button
              type="button"
              className="w-full px-4 py-3 ui-control text-left text-sm text-text-primary hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              onClick={() => window.dispatchEvent(new Event('prdAgent:openBindPrdPicker'))}
              disabled={!gid || !isOwnerOrAdmin}
              title={isOwnerOrAdmin ? '上传并绑定 PRD（群主/管理员）' : '仅群主/管理员可更换 PRD'}
            >
              群资料设置（绑定/更换 PRD）
              <div className="mt-1 text-xs text-text-secondary">将打开文件选择器</div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


