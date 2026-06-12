import { Check, Download, Globe } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface NextStepBarProps {
  /** 点击「发布为网页」 */
  onPublish: () => void;
  /** 发布请求进行中 */
  publishBusy: boolean;
  /** 已发布则发布按钮显示「已发布」弱化态（仍可再点重新发布） */
  published: boolean;
  /** 点击「下载 HTML」 */
  onDownload: () => void;
  /** 把精修建议填入输入框（不自动发送，用户确认后再发） */
  onSeedPatch: (text: string) => void;
}

// 精修建议 chip：点击 seed 到输入框，借鉴 open-design NextStepActions 的「建议不代发」原则
const PATCH_SUGGESTIONS: { label: string; seed: string }[] = [
  { label: '标题更有冲击力', seed: '把第1页标题改得更有冲击力' },
  { label: '配色更商务', seed: '整体配色换成更商务沉稳的风格' },
  { label: '加一页总结', seed: '在最后加一页要点总结' },
];

/**
 * 生成完成后的「下一步」引导条。
 * 横向 slim bar：左侧精修建议 chip（seed 输入框），右侧下载 / 发布动作。
 */
export function NextStepBar(props: NextStepBarProps): JSX.Element {
  const { onPublish, publishBusy, published, onDownload, onSeedPatch } = props;

  return (
    <div
      data-testid="next-step-bar"
      className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-white/8 bg-white/2"
      style={{ minHeight: 34 }}
    >
      <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">下一步</span>

      {/* 精修建议：点击填入输入框，不自动发送 */}
      {PATCH_SUGGESTIONS.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => onSeedPatch(s.seed)}
          title={`填入输入框：${s.seed}`}
          className="text-[10px] text-[var(--text-secondary)] bg-white/4 border border-white/8 rounded-md px-2 py-0.5 hover:bg-purple-500/10 hover:border-purple-500/30 hover:text-[var(--text-primary)] transition-colors shrink-0"
        >
          {s.label}
        </button>
      ))}

      <div className="ml-auto flex items-center gap-2 shrink-0">
        {/* 下载 HTML */}
        <button
          type="button"
          onClick={onDownload}
          className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] bg-white/5 border border-white/8 rounded-md px-2 py-1 hover:bg-white/10 hover:text-[var(--text-primary)] transition-colors"
        >
          <Download size={12} />
          下载 HTML
        </button>

        {/* 发布为网页：busy 显示 spinner；已发布显示弱化态但仍可再点 */}
        <button
          type="button"
          onClick={onPublish}
          disabled={publishBusy}
          className={`flex items-center gap-1 text-[10px] rounded-md px-2 py-1 border transition-colors ${
            published
              ? 'text-blue-400/70 bg-blue-500/10 border-blue-500/15 opacity-70 hover:opacity-100'
              : 'text-blue-400 bg-blue-500/15 border-blue-500/25 hover:bg-blue-500/25'
          } ${publishBusy ? 'cursor-wait opacity-80' : ''}`}
        >
          {publishBusy ? (
            <>
              <MapSpinner size={12} color="rgb(96 165 250)" />
              发布中...
            </>
          ) : published ? (
            <>
              <Check size={12} />
              已发布
            </>
          ) : (
            <>
              <Globe size={12} />
              发布为网页
            </>
          )}
        </button>
      </div>
    </div>
  );
}
