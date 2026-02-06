/**
 * VisualAgentFullscreenPage - 独立全屏视觉创作页面
 * 不受外层 AppShell 布局影响
 */
import { ArrowLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { SystemDialogHost } from '@/components/ui/SystemDialogHost';
import { GlobalDefectSubmitDialog } from '@/components/ui/GlobalDefectSubmitDialog';
import VisualAgentWorkspaceListPage from './VisualAgentWorkspaceListPage';
import VisualAgentWorkspaceEditorPage from './VisualAgentWorkspaceEditorPage';

export default function VisualAgentFullscreenPage() {
  const navigate = useNavigate();
  const params = useParams();
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
          background: 'rgba(18, 18, 22, 0.8)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          color: 'var(--text-primary)',
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(18, 18, 22, 0.95)';
          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(18, 18, 22, 0.8)';
          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        }}
      >
        <ArrowLeft size={18} />
      </button>

      {/* 根据路由显示列表页或编辑页 */}
      {isEditor ? (
        <VisualAgentWorkspaceEditorPage />
      ) : (
        <VisualAgentWorkspaceListPage fullscreenMode />
      )}
    </div>
  );
}
