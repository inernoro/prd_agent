import { useEffect, useMemo, useState } from 'react';
import { invoke, listen } from './lib/tauri';
import { useSessionStore } from './stores/sessionStore';
import { useAuthStore } from './stores/authStore';
import { useGroupListStore } from './stores/groupListStore';
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
import AssetsDiagPage from './components/Assets/AssetsDiagPage';
import StartLoadOverlay from './components/Assets/StartLoadOverlay';
import { isSystemErrorCode } from './lib/systemError';
import { useConnectionStore } from './stores/connectionStore';
import { useDesktopBrandingStore } from './stores/desktopBrandingStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { ApiResponse, Document, PromptsClientResponse, Session, UserRole } from './types';

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
  const [isThemeTransitioning, setIsThemeTransitioning] = useState(false);
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
  const connectionStatus = useConnectionStore((s) => s.status);

  // 全局拉取 Desktop 品牌配置：覆盖"自动登录直达主界面"场景，确保 desktopName/logo/bg 能及时更新
  useEffect(() => {
    const skin = isDark ? 'dark' : 'white';
    void refreshBranding('app-start', skin);
    const onFocus = () => {
      const currentSkin = isDark ? 'dark' : 'white';
      void refreshBranding('focus', currentSkin);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshBranding, isDark]);

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

  // 主题切换时重新获取对应皮肤的资源
  useEffect(() => {
    const skin = isDark ? 'dark' : 'white';
    const refreshBranding = useDesktopBrandingStore.getState().refresh;
    void refreshBranding('theme_change', skin);
  }, [isDark]);

  const applyTheme = (nextIsDark: boolean) => {
    setIsDark(nextIsDark);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextIsDark ? 'dark' : 'light');
    } catch {
      // ignore
    }
  };

  const onToggleTheme = () => {
    // 过渡进行中则忽略，避免连点造成状态错乱
    if (isThemeTransitioning) return;

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

    // 直接线性过渡到目标主题颜色：不使用遮罩，避免“白->黑->白”闪烁
    const DURATION_MS = 520;
    setIsThemeTransitioning(true);
    try {
      document.documentElement.classList.add('theme-transitioning');
    } catch {
      // ignore
    }

    applyTheme(!isDark);

    window.setTimeout(() => {
      try {
        document.documentElement.classList.remove('theme-transitioning');
      } catch {
        // ignore
      }
      setIsThemeTransitioning(false);
    }, DURATION_MS);
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

  // 登录后拉取提示词列表（用于提示词按钮）
  useEffect(() => {
    if (!isAuthenticated) return;

    let stopped = false;
    let isLoading = false;
    const fetchOnce = () => {
      // 防止并发调用
      if (isLoading) return Promise.resolve();
      // 在函数内部检查连接状态，而不是作为依赖项
      if (useConnectionStore.getState().status === 'disconnected') return Promise.resolve();
      isLoading = true;
      return invoke<ApiResponse<PromptsClientResponse>>('get_prompts')
        .then((res) => {
          if (stopped) return;
          if (res?.success && res.data) {
            useSessionStore.getState().setPrompts(res.data);
          }
        })
        .catch(() => {
          // 网络波动/断连不打扰用户；UI 会回落到本地硬编码
        })
        .finally(() => {
          isLoading = false;
        });
    };

    // 立刻拉一次
    void fetchOnce();

    // 后台配置变更后，Desktop 需要定期刷新（否则用户会误以为"保存没生效"）
    // 频率：5 分钟（与后端 prompts cache TTL 对齐）
    const timer = window.setInterval(() => void fetchOnce(), 5 * 60 * 1000);

    // 移除 focus 事件监听，避免频繁切换窗口时重复请求
    // 5分钟的轮询已经足够保持提示词列表的新鲜度

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
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

        // Deep link 加入群组后强制刷新列表
        await useGroupListStore.getState().loadGroups({ force: true });

        const openResp = await invoke<ApiResponse<{ sessionId: string; groupId: string; documentId: string; currentRole: string }>>(
          'open_group_session',
          { groupId: joinResp.data.groupId, userRole: effectiveRole }
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
          currentRole: (openResp.data.currentRole as UserRole) || effectiveRole,
          mode: 'QA',
        };

        useSessionStore.getState().setSession(session, docResp.data);
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
          ) : groupsLoading ? (
            // 冷启动加载时由 StartLoadOverlay 统一覆盖；主区保持空，避免重复“加载中...”
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

      {/* 冷启动全局加载遮罩（唯一加载动画） */}
      <StartLoadOverlay open={showColdStartLoading} />
    </div>
  );
}

export default App;

