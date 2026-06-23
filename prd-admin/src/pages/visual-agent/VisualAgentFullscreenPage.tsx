/**
 * VisualAgentFullscreenPage - 独立全屏视觉创作页面
 * 不受外层 AppShell 布局影响
 */
import { ArrowLeft } from 'lucide-react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';
import { GlobalDefectSubmitDialog } from '@/components/ui/GlobalDefectSubmitDialog';
import VisualAgentWorkspaceListPage from './VisualAgentWorkspaceListPage';
import VisualAgentWorkspaceEditorPage from './VisualAgentWorkspaceEditorPage';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import { MobileCompatGate } from '@/components/MobileCompatGate';
import { useBreakpoint } from '@/hooks/useBreakpoint';

export default function VisualAgentFullscreenPage() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const { isMobile } = useBreakpoint();
  const workspaceId = params.workspaceId;

  // 判断是列表页还是编辑页
  const isEditor = !!workspaceId;

  // 返回目标：编辑页返回列表页，列表页返回首页
  const onBack = () => {
    if (isEditor) {
      navigate('/visual-agent');
    } else {
      navigate('/');
    }
  };

  return (
    <div
      className="h-full w-full relative"
      style={{
        background: '#0a0a0c',
      }}
    >
      {/* 手机端 pc-only 门槛：本页是独立全屏路由、不进 AppShell，AppShell 渲染的
          MobileCompatGate 对本页失效，导致手机用户直接走进为桌面鼠标设计的画布(留白/露背景)。
          在此补回门槛，让手机访问显示「建议用电脑」+ 复制链接（仍可「继续浏览」）。
          见 .claude/rules/mobile-first-density.md 与 lib/mobileCompatibility.ts（/visual-agent = pc-only）。 */}
      {isMobile && <MobileCompatGate pathname={location.pathname} />}

      {/* SystemDialogHost - 独立页面需要自己渲染对话框 */}
      <SystemDialogHost />
      {/* GlobalDefectSubmitDialog - 全局缺陷提交对话框 */}
      <GlobalDefectSubmitDialog />

      {/* 返回按钮 - 固定在左上角 */}
      <button
        type="button"
        onClick={onBack}
        className="fixed top-5 left-5 z-50 flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200"
        style={{
          background: '#2c2c2e',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          color: 'var(--text-primary)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#363638';
          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = '#2c2c2e';
          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        }}
      >
        <ArrowLeft size={18} />
      </button>

      {/* 编辑器(全屏画布,无页头行)的本页教程入口:放右上角,与左上角返回按钮对称,属该页固定 chrome。
          列表页(VisualAgentWorkspaceListPage)自己已在 HeroSection 内嵌入口,故此处仅编辑器渲染避免重复。 */}
      {isEditor && (
        <div className="fixed top-5 right-5 z-50">
          <TipsEntryButton compact />
        </div>
      )}

      {/* 根据路由显示列表页或编辑页 */}
      {isEditor ? (
        <VisualAgentWorkspaceEditorPage />
      ) : (
        <VisualAgentWorkspaceListPage fullscreenMode />
      )}
    </div>
  );
}
