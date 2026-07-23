import { GlassCard } from '@/components/design/GlassCard';
import AdvancedVisualAgentTab from '@/pages/ai-chat/AdvancedVisualAgentTab';
import MobileVisualAgentEditor from '@/pages/visual-agent/MobileVisualAgentEditor';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useParams, Link } from 'react-router-dom';
import { useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';

export default function VisualAgentWorkspaceEditorPage() {
  const params = useParams();
  const workspaceId = String(params.workspaceId ?? '').trim();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  // 手机端默认进入线性生成流；点「画布」可切到完整画布浏览，再点浮标切回
  const [mobileCanvasMode, setMobileCanvasMode] = useState(false);

  if (!workspaceId) {
    return (
      <div ref={wrapRef} className="h-full min-h-0 flex flex-col">
        <GlassCard animated glow>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            workspaceId 为空。请从 <Link to="/visual-agent">视觉创作 Agent</Link> 选择一个项目进入。
          </div>
        </GlassCard>
      </div>
    );
  }

  if (isMobile && !mobileCanvasMode) {
    return (
      <div ref={wrapRef} className="h-full min-h-0 flex flex-col">
        <MobileVisualAgentEditor workspaceId={workspaceId} onOpenCanvas={() => setMobileCanvasMode(true)} />
      </div>
    );
  }

  // AdvancedVisualAgentTab 内部使用大量 h-full/min-h-0 布局，必须由父容器提供稳定高度
  // initialPrompt 现在在移动生成流 / AdvancedVisualAgentTab 内部从 sessionStorage 读取
  return (
    <div ref={wrapRef} className="h-full min-h-0 flex flex-col relative">
      <AdvancedVisualAgentTab workspaceId={workspaceId} />
      {isMobile && mobileCanvasMode ? (
        <button
          type="button"
          className="absolute left-3 z-40 h-10 w-10 inline-flex items-center justify-center rounded-full active:opacity-70 border border-token-subtle"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 76px)', background: 'rgba(30,30,36,0.9)', color: 'rgba(255,255,255,0.85)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}
          onClick={() => setMobileCanvasMode(false)}
          aria-label="返回生成流"
        >
          <MessagesSquare size={17} />
        </button>
      ) : null}
    </div>
  );
}
