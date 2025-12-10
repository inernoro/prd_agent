import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Group, ApiResponse } from '../../types';

export default function GroupList() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  useEffect(() => {
    loadGroups();
  }, []);

  const loadGroups = async () => {
    try {
      const response = await invoke<ApiResponse<Group[]>>('get_groups');
      if (response.success && response.data) {
        setGroups(response.data);
      }
    } catch (err) {
      console.error('Failed to load groups:', err);
    } finally {
      setLoading(false);
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
          onClick={() => setActiveGroupId(group.groupId)}
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



