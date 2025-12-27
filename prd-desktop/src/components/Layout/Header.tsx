import { useMemo } from 'react';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useMessageStore } from '../../stores/messageStore';
import RoleSelector from '../Role/RoleSelector';
import ModeToggle from '../Role/ModeToggle';

interface HeaderProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export default function Header({ isDark, onToggleTheme }: HeaderProps) {
  const { user, logout } = useAuthStore();
  const { groups } = useGroupListStore();
  const { sessionId } = useSessionStore();
  const clearSession = useSessionStore((s) => s.clearSession);
  const clearGroups = useGroupListStore((s) => s.clear);
  const clearMessages = useMessageStore((s) => s.clearMessages);

  const canPreview = useMemo(() => {
    return groups.length > 0;
  }, [groups.length]);

  const clearLocalData = async () => {
    const ok = window.confirm('确认清理本地数据？这会退出登录，并清空本机缓存与对话记录（不影响服务器端数据）。');
    if (!ok) return;
    const ok2 = window.confirm('再次确认：清理后不可恢复。是否继续？');
    if (!ok2) return;

    try {
      // 清空本机“本章提问”历史落盘文件
      await invoke('clear_all_preview_ask_history');
    } catch {
      // ignore
    }

    try {
      localStorage.removeItem('auth-storage');
      localStorage.removeItem('session-storage');
      localStorage.removeItem('message-storage');
    } catch {
      // ignore
    }

    try {
      clearMessages();
      clearSession();
      clearGroups();
    } catch {
      // ignore
    }

    logout();
  };

  return (
    <>
      <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-surface-light dark:bg-surface-dark">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">P</span>
          </div>
          <h1 className="text-lg font-semibold">PRD Agent</h1>
        </div>

        <div className="flex items-center gap-4">
          {canPreview && (
            <>
              {sessionId ? <RoleSelector /> : null}
              <ModeToggle />
            </>
          )}

          <button
            onClick={onToggleTheme}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title={isDark ? '切换到亮色模式' : '切换到暗色模式'}
          >
            {isDark ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>

          <div className="flex items-center gap-2">
            <span className="text-sm text-text-secondary">{user?.displayName}</span>
            <button
              onClick={clearLocalData}
              className="text-sm text-text-secondary hover:text-text-primary"
              title="清理本地数据"
            >
              清理
            </button>
            <button
              onClick={logout}
              className="text-sm text-primary-500 hover:text-primary-600"
            >
              退出
            </button>
          </div>
        </div>
      </header>
    </>
  );
}
