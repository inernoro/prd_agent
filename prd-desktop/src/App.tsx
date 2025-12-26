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
import SystemErrorModal from './components/Feedback/SystemErrorModal';
import { isSystemErrorCode } from './lib/systemError';
import type { ApiResponse, Document, Session, UserRole } from './types';

function App() {
  const { isAuthenticated, accessToken } = useAuthStore();
  const { user } = useAuthStore();
  const { setSession, mode } = useSessionStore();
  const { loadGroups, groups, loading: groupsLoading } = useGroupListStore();
  const [isDark, setIsDark] = useState(false);
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(null);

  const effectiveRole: UserRole = useMemo(() => {
    if (user?.role === 'DEV' || user?.role === 'QA' || user?.role === 'PM') return user.role;
    return 'PM';
  }, [user?.role]);

  useEffect(() => {
    // 检测系统主题
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDark(prefersDark);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  // 将持久化的 token 同步到 Rust（避免重启后 Rust 侧没有 token 导致请求 401）
  useEffect(() => {
    invoke('set_auth_token', { token: accessToken }).catch((err) => {
      console.error('Failed to sync auth token:', err);
    });
  }, [accessToken]);

  // 登录后预加载群组列表，避免 UI 先闪“上传PRD”
  useEffect(() => {
    if (!isAuthenticated) return;
    if (user?.userId === 'demo-user-001') return;
    loadGroups().catch(() => {});
  }, [isAuthenticated, loadGroups, user?.userId]);

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

        await loadGroups();

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

        setSession(session, docResp.data);
      } catch (err) {
        console.error('Failed to handle deep link join:', err);
        // invoke reject 已由全局弹窗接管
      } finally {
        setPendingInviteCode(null);
      }
    };

    run();
  }, [isAuthenticated, pendingInviteCode, effectiveRole, loadGroups, setSession]);

  // 未登录显示登录页
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="h-full flex flex-col bg-background-light dark:bg-background-dark">
      <Header isDark={isDark} onToggleTheme={() => setIsDark(!isDark)} />
      
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {/* 规则：
              - 没有任何群组：右侧显示上传 PRD（上传后自动建群）
              - 有群组：右侧进入会话区域；未绑定 PRD 的群组显示“待上传/不可对话”空态（由 ChatContainer/ChatInput 控制）
          */}
          {groupsLoading ? (
            <div className="flex-1 flex items-center justify-center text-text-secondary">
              加载中...
            </div>
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
      </div>

      {/* 全局系统级错误弹窗（invoke 层统一拦截触发） */}
      <SystemErrorModal />
    </div>
  );
}

export default App;

