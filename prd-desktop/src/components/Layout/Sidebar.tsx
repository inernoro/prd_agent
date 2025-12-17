import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupListStore } from '../../stores/groupListStore';
import type { ApiResponse, Document, Session, UserRole } from '../../types';
import GroupList from '../Group/GroupList';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const { setSession, activeGroupId } = useSessionStore();
  const { loadGroups } = useGroupListStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isDemoMode = user?.userId === 'demo-user-001';
  const [joinOpen, setJoinOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [groupNameInput, setGroupNameInput] = useState('');
  const [busy, setBusy] = useState<null | 'join' | 'create' | 'upload'>(null);
  const [inlineError, setInlineError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const canSubmit = useMemo(() => !busy && !isDemoMode, [busy, isDemoMode]);

  const openGroupSession = async (groupId: string) => {
    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    const openResp = await invoke<ApiResponse<{ sessionId: string; groupId: string; documentId: string; currentRole: string }>>(
      'open_group_session',
      { groupId, userRole: role }
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
  };

  const handleJoinGroup = async () => {
    if (isDemoMode) {
      alert('演示模式下不支持群组功能');
      return;
    }
    // Tauri 环境下 window.prompt 可能不弹，改为应用内输入
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
        if (resp.error?.code === 'UNAUTHORIZED') {
          alert('登录已过期或无效，请重新登录');
          logout();
          return;
        }
        setInlineError(resp.error?.message || '加入群组失败');
        return;
      }

      await loadGroups();
      await openGroupSession(resp.data.groupId);
      setJoinOpen(false);
    } catch (err) {
      console.error('Failed to join group:', err);
      setInlineError('加入群组失败');
    } finally {
      setBusy(null);
    }
  };

  const handleCreateGroup = async () => {
    if (isDemoMode) {
      alert('演示模式下不支持群组功能');
      return;
    }
    // Tauri 环境下 window.prompt 可能不弹，改为应用内输入
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    setInlineError('');
    const groupName = groupNameInput.trim() || undefined;
    // 创建群组默认不携带 PRD（PRD 追随群组，通过上传/绑定进入）
    const prdDocumentId = undefined;

    try {
      setBusy('create');
      const resp = await invoke<ApiResponse<{ groupId: string; inviteCode: string }>>('create_group', {
        prdDocumentId: prdDocumentId,
        groupName: groupName,
      });

      if (!resp.success || !resp.data) {
        if (resp.error?.code === 'UNAUTHORIZED') {
          alert('登录已过期或无效，请重新登录');
          logout();
          return;
        }
        setInlineError(resp.error?.message || '创建群组失败');
        return;
      }

      const inviteLink = `prdagent://join/${resp.data.inviteCode}`;
      alert(`群组创建成功\\n邀请码：${resp.data.inviteCode}\\n邀请链接：${inviteLink}`);

      await loadGroups();
      setCreateOpen(false);
    } catch (err) {
      console.error('Failed to create group:', err);
      setInlineError('创建群组失败');
    } finally {
      setBusy(null);
    }
  };

  const uploadAndBindToActiveGroup = useCallback(async (content: string) => {
    if (isDemoMode) {
      alert('演示模式下不支持群组功能');
      return;
    }
    if (!activeGroupId) {
      alert('请先选择一个群组');
      return;
    }

    try {
      setBusy('upload');
      const uploadResp = await invoke<ApiResponse<{ sessionId: string; document: Document }>>('upload_document', {
        content,
      });
      if (!uploadResp.success || !uploadResp.data) {
        if (uploadResp.error?.code === 'UNAUTHORIZED') {
          alert('登录已过期或无效，请重新登录');
          logout();
          return;
        }
        alert(uploadResp.error?.message || '上传 PRD 失败');
        return;
      }

      const bindResp = await invoke<ApiResponse<any>>('bind_group_prd', {
        groupId: activeGroupId,
        prdDocumentId: uploadResp.data.document.id,
      });
      if (!bindResp.success) {
        alert(bindResp.error?.message || '绑定 PRD 失败');
        return;
      }

      await loadGroups();
      await openGroupSession(activeGroupId);
    } catch (err) {
      console.error('Failed to upload/bind PRD:', err);
      alert('上传/绑定 PRD 失败');
    } finally {
      setBusy(null);
    }
  }, [activeGroupId, isDemoMode, loadGroups, logout, openGroupSession]);

  const openBindPrdPicker = useCallback(() => {
    if (isDemoMode) {
      alert('演示模式下不支持群组功能');
      return;
    }
    if (!activeGroupId) {
      alert('请先选择一个群组');
      return;
    }
    fileInputRef.current?.click();
  }, [activeGroupId, isDemoMode]);

  const handleFileSelectForBind = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    // 注意：在部分 WebView 中，提前清空 value 会让 files 变空（“选了文件但无反应”）
    const file = input.files?.[0] ?? null;
    // 允许下次选择同名文件也触发 change
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.md')) {
      alert('仅支持 .md 格式文件');
      return;
    }
    try {
      const content = await file.text();
      await uploadAndBindToActiveGroup(content);
    } catch (err) {
      console.error('Failed to read selected file:', err);
      alert('读取文件失败，请重试');
    }
  }, [uploadAndBindToActiveGroup]);

  useEffect(() => {
    const handler = () => openBindPrdPicker();
    window.addEventListener('prdAgent:openBindPrdPicker', handler as EventListener);
    return () => window.removeEventListener('prdAgent:openBindPrdPicker', handler as EventListener);
  }, [openBindPrdPicker]);

  return (
    <aside className={`${isCollapsed ? 'w-14' : 'w-56'} flex-shrink-0 border-r border-border bg-surface-light dark:bg-surface-dark transition-all duration-200`}>
      <div className="h-full flex flex-col">
        {/* 头部：群组标题 + 操作按钮 */}
        <div className="p-3 border-b border-border flex items-center justify-between">
          {!isCollapsed && (
            <>
              <h2 className="text-sm font-medium text-text-secondary">群组</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCollapsed(true)}
                  title="折叠侧边栏"
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30"
                  style={{ outline: 'none' }}
                  onFocus={(e) => {
                    // 强制清除 WebView 默认焦点 outline（该环境下仅靠 class 不稳定）
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
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-gray-50 dark:hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30"
                      style={{ outline: 'none' }}
                      onFocus={(e) => {
                        // 强制清除 WebView 默认焦点 outline（该环境下仅靠 class 不稳定）
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
                      className="z-50 min-w-[140px] rounded-md border border-border bg-surface-light dark:bg-surface-dark shadow-lg p-1"
                    >
                      <DropdownMenu.Item
                        className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 outline-none"
                        onSelect={handleCreateGroup}
                      >
                        创建群组
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 outline-none"
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
              className="mx-auto p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
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
          <div className="flex-1 overflow-y-auto">
            <GroupList />
          </div>
        )}

            {/* 加入群组弹层 */}
            {joinOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => (busy ? null : setJoinOpen(false))} />
                <div className="relative w-full max-w-md mx-4 bg-slate-800 rounded-2xl shadow-2xl border border-white/10">
                  <div className="px-6 py-4 border-b border-white/10">
                    <div className="text-lg font-semibold text-white">加入群组</div>
                    <div className="mt-1 text-sm text-white/60">输入邀请码或邀请链接</div>
                  </div>
                  <div className="p-6 space-y-3">
                    <input
                      value={joinInput}
                      onChange={(e) => setJoinInput(e.target.value)}
                      placeholder="INV-XXXX 或 prdagent://join/INV-XXXX"
                      className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:border-cyan-400 transition-colors"
                      disabled={!canSubmit}
                      autoFocus
                    />
                    {inlineError ? (
                      <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">
                        {inlineError}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex gap-3 px-6 py-4 border-t border-white/10">
                    <button
                      onClick={() => setJoinOpen(false)}
                      disabled={!!busy}
                      className="flex-1 py-2.5 bg-white/10 text-white/80 font-medium rounded-lg hover:bg-white/20 transition-colors disabled:opacity-50"
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
              </div>
            )}

            {/* 创建群组弹层 */}
            {createOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => (busy ? null : setCreateOpen(false))} />
                <div className="relative w-full max-w-md mx-4 bg-slate-800 rounded-2xl shadow-2xl border border-white/10">
                  <div className="px-6 py-4 border-b border-white/10">
                    <div className="text-lg font-semibold text-white">创建群组</div>
                    <div className="mt-1 text-sm text-white/60">群组是容器；PRD 稍后上传/绑定到群组</div>
                  </div>
                  <div className="p-6 space-y-3">
                    <input
                      value={groupNameInput}
                      onChange={(e) => setGroupNameInput(e.target.value)}
                      placeholder="未命名群组（可选）"
                      className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:border-cyan-400 transition-colors"
                      disabled={!canSubmit}
                      autoFocus
                    />
                    {inlineError ? (
                      <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">
                        {inlineError}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex gap-3 px-6 py-4 border-t border-white/10">
                    <button
                      onClick={() => setCreateOpen(false)}
                      disabled={!!busy}
                      className="flex-1 py-2.5 bg-white/10 text-white/80 font-medium rounded-lg hover:bg-white/20 transition-colors disabled:opacity-50"
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
              </div>
            )}

        {/* 即使侧边栏收起，也要能弹出文件选择（用于顶部"待上传"等触发） */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".md"
          className="hidden"
          onChange={handleFileSelectForBind}
        />
      </div>
    </aside>
  );
}
