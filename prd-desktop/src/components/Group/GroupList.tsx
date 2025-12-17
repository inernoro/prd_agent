import { useEffect, useState, type KeyboardEvent } from 'react';
import { invoke } from '../../lib/tauri';
import { ApiResponse, Document, Session, UserRole } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupListStore } from '../../stores/groupListStore';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

export default function GroupList() {
  const { user } = useAuthStore();
  const { groups, loading, loadGroups } = useGroupListStore();
  const { activeGroupId, setActiveGroupId, setSession, setActiveGroupContext, clearSession } = useSessionStore();
  const [dissolveTarget, setDissolveTarget] = useState<null | { groupId: string; groupName: string }>(null);
  const [dissolveBusy, setDissolveBusy] = useState(false);
  const [dissolveError, setDissolveError] = useState('');

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

  const canDissolve = user?.role === 'PM' || user?.role === 'ADMIN';

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
    <div className="py-2 space-y-1">
      {groups.map((group) => (
        <div
          key={group.groupId}
          role="button"
          tabIndex={0}
          onClick={() => void openGroup(group)}
          onKeyDown={(e) => handleRowKeyDown(e, group)}
          className={`group relative w-full px-4 h-14 rounded-xl text-left transition-colors cursor-pointer select-none ${
            activeGroupId === group.groupId
              ? 'bg-primary-50 dark:bg-white/5'
              : 'hover:bg-gray-50 dark:hover:bg-white/5'
          }`}
        >
          {/* 选中态：不使用 border-left 避免内容抖动 */}
          {activeGroupId === group.groupId ? (
            <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-primary-500 rounded-r" />
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`h-9 w-9 shrink-0 rounded-xl flex items-center justify-center text-sm font-semibold ${
                    activeGroupId === group.groupId
                      ? 'bg-primary-500 text-white'
                      : 'bg-primary-500/15 text-primary-500'
                  }`}
                  aria-hidden="true"
                >
                  {getGroupInitial(group.groupName)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold tracking-tight leading-6">
                    {group.groupName}
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-2">
              {canDissolve ? (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className={`h-8 w-8 inline-flex items-center justify-center rounded-lg text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors ${
                        activeGroupId === group.groupId ? 'visible' : 'invisible group-hover:visible group-focus-within:visible'
                      }`}
                      title="群设置"
                      onClick={(e) => e.stopPropagation()}
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
                <div className="h-8 w-8" />
              )}
              <div
                className="px-2 py-1 rounded-full text-[12px] leading-4 border border-border/70 text-text-secondary bg-white/0 dark:bg-white/5"
                title="成员数"
              >
                {group.memberCount}人
              </div>
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
          <div className="relative w-full max-w-md mx-4 bg-slate-800 rounded-2xl shadow-2xl border border-white/10">
            <div className="px-6 py-4 border-b border-white/10">
              <div className="text-lg font-semibold text-white">解散群组</div>
              <div className="mt-1 text-sm text-white/60">
                将永久删除群组与成员关系：<span className="text-white">{dissolveTarget.groupName}</span>
              </div>
            </div>
            <div className="p-6 space-y-3">
              <div className="text-sm text-white/70">
                确认后不可恢复。建议先通知群成员。
              </div>
              {dissolveError ? (
                <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">
                  {dissolveError}
                </div>
              ) : null}
            </div>
            <div className="flex gap-3 px-6 py-4 border-t border-white/10">
              <button
                onClick={() => setDissolveTarget(null)}
                disabled={dissolveBusy}
                className="flex-1 py-2.5 bg-white/10 text-white/80 font-medium rounded-lg hover:bg-white/20 transition-colors disabled:opacity-50"
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
