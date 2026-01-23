import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/tauri';
import { isSystemErrorCode } from '../../lib/systemError';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useKbStore } from '../../stores/kbStore';
import type { ApiResponse, Session, UserRole } from '../../types';
import GroupList from '../Group/GroupList';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const { setSession, activeGroupId, mode, sessionId, setMode } = useSessionStore();
  const { loadGroups } = useGroupListStore();
  const { documents } = useKbStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [groupNameInput, setGroupNameInput] = useState('');
  const [busy, setBusy] = useState<null | 'join' | 'create'>(null);
  const [inlineError, setInlineError] = useState<string>('');

  const COLLAPSED_WIDTH = 56;
  const DEFAULT_EXPANDED_WIDTH = 224;
  const MIN_EXPANDED_WIDTH = 180;
  const MAX_EXPANDED_WIDTH = 420;
  const SIDEBAR_WIDTH_KEY = 'prdAgent.sidebarWidth';

  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

  const [expandedWidth, setExpandedWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n)) return clamp(n, MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH);
    } catch {
      // ignore
    }
    return DEFAULT_EXPANDED_WIDTH;
  });

  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startX: number; startW: number } | null>(null);
  const currentWidth = isCollapsed ? COLLAPSED_WIDTH : expandedWidth;

  useEffect(() => {
    if (createOpen) {
      setGroupNameInput('');
      setInlineError('');
    }
  }, [createOpen]);

  useEffect(() => {
    if (joinOpen) {
      setJoinInput('');
      setInlineError('');
    }
  }, [joinOpen]);

  useEffect(() => {
    if (isCollapsed) return;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(expandedWidth));
    } catch {
      // ignore
    }
  }, [expandedWidth, isCollapsed]);

  const canSubmit = useMemo(() => !busy, [busy]);

  const openKnowledge = useCallback(async () => {
    setMode('Knowledge');
    void sessionId;
  }, [mode, sessionId, setMode]);

  const openGroupSession = async (groupId: string) => {
    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    const openResp = await invoke<ApiResponse<{ sessionId: string; groupId: string; kbDocumentCount: number; currentRole: string }>>(
      'open_group_session',
      { groupId, userRole: role }
    );
    if (!openResp.success || !openResp.data) return;

    const session: Session = {
      sessionId: openResp.data.sessionId,
      groupId: openResp.data.groupId,
      kbDocumentCount: openResp.data.kbDocumentCount,
      currentRole: (openResp.data.currentRole as UserRole) || role,
      mode: 'QA',
    };

    setSession(session);
  };

  const handleJoinGroup = async () => {
    setJoinOpen(true);
  };

  const submitJoin = async () => {
    setInlineError('');
    const trimmed = joinInput.trim();
    const code = trimmed.includes('prdagent://join/')
      ? trimmed.split('prdagent://join/')[1]?.split(/[?#/\\s]/)[0]
      : trimmed.split(/[?#/\\s]/)[0];
    if (!code) {
      setInlineError('请输入有效的邀请码或邀请链接');
      return;
    }

    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    try {
      setBusy('join');
      const resp = await invoke<ApiResponse<{ groupId: string }>>('join_group', {
        inviteCode: code,
        userRole: role,
      });

      if (!resp.success || !resp.data) {
        const errorCode = resp.error?.code ?? null;
        if (errorCode === 'UNAUTHORIZED') {
          logout();
          return;
        }
        if (!isSystemErrorCode(errorCode)) {
          setInlineError(resp.error?.message || '加入群组失败');
        }
        return;
      }

      await loadGroups({ force: true });
      await openGroupSession(resp.data.groupId);
      setJoinOpen(false);
    } catch (err) {
      console.error('Failed to join group:', err);
    } finally {
      setBusy(null);
    }
  };

  const handleCreateGroup = async () => {
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    setInlineError('');
    const explicitGroupName = groupNameInput.trim();

    try {
      setBusy('create');

      const resp = await invoke<ApiResponse<{ groupId: string; inviteCode: string }>>('create_group', {
        groupName: explicitGroupName || undefined,
      });

      if (!resp.success || !resp.data) {
        const errorCode = resp.error?.code ?? null;
        if (errorCode === 'UNAUTHORIZED') {
          logout();
          return;
        }
        if (!isSystemErrorCode(errorCode)) {
          setInlineError(resp.error?.message || '创建群组失败');
        }
        return;
      }

      await loadGroups({ force: true });
      await openGroupSession(resp.data.groupId);
      setCreateOpen(false);

      // 启动短期轮询以获取后台生成的群名
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await loadGroups({ force: true });
      }
    } catch (err) {
      console.error('Failed to create group:', err);
    } finally {
      setBusy(null);
    }
  };

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isCollapsed) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStateRef.current = { startX: e.clientX, startW: expandedWidth };

    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    try {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } catch {
      // ignore
    }
  }, [expandedWidth, isCollapsed]);

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing || isCollapsed) return;
    const s = resizeStateRef.current;
    if (!s) return;
    const delta = e.clientX - s.startX;
    setExpandedWidth(clamp(s.startW + delta, MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH));
  }, [isResizing, isCollapsed]);

  const endResize = useCallback(() => {
    if (!isResizing) return;
    setIsResizing(false);
    resizeStateRef.current = null;
    try {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    } catch {
      // ignore
    }
  }, [isResizing]);

  return (
    <aside
      className={`relative flex-shrink-0 border-r ui-glass-bar ${isResizing ? '' : 'transition-[width] duration-150'}`}
      style={{ width: `${currentWidth}px` }}
    >
      <div className="h-full flex flex-col">
        {/* 头部：群组标题 + 操作按钮 */}
        <div className="p-3 border-b border-black/10 dark:border-white/10 flex items-center justify-between">
          {!isCollapsed && (
            <>
              <h2 className="text-sm font-medium text-text-secondary">群组</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCollapsed(true)}
                  title="折叠侧边栏"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
                  style={{ outline: 'none' }}
                  onFocus={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.outline = 'none';
                  }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      title="群组操作"
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
                      style={{ outline: 'none' }}
                      onFocus={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.outline = 'none';
                      }}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      sideOffset={6}
                      align="end"
                      className="z-50 min-w-[140px] rounded-md ui-glass-panel p-1"
                    >
                      <DropdownMenu.Item
                        className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none"
                        onSelect={handleCreateGroup}
                      >
                        创建群组
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none"
                        onSelect={handleJoinGroup}
                      >
                        加入群组
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </>
          )}
          {isCollapsed && (
            <button
              onClick={() => setIsCollapsed(false)}
              className="mx-auto p-1 rounded hover:bg-black/5 dark:hover:bg-white/5"
              title="展开侧边栏"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* 群组列表 */}
        {!isCollapsed && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <GroupList />
          </div>
        )}

        {/* 知识库快速信息 */}
        {!isCollapsed && activeGroupId && (
          <div className="shrink-0 border-t border-black/10 dark:border-white/10">
            <div className="px-3 py-2 flex items-center justify-between">
              <div className="text-xs font-medium text-text-secondary">知识库</div>
              <button
                type="button"
                onClick={openKnowledge}
                className={`h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors ${
                  mode === 'Knowledge'
                    ? 'text-primary-600 dark:text-primary-300 bg-primary-50 dark:bg-white/5'
                    : 'text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5'
                }`}
                title="知识库管理"
                aria-label="知识库管理"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </button>
            </div>
            <div className="px-3 pb-2">
              <div
                role="button"
                tabIndex={0}
                onClick={openKnowledge}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openKnowledge();
                  }
                }}
                className="w-full px-3 py-2 rounded-lg text-left text-sm transition-colors cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary hover:text-primary-500"
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 20h10a2 2 0 002-2V6a2 2 0 00-2-2H9l-2 2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <span>{documents.length > 0 ? `${documents.length} 份文档` : '暂无文档'}</span>
                </div>
              </div>
            </div>
          </div>
        )}

            {/* 加入群组弹层 */}
            {joinOpen &&
              (typeof document !== 'undefined'
                ? createPortal(
                    <div className="fixed inset-0 z-[1000] flex items-center justify-center">
                      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => (busy ? null : setJoinOpen(false))} />
                      <div className="relative w-full max-w-md mx-4 ui-glass-modal">
                        <div className="px-6 py-4 border-b border-black/10 dark:border-white/10">
                          <div className="text-lg font-semibold text-text-primary">加入群组</div>
                          <div className="mt-1 text-sm text-text-secondary">输入邀请码或邀请链接</div>
                        </div>
                        <div className="p-6 space-y-3">
                          <input
                            value={joinInput}
                            onChange={(e) => setJoinInput(e.target.value)}
                            placeholder="INV-XXXX 或 prdagent://join/INV-XXXX"
                            className="w-full px-4 py-3 ui-control transition-colors"
                            disabled={!canSubmit}
                            autoFocus
                          />
                          {inlineError ? (
                            <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
                              {inlineError}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10">
                          <button
                            onClick={() => setJoinOpen(false)}
                            disabled={!!busy}
                            className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                          >
                            取消
                          </button>
                          <button
                            onClick={submitJoin}
                            disabled={!canSubmit}
                            className="flex-1 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                          >
                            {busy === 'join' ? '加入中...' : '加入'}
                          </button>
                        </div>
                      </div>
                    </div>,
                    document.body
                  )
                : null)}

            {/* 创建群组弹层 */}
            {createOpen &&
              (typeof document !== 'undefined'
                ? createPortal(
                    <div className="fixed inset-0 z-[1000] flex items-center justify-center">
                      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => (busy ? null : setCreateOpen(false))} />
                      <div className="relative w-full max-w-md mx-4 ui-glass-modal">
                        <div className="px-6 py-4 border-b border-black/10 dark:border-white/10">
                          <div className="text-lg font-semibold text-text-primary">创建群组</div>
                          <div className="mt-1 text-sm text-text-secondary">创建群组后可在知识库中上传文档</div>
                        </div>
                        <div className="p-6 space-y-3">
                          <input
                            value={groupNameInput}
                            onChange={(e) => setGroupNameInput(e.target.value)}
                            placeholder="群组名称（可选）"
                            className="w-full px-4 py-3 ui-control transition-colors"
                            disabled={!canSubmit}
                            autoFocus
                          />

                          {inlineError ? (
                            <div className="p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
                              {inlineError}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex gap-3 px-6 py-4 border-t border-black/10 dark:border-white/10">
                          <button
                            onClick={() => setCreateOpen(false)}
                            disabled={!!busy}
                            className="flex-1 py-2.5 ui-control text-text-secondary font-medium hover:bg-black/5 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
                          >
                            取消
                          </button>
                          <button
                            onClick={submitCreate}
                            disabled={!canSubmit}
                            className="flex-1 py-2.5 bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                          >
                            {busy === 'create' ? '创建中...' : '创建'}
                          </button>
                        </div>
                      </div>
                    </div>,
                    document.body
                  )
                : null)}
      </div>

      {/* 侧边栏拖拽调整宽度的 handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        className={`absolute top-0 right-0 h-full ${isCollapsed ? 'w-0' : 'w-1'} cursor-col-resize select-none`}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
        style={{
          touchAction: 'none',
        }}
      >
        <div className={`h-full w-full ${isCollapsed ? '' : 'hover:bg-primary-500/10'}`} />
      </div>
    </aside>
  );
}
