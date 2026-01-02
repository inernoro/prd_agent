import { useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useMessageStore } from '../../stores/messageStore';
import { assistantFontScaleBounds, useUiPrefsStore } from '../../stores/uiPrefsStore';
import RoleSelector from '../Role/RoleSelector';

interface HeaderProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export default function Header({ isDark, onToggleTheme }: HeaderProps) {
  const { user, logout } = useAuthStore();
  const { groups } = useGroupListStore();
  const { sessionId, activeGroupId } = useSessionStore();
  const clearContext = useSessionStore((s) => s.clearContext);
  const clearChatContext = useMessageStore((s) => s.clearCurrentContext);
  const assistantFontScale = useUiPrefsStore((s) => s.assistantFontScale);
  const increaseAssistantFont = useUiPrefsStore((s) => s.increaseAssistantFont);
  const decreaseAssistantFont = useUiPrefsStore((s) => s.decreaseAssistantFont);
  const resetAssistantFont = useUiPrefsStore((s) => s.resetAssistantFont);

  const canPreview = useMemo(() => {
    return groups.length > 0;
  }, [groups.length]);

  const handleClearCurrentContext = async () => {
    const ok = window.confirm('确认清理当前对话上下文？这会清空本地对话记录，并清理服务器端“LLM上下文缓存”（不删除消息历史），不会退出登录，也不会解绑 PRD。');
    if (!ok) return;
    const ok2 = window.confirm('再次确认：清理后当前会话上下文不可恢复。是否继续？');
    if (!ok2) return;

    try {
      // 若正在流式，先取消（最佳努力）
      await invoke('cancel_stream', { kind: 'all' });
    } catch {
      // ignore
    }

    try {
      // 清理服务端上下文缓存（群组会话优先）
      if (activeGroupId) {
        const resp = await invoke<any>('clear_group_context', { groupId: activeGroupId });
        const ok = Boolean(resp?.success);
        const code = String(resp?.error?.code ?? '').trim();
        if (!ok && code === 'UNAUTHORIZED') {
          logout();
          return;
        }
      }
      clearChatContext(sessionId);
      clearContext();
    } catch {
      // ignore
    }
  };

  return (
    <>
      <header className="h-14 px-4 flex items-center justify-between border-b ui-glass-bar">
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
            </>
          )}

          <button
            onClick={onToggleTheme}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
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
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="text-sm text-text-secondary hover:text-text-primary flex items-center gap-1"
                  title="功能菜单"
                >
                  功能
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  sideOffset={6}
                  align="end"
                  className="z-50 min-w-[120px] rounded-md ui-glass-panel p-1"
                >
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary"
                    onSelect={handleClearCurrentContext}
                  >
                    清理上下文
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={assistantFontScale <= assistantFontScaleBounds.min + 1e-6}
                    onSelect={() => {
                      decreaseAssistantFont();
                    }}
                  >
                    缩小字体
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={assistantFontScale >= assistantFontScaleBounds.max - 1e-6}
                    onSelect={() => {
                      increaseAssistantFont();
                    }}
                  >
                    放大字体
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={Math.abs(assistantFontScale - assistantFontScaleBounds.def) < 1e-6}
                    onSelect={() => {
                      resetAssistantFont();
                    }}
                  >
                    恢复默认
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-xs rounded outline-none text-text-secondary select-none pointer-events-none opacity-70"
                  >
                    当前：{Math.round(assistantFontScale * 100)}%
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
