import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ApiResponse, Document, Session, UserRole } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupListStore } from '../../stores/groupListStore';

export default function GroupList() {
  const { user } = useAuthStore();
  const { groups, loading, loadGroups } = useGroupListStore();
  const { activeGroupId, setActiveGroupId, setSession } = useSessionStore();

  useEffect(() => {
    loadGroups();
  }, []);

  const openGroup = async (groupId: string) => {
    setActiveGroupId(groupId);

    // 默认用登录用户角色打开群组会话（DEV/QA/PM）；管理员按 PM 处理
    const role: UserRole =
      user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM'
        ? user.role
        : 'PM';

    try {
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
    } catch (err) {
      console.error('Failed to open group session:', err);
    }
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
        暂无群组
      </div>
    );
  }

  return (
    <div className="py-2">
      {groups.map((group) => (
        <button
          key={group.groupId}
          onClick={() => openGroup(group.groupId)}
          className={`w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${
            activeGroupId === group.groupId ? 'bg-primary-50 dark:bg-primary-900/20 border-l-2 border-primary-500' : ''
          }`}
        >
          <div className="font-medium text-sm truncate">{group.groupName}</div>
          <div className="text-xs text-text-secondary mt-1 flex items-center justify-between">
            <span className="truncate">{group.prdTitle || 'PRD文档'}</span>
            <span className="ml-2 shrink-0">{group.memberCount}人</span>
          </div>
        </button>
      ))}
    </div>
  );
}
