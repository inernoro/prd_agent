import { FileText, Globe, type LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ResponsiveDialog } from '@/components/ui/ResponsiveDialog';
import type { DesignArtifactTarget } from '@/lib/designArtifactLaunch';
import { buildGenerateLaunchPath, DESIGN_LAUNCH_AGENTS, type GenerateContentSource } from './designLaunchAgents';

const AGENT_ICON: Record<DesignArtifactTarget, LucideIcon> = {
  'web-page': Globe,
  'html-ppt': FileText,
};

/**
 * 「选择生成智能体」弹窗：全站所有「用这份内容生成网页 / HTML PPT」入口共用这一份。
 *
 * 受控形态（open / onOpenChange 由调用方持有）：同一页面常有多个触发点
 * （知识库顶栏按钮 + 移动端更多菜单），它们打开的是同一个弹窗。
 * 选中后直接跳到目标工作台，来源由深链带过去，工作台里不需要再选一次。
 *
 * 走 ResponsiveDialog：窄屏（<768px）换成通栏底部面板。居中 Dialog 的标题区不收缩，
 * 描述一长就把整块撑出视口、关闭按钮被挤到屏幕外（390px 实测），而底部面板恒为屏宽、
 * 描述自动换行、关闭按钮常驻；卡片网格在窄屏本来就是单列。
 */
export function GenerateFromContentDialog({
  open,
  onOpenChange,
  source,
  sourceLabel = '当前知识',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 为 null 时弹窗不打开（没有可用来源就没有可生成的东西） */
  source: GenerateContentSource | null;
  /** 描述行里怎么称呼这份来源，例如「当前录音转录」 */
  sourceLabel?: string;
}) {
  const navigate = useNavigate();
  return (
    <ResponsiveDialog
      open={open && !!source}
      onOpenChange={onOpenChange}
      title="选择生成智能体"
      description={`${sourceLabel}：${source?.title || ''}。目标页会自动带入，不需要再次选择。`}
      maxWidth={620}
      content={(
        <div className="grid gap-3 sm:grid-cols-2">
          {DESIGN_LAUNCH_AGENTS.map((agent) => {
            const Icon = AGENT_ICON[agent.target];
            return (
              <button
                key={agent.target}
                type="button"
                data-design-target={agent.target}
                onClick={() => {
                  if (!source) return;
                  onOpenChange(false);
                  navigate(buildGenerateLaunchPath(agent.target, source));
                }}
                className="rounded-xl border border-token-subtle bg-token-nested p-4 text-left transition-colors hover:border-blue-500"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                  <Icon size={20} />
                </span>
                <span className="mt-3 block text-sm font-semibold text-token-primary">{agent.title}</span>
                <span className="mt-1 block text-xs leading-relaxed text-token-muted">{agent.description}</span>
              </button>
            );
          })}
        </div>
      )}
    />
  );
}
