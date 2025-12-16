import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupListStore } from '../../stores/groupListStore';
import type { ApiResponse, Document, Session, UserRole } from '../../types';
import GroupList from '../Group/GroupList';

export default function Sidebar() {
  const { user } = useAuthStore();
  const { documentLoaded, document, setSession } = useSessionStore();
  const { loadGroups } = useGroupListStore();
  const [isCollapsed, setIsCollapsed] = useState(false);

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
    const input = window.prompt('请输入邀请码或邀请链接（如 INV-XXXX 或 prdagent://join/INV-XXXX）');
    if (!input) return;

    const trimmed = input.trim();
    const code = trimmed.includes('prdagent://join/')
      ? trimmed.split('prdagent://join/')[1]?.split(/[?#/\\s]/)[0]
      : trimmed.split(/[?#/\\s]/)[0];

    if (!code) return;

    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    try {
      const resp = await invoke<ApiResponse<{ groupId: string }>>('join_group', {
        inviteCode: code,
        userRole: role,
      });

      if (!resp.success || !resp.data) {
        alert(resp.error?.message || '加入群组失败');
        return;
      }

      await loadGroups();
      await openGroupSession(resp.data.groupId);
    } catch (err) {
      console.error('Failed to join group:', err);
      alert('加入群组失败');
    }
  };

  const handleCreateGroup = async () => {
    if (!documentLoaded || !document) {
      alert('请先上传 PRD 文档后再创建群组');
      return;
    }

    const groupName = window.prompt('请输入群组名称（可选）', document.title) || undefined;

    try {
      const resp = await invoke<ApiResponse<{ groupId: string; inviteCode: string }>>('create_group', {
        prdDocumentId: document.id,
        groupName,
      });

      if (!resp.success || !resp.data) {
        alert(resp.error?.message || '创建群组失败');
        return;
      }

      const inviteLink = `prdagent://join/${resp.data.inviteCode}`;
      alert(`群组创建成功\\n邀请码：${resp.data.inviteCode}\\n邀请链接：${inviteLink}`);

      await loadGroups();
      await openGroupSession(resp.data.groupId);
    } catch (err) {
      console.error('Failed to create group:', err);
      alert('创建群组失败');
    }
  };

  return (
    <aside className={`${isCollapsed ? 'w-14' : 'w-64'} border-r border-border bg-surface-light dark:bg-surface-dark transition-all duration-200`}>
      <div className="h-full flex flex-col">
        {!isCollapsed && (
          <>
            <div className="p-4 border-b border-border">
              <h2 className="text-sm font-medium text-text-secondary">群组</h2>
            </div>
            <div className="flex-1 overflow-y-auto">
              <GroupList />
            </div>
            <div className="p-3 border-t border-border space-y-2">
              <button
                onClick={handleJoinGroup}
                className="w-full py-2 text-sm text-text-secondary hover:text-primary-500 flex items-center justify-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                加入群组
              </button>
            </div>
            {user?.role === 'PM' && (
              <div className="p-3 border-t border-border">
                <button
                  onClick={handleCreateGroup}
                  className="w-full py-2 text-sm text-primary-500 hover:text-primary-600 flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  创建群组
                </button>
              </div>
            )}
          </>
        )}
        
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-2 m-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 self-end"
        >
          <svg 
            className={`w-4 h-4 transition-transform ${isCollapsed ? 'rotate-180' : ''}`} 
            fill="none" 
            viewBox="0 0 24 24" 
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
