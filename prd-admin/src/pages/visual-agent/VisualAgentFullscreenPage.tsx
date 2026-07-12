/**
 * VisualAgentFullscreenPage - 独立全屏视觉创作页面
 * 不受外层 AppShell 布局影响
 */
import { ArrowLeft } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useSmartBack } from '@/hooks/useSmartBack';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';
import { GlobalDefectSubmitDialog } from '@/components/ui/GlobalDefectSubmitDialog';
import VisualAgentWorkspaceListPage from './VisualAgentWorkspaceListPage';
import VisualAgentWorkspaceEditorPage from './VisualAgentWorkspaceEditorPage';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import { useIsMobile } from '@/hooks/useBreakpoint';

export default function VisualAgentFullscreenPage() {
  const params = useParams();
  const workspaceId = params.workspaceId;
  const isMobile = useIsMobile();

  // 判断是列表页还是编辑页
  const isEditor = !!workspaceId;
  // 移动端编辑器（MobileVisualAgentEditor）自带顶部返回与操作条：
  // 本页的浮动返回钮/教程 pill 会叠压其 header（2026-07-10 用户反馈"顶部看不清"），一律隐藏。
  // 教程入口按 onboarding-tips 规范手机端走「我的 → 学习中心」承载。
  const hideFloatingChrome = isMobile && isEditor;

  // 智能返回：优先弹栈回真正的上一页（与浏览器/手势返回一致）；
  // 无站内历史（深链直达）时兜底：编辑页回列表页，列表页回首页
  const onBack = useSmartBack(isEditor ? '/visual-agent' : '/');

  return (
    <div
      className="h-full w-full relative"
      style={{
        background: '#0a0a0c',
      }}
    >
      {/* SystemDialogHost - 独立页面需要自己渲染对话框 */}
      <SystemDialogHost />
      {/* GlobalDefectSubmitDialog - 全局缺陷提交对话框 */}
      <GlobalDefectSubmitDialog />

      {/* 返回按钮 - 固定在左上角 */}
      {!hideFloatingChrome && (
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
      )}

      {/* 编辑器(全屏画布,无页头行)的本页教程入口:放右上角,与左上角返回按钮对称,属该页固定 chrome。
          列表页(VisualAgentWorkspaceListPage)自己已在 HeroSection 内嵌入口,故此处仅编辑器渲染避免重复。 */}
      {isEditor && !hideFloatingChrome && (
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
