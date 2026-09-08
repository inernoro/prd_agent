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
      className="surface-tone-dark h-full w-full relative"
      style={{
        background: '#0a0a0c',
      }}
    >
      {/* SystemDialogHost - 独立页面需要自己渲染对话框 */}
      <SystemDialogHost />
      {/* GlobalDefectSubmitDialog - 全局缺陷提交对话框 */}
      <GlobalDefectSubmitDialog />

      {/* 返回按钮 - 固定在左上角。**只有编辑器渲染它**。
          列表页自己的页头里已经有一颗返回钮了，而这颗是 fixed + z-50，正好压在它上面：
          屏幕上看着只有一颗，实际是旧的圆形 chrome 盖住了新页头里那颗，
          点到的也一直是旧的（Codex PR #1476 P2）。
          这跟下面教程 pill 的处理是同一条理由——列表页自带入口，这里就不要再出一份。
          注意它不是「隐藏一颗」那么简单：两颗的返回语义原来还不一样，旧的走 useSmartBack、
          新的是裸 navigate(-1)，所以留下的那颗必须补上兜底，见列表页那一处。 */}
      {isEditor && !hideFloatingChrome && (
      <button
        type="button"
        onClick={onBack}
        className="fixed top-5 left-5 z-50 flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 border border-token-subtle"
        style={{ background: '#2c2c2e', boxShadow: '0 4px 16px rgba(0,0,0,0.35)', color: 'var(--text-primary)' }}
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

      {/* 编辑器(全屏画布,无页头行)的本页教程入口,属该页固定 chrome。
          列表页(VisualAgentWorkspaceListPage)自己已在 HeroSection 内嵌入口,故此处仅编辑器渲染避免重复。

          放左上角、紧挨返回按钮,而不是右上角。右上角是一叠**宽度会变**的浮层:对话面板
          (420) 和 AI 分层面板 (300) 各自可开可关。这里原本写死 `md:right-[436px]` 去躲
          对话面板,分层面板一上线(right 444、宽 300、z-40)就压在了它的收起按钮上——pill
          是 z-50,正好盖住那个 X(2026-09-02 用户指出)。那个数字是魔数:它复制了浮层的几何,
          却不会跟着浮层改,布局一动就漂,而且没有任何东西会因此变红。
          放在返回钮**正下方**而不是它右边:画布顶部居中还挂着缩放浮层,它随画布列宽左右浮动,
          贴右边就得再猜一个横向安全距离——又是同一类魔数。竖着排开与它天然不同高。 */}
      {isEditor && !hideFloatingChrome && (
        <div className="fixed top-[68px] left-5 z-50">
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
