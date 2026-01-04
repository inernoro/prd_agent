import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { invoke } from '../../lib/tauri';
import { ApiResponse, Document, Session, UserRole } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useMessageStore } from '../../stores/messageStore';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

type GroupMemberInfo = {
  userId: string;
  username: string;
  displayName: string;
  memberRole: string;
  joinedAt: string;
  isOwner: boolean;
};

export default function GroupList() {
  const { user } = useAuthStore();
  const { groups, loading, loadGroups } = useGroupListStore();
  const { activeGroupId, setActiveGroupId, setSession, setActiveGroupContext, clearSession } = useSessionStore();
  const syncFromServer = useMessageStore((s) => s.syncFromServer);
  const triggerScrollToBottom = useMessageStore((s) => s.triggerScrollToBottom);
  const [dissolveTarget, setDissolveTarget] = useState<null | { groupId: string; groupName: string }>(null);
  const [dissolveBusy, setDissolveBusy] = useState(false);
  const [dissolveError, setDissolveError] = useState('');
  const [ownerMap, setOwnerMap] = useState<Record<string, boolean>>({});
  const [ownerLoadingMap, setOwnerLoadingMap] = useState<Record<string, boolean>>({});

  const getGroupInitial = (name: string) => {
    const t = (name || '').trim();
    if (!t) return 'G';
    return t.slice(0, 1).toUpperCase();
  };

  useEffect(() => {
    // 演示模式下不请求后端
    if (user?.userId === 'demo-user-001') return;
    loadGroups();
  }, [loadGroups, user?.userId]);

  useEffect(() => {
    // 有群组时默认选中第一个群组
    if (user?.userId === 'demo-user-001') return;
    if (!activeGroupId && groups.length > 0) {
      void openGroup(groups[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, activeGroupId, user?.userId]);

  const openGroup = async (group: (typeof groups)[number]) => {
    if (user?.userId === 'demo-user-001') return;

    // 关键体验：点击群组 = 拉一次最新消息 + 跳到最新
    // - 即使点击的是“当前群组”，也执行一次（用户期望刷新）
    // - syncFromServer 内部有 isSyncing 保护，重复触发开销很低
    try {
      await syncFromServer({ groupId: group.groupId, limit: 100 });
    } catch {
      // ignore（断连/权限由全局处理）
    } finally {
      triggerScrollToBottom();
    }

    // 切换群组必须先清空旧 session/document，避免串信息
    setActiveGroupContext(group.groupId);

    // 未绑定 PRD 的群组允许存在，但无法进入会话
    if (!group.prdDocumentId) {
      return;
    }

    // 默认用登录用户角色打开群组会话（DEV/QA/PM）；管理员按 PM 处理
    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    try {
      const openResp = await invoke<ApiResponse<{ sessionId: string; groupId: string; documentId: string; currentRole: string }>>(
        'open_group_session',
        { groupId: group.groupId, userRole: role }
      );

      if (!openResp.success || !openResp.data) return;

      const docResp = await invoke<ApiResponse<Document>>('get_document', {
        documentId: openResp.data.documentId,
      });

      if (!docResp.success || !docResp.data) return;

      const session: Session = {
        sessionId: openResp.data.sessionId,
        groupId: openResp.data.groupId,
        documentId: openResp.data.documentId,
        currentRole: (openResp.data.currentRole as UserRole) || role,
        mode: 'QA',
      };

      setSession(session, docResp.data);
      // 同步选中态（防止 setSession 的 groupId 为空时覆盖）
      setActiveGroupId(group.groupId);
    } catch (err) {
      console.error('Failed to open group session:', err);
    }
  };

  const isAdmin = user?.role === 'ADMIN';

  const ensureOwnerLoaded = async (groupId: string) => {
    if (!groupId) return;
    if (isAdmin) return;
    if (ownerMap[groupId] != null) return;
    if (ownerLoadingMap[groupId]) return;
    if (!user?.userId) return;
    if (user.userId === 'demo-user-001') return;
    try {
      setOwnerLoadingMap((prev) => ({ ...prev, [groupId]: true }));
      const resp = await invoke<ApiResponse<GroupMemberInfo[]>>('get_group_members', { groupId });
      if (!resp.success || !resp.data) {
        // 权限不足/请求失败时：视为非群主，避免误展示
        setOwnerMap((prev) => ({ ...prev, [groupId]: false }));
        return;
      }
      const isOwner = resp.data.some((m) => m.userId === user.userId && m.isOwner);
      setOwnerMap((prev) => ({ ...prev, [groupId]: isOwner }));
    } catch {
      setOwnerMap((prev) => ({ ...prev, [groupId]: false }));
    } finally {
      setOwnerLoadingMap((prev) => ({ ...prev, [groupId]: false }));
    }
  };

  const canDissolveGroup = useMemo(() => {
    return (groupId: string) => {
      if (isAdmin) return true;
      if (!groupId) return false;
      return ownerMap[groupId] === true;
    };
  }, [isAdmin, ownerMap]);

  const confirmDissolve = async () => {
    if (!dissolveTarget || dissolveBusy) return;
    if (user?.userId === 'demo-user-001') return;

    setDissolveError('');
    try {
      setDissolveBusy(true);
      const resp = await invoke<ApiResponse<any>>('dissolve_group', { groupId: dissolveTarget.groupId });
      if (!resp.success) {
        if (resp.error?.code === 'UNAUTHORIZED') {
          useAuthStore.getState().logout();
          setDissolveTarget(null);
          return;
        }
        setDissolveError(resp.error?.message || '解散群组失败');
        return;
      }

      // 如果解散的是当前群：清空上下文，避免残留会话
      if (activeGroupId === dissolveTarget.groupId) {
        clearSession();
      }
      await loadGroups();
      setDissolveTarget(null);
    } catch (err) {
      console.error('Failed to dissolve group:', err);
      setDissolveError('解散群组失败');
    } finally {
      setDissolveBusy(false);
    }
  };

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, group: (typeof groups)[number]) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    void openGroup(group);
  };

  if (loading) {
    return (
      <div className="p-4 text-center text-text-secondary text-sm">
        加载中...
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="p-4 text-center text-text-secondary text-sm">
        {user?.userId === 'demo-user-001' ? '演示模式下不支持群组功能' : '暂无群组'}
      </div>
    );
  }

  return (
    // 与 Sidebar 顶部标题区 p-4 对齐：列表行自身使用 px-4，这里不再额外加横向 padding
    <div className="py-2 px-2 space-y-1">
      {groups.map((group) => (
        <div
          key={group.groupId}
          role="button"
          tabIndex={0}
          onClick={() => void openGroup(group)}
          onFocus={(e) => {
            // 强制清除 WebView 默认焦点 outline（该环境下仅靠 class 不稳定）
            (e.currentTarget as HTMLDivElement).style.outline = 'none';
          }}
          onKeyDown={(e) => handleRowKeyDown(e, group)}
          className={`group relative w-full px-3 h-12 rounded-lg text-left transition-colors cursor-pointer select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25 focus-visible:ring-inset ${
            activeGroupId === group.groupId
              ? 'bg-primary-500/8 dark:bg-white/6'
              : 'hover:bg-black/4 dark:hover:bg-white/5'
          }`}
          style={{ outline: 'none' }}
        >
          {/* 选中态：不使用 border-left 避免内容抖动 */}
          {activeGroupId === group.groupId ? (
            <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-primary-500 rounded-r" />
          ) : null}

          <div className="flex h-full items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-sm font-semibold ${
                    activeGroupId === group.groupId
                      ? 'bg-primary-500 text-white'
                      : 'bg-primary-500/10 text-primary-600'
                  }`}
                  aria-hidden="true"
                >
                  {getGroupInitial(group.groupName)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium leading-5">
                    {group.groupName}
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-2">
              {canDissolveGroup(group.groupId) ? (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className={`h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${
                        activeGroupId === group.groupId ? 'visible' : 'invisible group-hover:visible group-focus-within:visible'
                      }`}
                      title="群设置"
                      onClick={(e) => e.stopPropagation()}
                      onMouseEnter={() => void ensureOwnerLoaded(group.groupId)}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                        />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      sideOffset={8}
                      align="end"
                      className="z-50 min-w-[160px] rounded-md border border-border bg-surface-light dark:bg-surface-dark shadow-lg p-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenu.Item
                        className="px-2 py-2 text-sm rounded cursor-pointer text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 outline-none"
                        onSelect={() => setDissolveTarget({ groupId: group.groupId, groupName: group.groupName })}
                      >
                        解散该群
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              ) : (
                <div className="h-7 w-7" />
              )}
            </div>
          </div>
        </div>
      ))}

      {/* 解散群确认弹层 */}
      {dissolveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => (dissolveBusy ? null : setDissolveTarget(null))}
          />
          <div className="relative w-full max-w-md mx-4 ui-glass-modal">
            <div className="px-6 py-4 border-b border-black/10 dark:border-white/10 ui-glass-bar">
              <div className="text-lg font-semibold text-text-primary">解散群组</div>
              <div className="mt-1 text-sm text-text-secondary">
                将永久删除群组与成员关系：<span className="text-text-primary">{dissolveTarget.groupName}</span>
              </div>
            </div>
            <div className="p-6 space-y-3">
              <div className="text-sm text-text-secondary">
                确认后不可恢复。建议先通知群成员。
              </div>
              {dissolveError ? (
                <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
                  {dissolveError}
                </div>
              ) : null}
            </div>
            <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10 ui-glass-bar">
              <button
                onClick={() => setDissolveTarget(null)}
                disabled={dissolveBusy}
                className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={confirmDissolve}
                disabled={dissolveBusy}
                className="flex-1 py-2.5 bg-red-600 text-white font-medium rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {dissolveBusy ? '解散中...' : '确认解散'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
