import { Check, Image, Info, Paintbrush, ScanEye, Sprout, Sun, Zap, type LucideIcon } from 'lucide-react';
import type { VisualAgentModelOption } from '@/pages/ai-chat/visualAgentModelOptions';

// 图标是展示映射；名称、说明、默认与恢复资格始终来自服务端业务目录。
const MODEL_ICON_REGISTRY: Record<string, LucideIcon> = {
  'gpt-image-2': Paintbrush,
  'gpt-image-2-all': Paintbrush,
  'gpt-image-2.5-sunburst': Sun,
  'gemini-3.1-flash-image-preview': Zap,
  'gemini-3-pro-image-preview': ScanEye,
  'doubao-seedream-4-5-251128': Sprout,
};

export function VisualModelIcon({ model, size = 18 }: { model?: Pick<VisualAgentModelOption, 'modelName'> | null; size?: number }) {
  const Icon = MODEL_ICON_REGISTRY[model?.modelName ?? ''] ?? Image;
  return <Icon size={size} aria-hidden="true" className="shrink-0" />;
}

export function VisualModelOptionContent({ model, selected = false }: { model: VisualAgentModelOption; selected?: boolean }) {
  const status = !model.enabled
    ? '暂时无法生成，请选其他模型'
    : model.isRecoveryProbeAvailable ? '正在恢复，可以尝试生成' : '';
  return <div className="flex items-start gap-3 w-full min-w-0">
    <span className="flex items-center justify-center shrink-0 rounded-[10px] mt-0.5"
      style={{ width: 36, height: 36, background: selected ? 'var(--report-accent-soft)' : 'var(--bg-secondary)', color: selected ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
      <VisualModelIcon model={model} size={21} />
    </span>
    <span className="flex flex-col gap-1 min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{model.name || model.modelName}</span>
        {model.isDefault && <span className="text-[10px] rounded px-1.5 py-0.5 shrink-0" style={{ background: 'var(--report-accent-soft)', color: 'var(--accent-primary)' }}>默认</span>}
        {status && <span className="text-[10px] rounded px-1.5 py-0.5 shrink-0" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{model.enabled ? '恢复中' : '暂不可用'}</span>}
      </span>
      <span className="text-[11px] leading-[15px]" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{model.modelName}</span>
      {model.description && <span className="text-[12px] leading-[18px] whitespace-normal" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{model.description}</span>}
      {status && <span className="text-[11px] leading-[16px]" style={{ color: 'var(--text-secondary)' }}>{status}</span>}
      {!status && model.subtitle && <span className="text-[10px] leading-[15px]" style={{ color: 'var(--text-muted)' }}>{model.subtitle}</span>}
    </span>
    <span className="shrink-0 pt-0.5" style={{ width: 18, color: 'var(--accent-primary)' }}>
      {selected && <Check size={17} aria-label="当前选中" />}
    </span>
  </div>;
}

export function VisualModelMenuHeading({ onClose }: { onClose?: () => void }) {
  return <div className="flex items-start justify-between gap-3 px-3 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border-default)' }}>
    <div className="min-w-0">
      <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>选择绘图模型</div>
      <div className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>不知道选哪个？先试默认模型</div>
    </div>
    {onClose && <button type="button" onClick={onClose} aria-label="关闭模型菜单" className="text-[12px] px-2 py-1 rounded hover-bg-soft" style={{ color: 'var(--text-secondary)' }}>关闭</button>}
  </div>;
}

export function VisualModelMenuHint() {
  return <div className="flex items-start gap-2 px-3 py-3 text-[11px] shrink-0" style={{ borderTop: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
    <Info size={14} aria-hidden="true" className="shrink-0 mt-0.5" />
    <span>先选模型，再选尺寸；也可以带参考图</span>
  </div>;
}
