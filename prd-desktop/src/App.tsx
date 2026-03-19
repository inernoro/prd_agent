import React, { useEffect, useMemo, useState } from 'react';
import { invoke, isTauri, listen } from './lib/tauri';
import { useSessionStore } from './stores/sessionStore';
import { useAuthStore } from './stores/authStore';
import { useGroupListStore } from './stores/groupListStore';
import { useSettingsStore } from './stores/settingsStore';
import Header from './components/Layout/Header';
import Sidebar from './components/Layout/Sidebar';
import DocumentUpload from './components/Document/DocumentUpload';
import PrdPreviewPage from './components/Document/PrdPreviewPage';
import ChatContainer from './components/Chat/ChatContainer';
import KnowledgeBasePage from './components/KnowledgeBase/KnowledgeBasePage';
import LoginPage from './components/Auth/LoginPage';
import PrdCitationPreviewDrawer from './components/Document/PrdCitationPreviewDrawer';
import GroupInfoDrawer from './components/Group/GroupInfoDrawer';
import SystemErrorModal from './components/Feedback/SystemErrorModal';
import SettingsModal from './components/Settings/SettingsModal';
import AssetsDiagPage from './components/Assets/AssetsDiagPage';
import DefectListPage from './components/Defect/DefectListPage';
import StartLoadOverlay from './components/Assets/StartLoadOverlay';
import { isSystemErrorCode } from './lib/systemError';
import { useConnectionStore } from './stores/connectionStore';
import { useDesktopBrandingStore } from './stores/desktopBrandingStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ApiResponse, UserRole } from './types';
import { openGroupSessionAndSetStore } from './lib/openGroupSession';
import { useClientConfigStore } from './stores/clientConfigStore';
import { useUpdateStore } from './stores/updateStore';
import UpdateNotification from './components/Feedback/UpdateNotification';

const THEME_STORAGE_KEY = 'prd-desktop-theme';

function readStoredTheme(): 'dark' | 'light' | null {
  try {
    const v = (localStorage.getItem(THEME_STORAGE_KEY) || '').trim().toLowerCase();
    if (v === 'dark' || v === 'light') return v;
    return null;
  } catch {
    return null;
  }
}

