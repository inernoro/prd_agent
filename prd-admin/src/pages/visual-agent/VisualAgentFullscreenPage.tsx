/**
 * VisualAgentFullscreenPage - 独立全屏视觉创作页面
 * 不受外层 AppShell 布局影响
 */
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import VisualAgentWorkspaceListPage from './VisualAgentWorkspaceListPage';

export default function VisualAgentFullscreenPage() {
  const navigate = useNavigate();

  return (
    <div
      className="h-full w-full relative"
      style={{
        background: '#0a0a0c',
      }}
    >
      {/* 返回按钮 - 固定在左上角 */}
      <button
        type="button"
        onClick={() => navigate('/')}
        className="fixed top-5 left-5 z-50 flex items-center gap-2 px-4 py-2 rounded-[12px] transition-all duration-200"
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
        <span className="text-sm font-medium">返回主页</span>
      </button>

      {/* 视觉创作内容 */}
      <VisualAgentWorkspaceListPage />
    </div>
  );
}
