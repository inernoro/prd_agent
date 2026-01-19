import { useEffect, useMemo, useState, useCallback } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useMessageStore } from '../../stores/messageStore';
import { assistantFontScaleBounds, useUiPrefsStore } from '../../stores/uiPrefsStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import RoleSelector from '../Role/RoleSelector';
import { useDesktopBrandingStore } from '../../stores/desktopBrandingStore';

interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version?: string;
  body?: string;
}

interface HeaderProps {
  isDark: boolean;
  onToggleTheme: () => void;
}

export default function Header({ isDark, onToggleTheme }: HeaderProps) {
  const { user, logout } = useAuthStore();
  const { groups } = useGroupListStore();
  const { sessionId, activeGroupId } = useSessionStore();
  const setMode = useSessionStore((s) => s.setMode);
  const clearContext = useSessionStore((s) => s.clearContext);
  const clearChatContext = useMessageStore((s) => s.clearCurrentContext);
  const connectionStatus = useConnectionStore((s) => s.status);
  const assistantFontScale = useUiPrefsStore((s) => s.assistantFontScale);
  const increaseAssistantFont = useUiPrefsStore((s) => s.increaseAssistantFont);
  const decreaseAssistantFont = useUiPrefsStore((s) => s.decreaseAssistantFont);
  const resetAssistantFont = useUiPrefsStore((s) => s.resetAssistantFont);
  const openSettingsModal = useSettingsStore((s) => s.openModal);
  const isAdmin = user?.role === 'ADMIN';
  const desktopName = useDesktopBrandingStore((s) => s.branding.desktopName);
  const loginIconUrl = useDesktopBrandingStore((s) => s.branding.loginIconUrl);

  const [logoSrc, setLogoSrc] = useState<string>('');
  useEffect(() => {
    setLogoSrc(loginIconUrl || '');
  }, [loginIconUrl]);
  const isMac = useMemo(() => {
    try {
      return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
    } catch {
      return false;
    }
  }, []);

  const canPreview = useMemo(() => {
    return groups.length > 0;
  }, [groups.length]);

  const handleOpenDevtools = useCallback(async () => {
    try {
      await invoke('open_devtools');
    } catch (e) {
      console.error('打开开发者工具失败:', e);
    }
  }, []);

  const handleCheckUpdate = useCallback(() => {
    // 延迟执行，确保菜单关闭后再显示弹窗
    setTimeout(async () => {
      try {
        const result = await invoke<UpdateInfo>('check_for_update');
        if (result.available) {
          window.alert(`发现新版本 ${result.version}\n\n${result.body || '请前往下载更新'}`);
        } else {
          window.alert(`当前已是最新版本 (${result.currentVersion})`);
        }
      } catch (e) {
        window.alert(`检查更新失败: ${e}`);
      }
    }, 100);
  }, []);

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

    // 先尽力清理服务端上下文（失败也不应阻止本地清空，否则用户会觉得“点了没反应”）
    if (activeGroupId) {
      try {
        const resp = await invoke<any>('clear_group_context', { groupId: activeGroupId });
        const ok = Boolean(resp?.success);
        const code = String(resp?.error?.code ?? '').trim();
        if (!ok && code === 'UNAUTHORIZED') {
          // token 失效：回到登录页；本地清空仍会继续执行（best-effort）
          logout();
        }
      } catch {
        // ignore
      }
    }

    // 无论服务端是否成功，都清空本地对话视图（不回填历史，符合“清理上下文”的用户预期）
    try {
      clearChatContext(sessionId);
      clearContext();
    } catch {
      // ignore
    }
  };

  return (
    <>
      <header
        className={`relative px-4 flex items-center justify-between border-b ui-glass-bar ${isMac ? 'h-[84px] pt-[28px]' : 'h-14'}`}
      >
        {/* macOS 覆盖式标题栏：顶部留出“红绿灯 + 可拖拽区” */}
        {isMac ? <div className="absolute inset-x-0 top-0 h-[28px]" data-tauri-drag-region /> : null}

        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden bg-transparent">
            {logoSrc ? (
              <img
                src={logoSrc}
                alt="app logo"
                className="w-full h-full object-contain"
                onError={() => {
                  // 后端已处理回退逻辑，如果加载失败则清空显示默认图标
                  setLogoSrc('');
                }}
              />
            ) : (
              <div className="w-full h-full rounded-lg bg-primary-500 flex items-center justify-center">
                <span className="text-white font-bold text-sm">P</span>
              </div>
            )}
          </div>
          <h1 className="text-lg font-semibold">{desktopName || 'PRD Agent'}</h1>
        </div>

        <div className="flex items-center gap-4">
          {canPreview && (
            <>
              {sessionId && isAdmin ? <RoleSelector /> : null}
            </>
          )}

          {/* 连接状态：断连时给出轻量提示，避免用户误以为“无权限/系统坏了” */}
          {connectionStatus === 'disconnected' && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-red-700 dark:text-red-200 bg-red-500/15 border border-red-500/35 shadow-sm animate-pulse"
              title="已断线，正在重连…"
              aria-label="已断线，正在重连"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 13a5 5 0 0 1 7.07-7.07l1.41 1.41" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 11a5 5 0 0 1-7.07 7.07l-1.41-1.41" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 3l18 18" />
              </svg>
              <span className="text-sm font-semibold tracking-wide whitespace-nowrap">
                已断线，正在重连…
              </span>
            </div>
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
                  className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-text-secondary hover:text-text-primary"
                  title="功能菜单"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  sideOffset={6}
                  align="end"
                  className="z-50 min-w-[120px] rounded-md ui-glass-panel p-1"
                >
                  {isAdmin ? (
                    <>
                      <DropdownMenu.Item
                        className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary"
                        onSelect={() => setMode('AssetsDiag')}
                      >
                        资源诊断
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator className="my-1 h-px bg-black/10 dark:bg-white/10" />
                    </>
                  ) : null}
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary"
                    onSelect={handleClearCurrentContext}
                  >
                    清理上下文
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
                    disabled={assistantFontScale <= assistantFontScaleBounds.min + 1e-6}
                    onSelect={() => {
                      decreaseAssistantFont();
                    }}
                  >
                    缩小字体
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
                    disabled={assistantFontScale >= assistantFontScaleBounds.max - 1e-6}
                    onSelect={() => {
                      increaseAssistantFont();
                    }}
                  >
                    放大字体
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
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
                  <DropdownMenu.Separator className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger className="flex items-center justify-between px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/5">
                      帮助
                      <svg className="w-4 h-4 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                      </svg>
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.SubContent
                        sideOffset={4}
                        alignOffset={-4}
                        className="z-50 min-w-[140px] rounded-md ui-glass-panel p-1"
                      >
                        <DropdownMenu.Item
                          className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary"
                          onSelect={openSettingsModal}
                        >
                          设置
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1 h-px bg-black/10 dark:bg-white/10" />
                        <DropdownMenu.Item
                          className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary"
                          onSelect={handleOpenDevtools}
                        >
                          开发者工具
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1 h-px bg-black/10 dark:bg-white/10" />
                        <DropdownMenu.Item
                          className="px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 outline-none text-text-secondary hover:text-text-primary"
                          onSelect={handleCheckUpdate}
                        >
                          检查更新
                        </DropdownMenu.Item>
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>
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