function App() {
  // 清理旧的 localStorage 缓存（移除 message-storage）
  useEffect(() => {
    try {
      const oldKeys = ['message-storage'];
      oldKeys.forEach((key) => {
        if (localStorage.getItem(key)) {
          console.log(`[App] Cleaning up old localStorage key: ${key}`);
          localStorage.removeItem(key);
        }
      });
    } catch (err) {
      console.error('[App] Failed to clean up old localStorage:', err);
    }
  }, []);

  const { isAuthenticated, accessToken, refreshToken, sessionKey, user } = useAuthStore();
  // 只订阅真正需要的状态，避免不必要的重新渲染
  const mode = useSessionStore((s) => s.mode);
  const sessionId = useSessionStore((s) => s.sessionId);
  const groups = useGroupListStore((s) => s.groups);
  const groupsLoading = useGroupListStore((s) => s.loading);
  const refreshBranding = useDesktopBrandingStore((s) => s.refresh);
  const windowTitle = useDesktopBrandingStore((s) => s.branding.windowTitle);
  const [isDark, setIsDark] = useState(() => {
    const stored = readStoredTheme();
    if (stored) return stored === 'dark';
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  });
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(null);

  // 全局拉取 Desktop 品牌配置：仅启动时拉取一次，不再每次聚焦窗口都请求
  useEffect(() => {
    const skin = isDark ? 'dark' : 'white';
    void refreshBranding('app-start', skin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 启动时从 GitHub Release 拉取远程客户端配置（预设服务器列表等）
  useEffect(() => {
    if (isTauri()) {
      void useClientConfigStore.getState().fetchClientConfig();
    }
  }, []);

  // 静默更新调度：启动 30s 后首次检查，之后每 2 小时检查一次
  useEffect(() => {
    if (!isTauri()) return;

    const INITIAL_DELAY = 30 * 1000;           // 30 秒
    const PERIODIC_INTERVAL = 2 * 60 * 60 * 1000; // 2 小时

    const check = () => void useUpdateStore.getState().checkAndDownload();

    const initialTimer = window.setTimeout(() => {
      check();
      periodicTimer = window.setInterval(check, PERIODIC_INTERVAL);
    }, INITIAL_DELAY);

    let periodicTimer: ReturnType<typeof setInterval> | undefined;

    return () => {
      window.clearTimeout(initialTimer);
      if (periodicTimer) window.clearInterval(periodicTimer);
    };
  }, []);

  // 将窗口标题与服务器下发配置对齐（若未下发则由 store 默认值兜底）
  useEffect(() => {
    const title = String(windowTitle || '').trim();
    if (!title) return;
    try {
      void getCurrentWindow().setTitle(title);
    } catch {
      // ignore
    }
  }, [windowTitle]);

  // SSE 场景下 Rust 侧可能通过事件通知登录已过期（401且 refresh 失败）
  useEffect(() => {
    const unlistenPromise = listen<any>('auth-expired', () => {
      try {
        useAuthStore.getState().logout();
      } catch {
        // ignore
      }
    }).catch(() => {
      return () => {};
    });
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 监听系统菜单栏"设置"事件
  useEffect(() => {
    const unlistenPromise = listen('open-settings', () => {
      useSettingsStore.getState().openModal();
    }).catch(() => {
      return () => {};
    });
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 使用 F12 或 Cmd/Ctrl+Shift+I 打开开发者工具（仅桌面端）
  useEffect(() => {
    if (!isTauri()) return () => {};
    let lastOpenAt = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      const isDevToolsShortcut =
        e.key === 'F12' ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i');
      if (!isDevToolsShortcut) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastOpenAt < 400) return;
      lastOpenAt = now;
      invoke('open_devtools').catch((err) => {
        console.error('打开开发者工具失败:', err);
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const effectiveRole: UserRole = useMemo(() => {
    if (user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM') return user.role;
    return 'PM';
  }, [user?.role]);

  // 若用户没有手动选择主题，则跟随系统主题变化
  useEffect(() => {
    try {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (readStoredTheme()) return;
        setIsDark(mql.matches);
      };
      onChange();
      // Safari 老版本兼容
      // eslint-disable-next-line
      const anyMql = mql as any;
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
      }
      if (typeof anyMql.addListener === 'function') {
        anyMql.addListener(onChange);
        return () => anyMql.removeListener(onChange);
      }
    } catch {
      // ignore
    }
    return () => {};
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  const applyTheme = (nextIsDark: boolean) => {
    setIsDark(nextIsDark);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextIsDark ? 'dark' : 'light');
    } catch {
      // ignore
    }
  };

  const onToggleTheme = (e?: React.MouseEvent) => {
    // 无动画偏好：直接切换
    try {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) {
        applyTheme(!isDark);
        return;
      }
    } catch {
      // ignore
    }

    // 计算按钮中心坐标作为水波纹原点
    let x = window.innerWidth / 2, y = 0;
    if (e) {
      const btn = (e.currentTarget || e.target) as HTMLElement;
      const rect = btn.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }

    // 计算覆盖全屏所需的最大半径
    const maxRadius = Math.ceil(Math.sqrt(
      Math.max(x, window.innerWidth - x) ** 2 +
      Math.max(y, window.innerHeight - y) ** 2
    ));

    document.documentElement.style.setProperty('--ripple-x', `${x}px`);
    document.documentElement.style.setProperty('--ripple-y', `${y}px`);
    document.documentElement.style.setProperty('--ripple-radius', `${maxRadius}px`);

    // View Transition API 水波纹扩散，自动降级到瞬时切换
    if (document.startViewTransition) {
      document.startViewTransition(() => applyTheme(!isDark));
    } else {
      applyTheme(!isDark);
    }
  };

  // 将持久化的 token 同步到 Rust（避免重启后 Rust 侧没有 token 导致请求 401）
  useEffect(() => {
    invoke('set_auth_token', { token: accessToken }).catch((err) => {
      console.error('Failed to sync auth token:', err);
    });
    // 同步 refresh 会话信息（用于 Rust 侧自动 refresh）
    invoke('set_auth_session', {
      userId: user?.userId ?? null,
      refreshToken: refreshToken ?? null,
      sessionKey: sessionKey ?? null,
      clientType: 'desktop',
    }).catch((err) => {
      console.error('Failed to sync auth session:', err);
    });
  }, [accessToken, refreshToken, sessionKey, user?.userId]);

  // 会话 keep-alive：用户可能长时间阅读 PRD/回看历史而不发消息，但仍希望"首次提问"不因为 30min 无写操作而直接过期。
  // 依赖后端 GET /sessions/{id} 会刷新 LastActiveAt + TTL（滑动过期）。
  useEffect(() => {
    if (!isAuthenticated || !sessionId) return;

    let stopped = false;
    const intervalMs = 5 * 60 * 1000; // 5分钟一次，足够轻量

    const tick = async () => {
      const currentSessionId = useSessionStore.getState().sessionId;
      if (!currentSessionId) return;
      
      try {
        const resp = await invoke<ApiResponse<any>>('get_session', { sessionId: currentSessionId });
        if (!resp?.success) {
          const code = resp?.error?.code;
          if (code === 'SESSION_NOT_FOUND' || code === 'SESSION_EXPIRED') {
            // 会话在服务端已失效：清理本地绑定，避免继续用旧 sessionId 触发一堆"已过期"报错。
            if (!stopped) useSessionStore.getState().clearSession();
          }
        }
      } catch {
        // 网络抖动/服务暂不可用：不打扰用户
      }
    };

    // 立刻 touch 一次，避免刚回到前台就处于过期边缘
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [isAuthenticated, sessionId]);

  // 登录后预加载群组列表，避免 UI 先闪"上传PRD"
  useEffect(() => {
    if (!isAuthenticated) return;
    useGroupListStore.getState().loadGroups().catch(() => {});
  }, [isAuthenticated]);

  // 监听 deep link：prdagent://join/{inviteCode}
  useEffect(() => {
    const unlistenPromise = listen<string>('deep-link', (event) => {
      const url = (event.payload || '').trim();
      const code = url.includes('prdagent://join/')
        ? url.split('prdagent://join/')[1]?.split(/[?#/\\s]/)[0]
        : null;

      if (code) {
        setPendingInviteCode(code);
      }
    }).catch((err) => {
      console.error('Failed to listen to deep-link event:', err);
      return () => {};
    });

    return () => {
      unlistenPromise.then((fn) => fn()).catch((err) => {
        console.error('Failed to unlisten deep-link event:', err);
      });
    };
  }, []);

  // 登录后自动处理 deep link 加入群组
  useEffect(() => {
    if (!isAuthenticated || !pendingInviteCode) return;

    const run = async () => {
      try {
        const joinResp = await invoke<ApiResponse<{ groupId: string }>>('join_group', {
          inviteCode: pendingInviteCode,
          userRole: effectiveRole,
        });

        if (!joinResp.success || !joinResp.data) {
          const code = joinResp.error?.code ?? null;
          // 系统性错误已由 invoke 层弹窗接管，这里只处理业务提示
          if (!isSystemErrorCode(code)) {
            alert(joinResp.error?.message || '加入群组失败');
          }
          return;
        }

        // Deep link 加入群组后强制刷新列表（silent 避免 ChatContainer 卸载重挂）
        await useGroupListStore.getState().loadGroups({ force: true, silent: true });
        await openGroupSessionAndSetStore(joinResp.data.groupId, effectiveRole);
      } catch (err) {
        console.error('Failed to handle deep link join:', err);
        // invoke reject 已由全局弹窗接管
      } finally {
        setPendingInviteCode(null);
      }
    };

    run();
  }, [isAuthenticated, pendingInviteCode, effectiveRole]);

  // 未登录显示登录页
  if (!isAuthenticated) {
    return <LoginPage isDark={isDark} onToggleTheme={onToggleTheme} />;
  }

  // 冷启动全局加载遮罩：只保留一个（覆盖侧栏+主区），避免出现“导航一份、主区一份”的重复加载提示
  const showColdStartLoading = groupsLoading;

  return (
    <div className="h-full flex flex-col bg-background-light dark:bg-background-dark">
      <Header isDark={isDark} onToggleTheme={onToggleTheme} />
      
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {/* 规则：
              - 没有任何群组：右侧显示上传 PRD（上传后自动建群）
              - 有群组：右侧进入会话区域；未绑定 PRD 的群组显示“待上传/不可对话”空态（由 ChatContainer/ChatInput 控制）
          */}
          {mode === 'AssetsDiag' ? (
            <AssetsDiagPage />
          ) : mode === 'Defect' ? (
            <DefectListPage />
          ) : groupsLoading ? (
            // 冷启动加载时由 StartLoadOverlay 统一覆盖；主区保持空，避免重复"加载中..."
            <div className="flex-1" />
          ) : groups.length === 0 ? (
            <DocumentUpload />
          ) : mode === 'PrdPreview' ? (
            <PrdPreviewPage />
          ) : (
            mode === 'Knowledge' ? <KnowledgeBasePage /> : <ChatContainer />
          )}
        </main>

        {/* 引用小抽屉预览（不影响全屏 PrdPreviewPage 的引用浮层） */}
        <PrdCitationPreviewDrawer />
        {/* 群信息侧边栏（右侧抽屉） */}
        <GroupInfoDrawer />
      </div>

      {/* 全局系统级错误弹窗（invoke 层统一拦截触发） */}
      <SystemErrorModal />

      {/* 设置模态框 */}
      <SettingsModal />

      {/* 静默更新右下角通知 */}
      <UpdateNotification />

      {/* 冷启动全局加载遮罩（唯一加载动画） */}
      <StartLoadOverlay open={showColdStartLoading} />
    </div>
  );
}

export default App;
