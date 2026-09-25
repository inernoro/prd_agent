import { ArrowUpRight, MonitorPlay } from 'lucide-react';
import { HTML_PPT_TIMING_NOTE, type HtmlPptHandoff } from './outputForm';
import { PreviewPanel } from './WorkbenchParts';

/**
 * 选了「网页 PPT」时右边这一屏：说清会带过去什么、带不过去什么、接下来三步、最后落在哪。
 * 用户点下去之前就知道要离开这个窗口，不会被一次跳转吓到。
 */
export function HtmlPptHandoffPanel({ handoff, onOpenBlank }: { handoff: HtmlPptHandoff; onOpenBlank: () => void }) {
  const steps = [
    '带着稿子和要求打开 HTML PPT 智能体，要求预填在输入框里，确认后点发送',
    '先出大纲（边写边显示），你改好、确认后再逐页生成，预览里一页页亮起来',
    '满意后点「发布」，它会进网页托管、识别为幻灯片，和网页一样可以「发布给客户」',
  ];
  return (
    <PreviewPanel>
      <div className="flex h-full flex-col gap-4 p-4 lg:p-6" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }} data-testid="workbench-ppt-handoff">
        <div className="flex items-center gap-2">
          <MonitorPlay size={18} style={{ color: 'var(--accent-primary)' }} />
          <p className="text-[15px] font-semibold text-token-primary">同一份资料，做成一套可翻页的幻灯片</p>
        </div>
        <div className="rounded-xl p-3 text-[13px]" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
          {handoff.ok ? (
            <>
              <p className="text-token-primary">会带过去：知识库《{handoff.carriedTitle}》和你写的要求</p>
              {handoff.leftBehind.length > 0 && (
                <p className="mt-1.5 text-[12px]" style={{ color: 'var(--semantic-warning-text)' }}>
                  一次只能带一篇稿子，下面这些要在 PPT 智能体里用 + 再放一次：{handoff.leftBehind.join('、')}
                </p>
              )}
            </>
          ) : (
            <p className="text-token-secondary">{handoff.blocker}</p>
          )}
        </div>
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-2.5 text-[13px] text-token-secondary">
              <span
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              >
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="text-[12px] text-token-muted">{HTML_PPT_TIMING_NOTE}</p>
        <button
          type="button"
          onClick={onOpenBlank}
          className="inline-flex h-9 w-fit items-center gap-1.5 rounded-lg px-3 text-[12px] text-token-secondary transition-colors hover-bg-soft"
          style={{ border: '1px solid var(--border-default)' }}
        >
          不带资料，直接打开 PPT 智能体
          <ArrowUpRight size={13} />
        </button>
      </div>
    </PreviewPanel>
  );
}
