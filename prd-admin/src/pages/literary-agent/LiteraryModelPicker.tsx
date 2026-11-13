import type { ReactNode } from 'react';
import { PopupButton, QuickMenu, QuickMenuEmpty, QuickMenuItem } from './LiteraryQuickMenu';
import type { LiteraryModelOption } from './literaryModelOptions';

/** 模型沿用工作台弹出按钮的中性外观，完整身份保留在悬停说明和菜单中。 */
export function LiteraryModelPicker({ label, icon, model, options, open, onOpenChange, onSelect }: {
  label: string;
  icon: ReactNode;
  model: LiteraryModelOption | null;
  options: LiteraryModelOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const title = `${label}模型`;
  // 紧凑按钮省略供应商前缀；请求仍使用原始模型身份。
  const value = model?.name.replace(/^[^/]+\//, '') || '选择模型';
  const prefix = (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
      {icon}
      {label}
    </span>
  );

  if (model?.isAutoResolved) {
    return (
      <div
        className="lqm-trigger"
        style={{ width: '100%', cursor: 'default' }}
        role="status"
        aria-label={`${title}：自动调度 ${model.name}`}
        title={`${title}：${model.name}（自动调度）`}
      >
        {prefix}
        <span className="lqm-trigger-value">{value}</span>
        <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>自动</span>
      </div>
    );
  }

  return (
    <QuickMenu
      title={title}
      width={280}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <PopupButton
          className="w-full"
          icon={prefix}
          value={value}
          isSet={!!model}
          title={`${title}：${model?.name || '尚未选择'}，点击切换`}
          aria-label={title}
        />
      }
    >
      {options.length === 0 ? <QuickMenuEmpty>暂无可用模型池</QuickMenuEmpty> : options.map((option) => (
        <QuickMenuItem
          key={option.id}
          label={option.name}
          description={option.isDefault ? '默认模型' : undefined}
          selected={model?.id === option.id}
          onSelect={() => onSelect(option.id)}
        />
      ))}
    </QuickMenu>
  );
}
