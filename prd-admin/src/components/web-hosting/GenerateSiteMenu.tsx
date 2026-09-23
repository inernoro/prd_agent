import { useRef, useState } from 'react';
import { ChevronDown, Library, Settings2, Sparkles, Upload } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import type { SiteGenerateSourceTab } from './SiteGenerateDialog';

/**
 * 网页托管工具条上的「生成网页」主按钮（设计稿 Main：位于「上传网页」旁）。
 * 下拉两项决定生成弹窗落在哪个页签；按钮旁的齿轮直达「网页生成设置」。
 */

const GENERATE_MENU_ITEMS: Array<{
  tab: SiteGenerateSourceTab;
  title: string;
  description: string;
  icon: typeof Library;
}> = [
  {
    tab: 'knowledge',
    title: '引用知识库',
    description: '从已有知识库挑一篇或几篇稿子，内容更新后可一键重生成',
    icon: Library,
  },
  {
    tab: 'upload',
    title: '直接上传文件',
    description: '拖入 Word、PDF、Markdown 或粘贴一段文字，就地生成',
    icon: Upload,
  },
];

export default function GenerateSiteMenu({ onChoose, onOpenSettings }: {
  onChoose: (tab: SiteGenerateSourceTab) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        ref={anchorRef}
        type="button"
        data-tour-id="webpages-generate-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg pl-3 pr-2.5 text-[13px] font-bold transition-shadow focus-visible:outline-none focus-visible:ring-2"
        style={{
          background: 'var(--accent-primary)',
          color: 'var(--accent-on-primary)',
          boxShadow: open ? '0 0 0 3px rgba(var(--accent-primary-rgb), 0.25)' : undefined,
        }}
      >
        <Sparkles size={15} />
        生成网页
        <ChevronDown size={13} strokeWidth={2.4} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      <button
        type="button"
        title="网页生成设置"
        aria-label="网页生成设置"
        data-tour-id="webpages-generate-settings"
        onClick={onOpenSettings}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover-bg-soft"
        style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
      >
        <Settings2 size={15} />
      </button>
      {open && (
        <AnchoredMenu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          align="right"
          gap={8}
          minWidth={340}
          style={{ padding: 8, width: 340 }}
        >
          <div role="menu" aria-label="生成网页的素材来源" className="flex flex-col gap-1">
            {GENERATE_MENU_ITEMS.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.tab}
                  type="button"
                  role="menuitem"
                  onClick={() => { setOpen(false); onChoose(item.tab); }}
                  className="flex gap-3 rounded-xl p-3 text-left transition-colors hover-bg-soft"
                  style={index === 0 ? { background: 'rgba(var(--accent-primary-rgb), 0.10)' } : undefined}
                >
                  <span
                    className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px]"
                    style={index === 0
                      ? { background: 'var(--selection-bg)', color: 'var(--accent-primary)' }
                      : { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                  >
                    <Icon size={18} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[14px] font-bold text-token-primary">{item.title}</span>
                    <span className="text-[12px] leading-relaxed text-token-secondary">{item.description}</span>
                  </span>
                </button>
              );
            })}
            <div className="mx-2 my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onOpenSettings(); }}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-token-muted transition-colors hover-bg-soft"
            >
              <Settings2 size={13} />网页生成设置：默认方式、风格与提示词
            </button>
          </div>
        </AnchoredMenu>
      )}
    </div>
  );
}
