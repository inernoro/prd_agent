import { Settings2, Sparkles } from 'lucide-react';

/**
 * 网页托管工具条上的「生成网页」主按钮（位于「上传网页」旁），旁边齿轮直达「网页生成设置」。
 *
 * 2026-09-24 起点一下直接打开生成工作台，不再先弹「引用知识库 / 直接上传」二选一：
 * 知识库、上传、粘贴纪要都是往同一个输入框里加资料（输入框左边的 +），不是互斥的入口。
 */
export default function GenerateSiteMenu({ onGenerate, onOpenSettings }: {
  onGenerate: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        data-tour-id="webpages-generate-primary"
        onClick={onGenerate}
        title="放资料、说要求，先看效果再生成；做好后可以接着改、发给客户"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-bold transition-shadow focus-visible:outline-none focus-visible:ring-2"
        style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-primary)' }}
      >
        <Sparkles size={15} />
        生成网页
      </button>
      <button
        type="button"
        title="网页生成设置：默认方式、风格与提示词"
        aria-label="网页生成设置"
        data-tour-id="webpages-generate-settings"
        onClick={onOpenSettings}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover-bg-soft"
        style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
      >
        <Settings2 size={15} />
      </button>
    </div>
  );
}
