import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import GroupList from '../Group/GroupList';

export default function Sidebar() {
  const { user } = useAuthStore();
  const [isCollapsed, setIsCollapsed] = useState(false);

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
            {user?.role === 'PM' && (
              <div className="p-3 border-t border-border">
                <button className="w-full py-2 text-sm text-primary-500 hover:text-primary-600 flex items-center justify-center gap-2">
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


