import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/tauri';
import { useGroupInfoDrawerStore } from '../../stores/groupInfoDrawerStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { AvatarWithFallback } from '../Chat/AvatarWithFallback';
import type { ApiResponse, GroupMember, GroupMemberTag, UserRole } from '../../types';

function parseJoinedAtMs(value: unknown): number {
  const t = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function tagTheme(tag: GroupMemberTag): string {
  const r = String(tag.role || '').trim().toLowerCase();
  // 机器人：使用“实心填充”铭牌（绿色底 + 白字），让“机器人”显性标识
  if (r === 'robot') return 'bg-green-600 text-white border-green-700/40 dark:bg-green-500 dark:text-white dark:border-green-300/30 font-semibold';
  if (r === 'pm') return 'bg-emerald-500/10 text-emerald-700 border-emerald-300/40 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-400/30';
  if (r === 'dev') return 'bg-sky-500/10 text-sky-700 border-sky-300/40 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-400/30';
  if (r === 'qa') return 'bg-violet-500/10 text-violet-700 border-violet-300/40 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-400/30';
  if (r === 'admin') return 'bg-amber-500/10 text-amber-700 border-amber-300/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-400/30';
  return 'bg-black/5 text-text-secondary border-black/10 dark:bg-white/8 dark:text-white/70 dark:border-white/15';
}

function tagIcon(kindRaw: string) {
  const kind = String(kindRaw || '').trim().toLowerCase();
  const base = 'w-3 h-3 shrink-0';
  if (kind === 'robot') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m-6 7a6 6 0 0112 0v5a3 3 0 01-3 3H9a3 3 0 01-3-3v-5z" />
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M8 13h.01M16 13h.01" />
      </svg>
    );
  }
  if (kind === 'pm') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 21l-7-4V7l7-4 7 4v10l-7 4z" />
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 11v10" />
      </svg>
    );
  }
  if (kind === 'dev') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
      </svg>
    );
  }
  if (kind === 'qa') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M7 4h10a2 2 0 012 2v14l-3-2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
      </svg>
    );
  }
  if (kind === 'admin') {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 2l7 4v6c0 5-3 9-7 10-4-1-7-5-7-10V6l7-4z" />
      </svg>
    );
  }
  return null;
}

function ownerIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M4 8l4 4 4-6 4 6 4-4v10H4V8z" />
    </svg>
  );
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

  const sortedMembers = useMemo(() => {
    const list = Array.isArray(members) ? [...members] : [];
    list.sort((a, b) => {
      // 1) 群主永远第一个
      const ao = a?.isOwner ? 1 : 0;
      const bo = b?.isOwner ? 1 : 0;
      if (ao !== bo) return bo - ao;

      // 2) 其余按加入时间正序（老的在前，避免“创建顺序颠倒”）
      const at = parseJoinedAtMs(a?.joinedAt);
      const bt = parseJoinedAtMs(b?.joinedAt);
      if (at !== bt) return at - bt;

      // 3) 兜底稳定排序
      const an = String(a?.displayName || a?.username || '').trim();
      const bn = String(b?.displayName || b?.username || '').trim();
      if (an !== bn) return an.localeCompare(bn, 'zh-Hans-CN');
      return String(a?.userId || '').localeCompare(String(b?.userId || ''));
    });
    return list;
  }, [members]);

  const isOwnerOrAdmin = useMemo(() => {
    if (!currentUserId) return false;
    const me = members.find((m) => m.userId === currentUserId);
    return Boolean(me?.isOwner);
  }, [members, currentUserId]);

  const isOwner = useMemo(() => {
    if (!currentUserId) return false;
    const me = members.find((m) => m.userId === currentUserId);
    return Boolean(me?.isOwner);
  }, [members, currentUserId]);

  // Add member dialog state
  const [showAddMember, setShowAddMember] = useState(false);
  const [addUsername, setAddUsername] = useState('');
  const [addRole, setAddRole] = useState<UserRole>('DEV');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');

  // Leave group state
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState('');

  const loadGroups = useGroupListStore((s) => s.loadGroups);
  const clearSession = useSessionStore((s) => s.clearSession);

  const handleAddMember = async () => {
    if (!groupId || !addUsername.trim() || addBusy) return;
    setAddError('');
    setAddBusy(true);
    try {
      const resp = await invoke<ApiResponse<GroupMember>>('add_group_member', {
        groupId,
        username: addUsername.trim(),
        memberRole: addRole,
      });
      if (!resp.success) {
        setAddError(resp.error?.message || '添加成员失败');
        return;
      }
      // Refresh members
      setAddUsername('');
      setShowAddMember(false);
      // Reload members
      const membersResp = await invoke<ApiResponse<GroupMember[]>>('get_group_members', { groupId });
      if (membersResp?.success && Array.isArray(membersResp.data)) {
        setMembers(membersResp.data);
      }
      await loadGroups({ force: true, silent: true });
    } catch {
      setAddError('添加成员失败');
    } finally {
      setAddBusy(false);
    }
  };

  const handleLeaveGroup = async () => {
    if (!groupId || leaveBusy) return;
    setLeaveError('');
    setLeaveBusy(true);
    try {
      const resp = await invoke<ApiResponse<any>>('leave_group', { groupId });
      if (!resp.success) {
        setLeaveError(resp.error?.message || '退出群组失败');
        return;
      }
      setShowLeaveConfirm(false);
      close();
      try { clearSession(); } catch { /* ignore */ }
      await loadGroups({ force: true, silent: true });
    } catch {
      setLeaveError('退出群组失败');
    } finally {
      setLeaveBusy(false);
    }
  };

  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    active: boolean;
    prevUserSelect: string;
    prevCursor: string;
  } | null>(null);

  useEffect(() => {
    if (!isOpen || !groupId) return;
    // 检查群组是否存在（避免为已解散的群组查询成员）
    const groupExists = groups.some((g) => String(g.groupId) === groupId);
    if (!groupExists) {
      setMembers([]);
      setError('群组不存在或已解散');
      return;
    }
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
  }, [isOpen, groupId, groups]);

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
                {sortedMembers.slice(0, 15).map((m) => (
                  <div key={m.userId} className="min-w-0">
                    <div className="mx-auto w-12">
                      <AvatarWithFallback
                        avatarUrl={m.avatarUrl}
                        displayName={m.displayName || m.username}
                        size="lg"
                      />
                    </div>
                    <div className="mt-2 text-xs text-text-secondary text-center truncate" title={m.displayName || m.username}>
                      {m.displayName || m.username}
                    </div>
                    <div className="mt-1 flex flex-wrap justify-center gap-1">
                      {(m.tags || []).slice(0, 2).map((t, idx) => (
                        <span
                          key={`${m.userId}-t-${idx}`}
                          className={`inline-flex items-center gap-1 text-[10px] leading-4 px-1.5 rounded-full border ${tagTheme(t)}`}
                          title={t.name}
                        >
                          {tagIcon(t.role)}
                          <span className="truncate max-w-[64px]">{t.name}</span>
                        </span>
                      ))}
                      {m.isOwner ? (
                        <span className="inline-flex items-center gap-1 text-[10px] leading-4 px-1.5 rounded-full border bg-amber-500/10 text-amber-700 border-amber-300/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-400/30">
                          {ownerIcon()}
                          群主
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
                {/* 添加成员按钮 */}
                {isOwnerOrAdmin ? (
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => { setAddError(''); setShowAddMember(true); }}
                      className="mx-auto w-12 h-12 rounded-full border-2 border-dashed border-border hover:border-primary-500 flex items-center justify-center text-text-secondary hover:text-primary-500 transition-colors"
                      title="添加成员"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                    <div className="mt-2 text-xs text-text-secondary text-center">邀请</div>
                  </div>
                ) : null}
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

            {/* 退出群组（非群主可见） */}
            {!isOwner ? (
              <button
                type="button"
                className="w-full px-4 py-3 ui-control text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                onClick={() => { setLeaveError(''); setShowLeaveConfirm(true); }}
              >
                退出群组
                <div className="mt-1 text-xs text-text-secondary">退出后将无法查看群消息</div>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* 添加成员弹窗 */}
      {showAddMember && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[1000] flex items-center justify-center">
              <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !addBusy && setShowAddMember(false)} />
              <div className="relative w-full max-w-sm mx-4 ui-glass-modal">
                <div className="px-6 py-4 border-b border-black/10 dark:border-white/10 ui-glass-bar">
                  <div className="text-lg font-semibold text-text-primary">添加群成员</div>
                  <div className="mt-1 text-sm text-text-secondary">输入用户名邀请加入群组</div>
                </div>
                <div className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">用户名</label>
                    <input
                      type="text"
                      value={addUsername}
                      onChange={(e) => setAddUsername(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleAddMember(); }}
                      placeholder="请输入要添加的用户名"
                      className="w-full px-3 py-2 rounded-lg border border-border bg-surface-light dark:bg-surface-dark text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/30"
                      autoFocus
                      disabled={addBusy}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">角色</label>
                    <select
                      value={addRole}
                      onChange={(e) => setAddRole(e.target.value as UserRole)}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-surface-light dark:bg-surface-dark text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/30"
                      disabled={addBusy}
                    >
                      <option value="PM">产品经理</option>
                      <option value="DEV">开发</option>
                      <option value="QA">测试</option>
                    </select>
                  </div>
                  {addError ? (
                    <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
                      {addError}
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10 ui-glass-bar">
                  <button
                    onClick={() => setShowAddMember(false)}
                    disabled={addBusy}
                    className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void handleAddMember()}
                    disabled={addBusy || !addUsername.trim()}
                    className="flex-1 py-2.5 bg-primary-500 text-white font-medium rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50"
                  >
                    {addBusy ? '添加中...' : '确认添加'}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {/* 退出群组确认弹窗 */}
      {showLeaveConfirm && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[1000] flex items-center justify-center">
              <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !leaveBusy && setShowLeaveConfirm(false)} />
              <div className="relative w-full max-w-md mx-4 ui-glass-modal">
                <div className="px-6 py-4 border-b border-black/10 dark:border-white/10 ui-glass-bar">
                  <div className="text-lg font-semibold text-text-primary">退出群组</div>
                  <div className="mt-1 text-sm text-text-secondary">
                    确定要退出 <span className="text-text-primary">{group?.groupName}</span> 吗？
                  </div>
                </div>
                <div className="p-6 space-y-3">
                  <div className="text-sm text-text-secondary">退出后将无法查看群消息，需要重新被邀请才能加入。</div>
                  {leaveError ? (
                    <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
                      {leaveError}
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10 ui-glass-bar">
                  <button
                    onClick={() => setShowLeaveConfirm(false)}
                    disabled={leaveBusy}
                    className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void handleLeaveGroup()}
                    disabled={leaveBusy}
                    className="flex-1 py-2.5 bg-red-600 text-white font-medium rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {leaveBusy ? '退出中...' : '确认退出'}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}


