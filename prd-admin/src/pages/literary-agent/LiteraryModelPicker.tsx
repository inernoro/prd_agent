import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { QuickMenu, QuickMenuEmpty, QuickMenuItem } from './LiteraryQuickMenu';
import type { LiteraryModelOption } from './literaryModelOptions';

const shortName = (name: string) => name.replace(/^[^/]+\//, '');

/** 页面内展开模型列表；短型号与完整标识分层展示，请求身份保持不变。 */
export function LiteraryModelPicker({ label, icon, model, options, open, onOpenChange, onSelect, disabled = false, unavailable = false }: {
  label: string;
  icon: ReactNode;
  model: LiteraryModelOption | null;
  options: LiteraryModelOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  disabled?: boolean;
  unavailable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const visibleOptions = useMemo(() => options.filter(option => option.name.toLowerCase().includes(query.trim().toLowerCase())), [options, query]);
  const title = `${label}模型`;
  const value = model ? shortName(model.name) : unavailable ? '原模型不可用，请重选' : '选择模型';
  const detail = model?.isAutoResolved ? '自动调度'
    : model && value !== model.name ? model.name : model?.isDefault ? '系统默认' : model ? '当前使用' : unavailable ? '请从列表重新选择' : '尚未选择';
  const summary = (
    <>
      {icon}
      <span className="lit-model-label">{title}</span>
      <span className="lit-model-summary">
        <span className="lit-model-name">{value}</span>
        <span className="lit-model-detail">{detail}</span>
      </span>
    </>
  );

  if (model?.isAutoResolved) {
    return (
      <div className="lit-model-trigger lit-model-readonly" role="status"
        aria-label={`${title}：自动调度 ${model.name}`} title={`${title}：${model.name}（自动调度）`}>
        {summary}<span className="lit-model-auto">自动</span>
      </div>
    );
  }

  return (
    <QuickMenu inline title={title} open={open}
      onOpenChange={next => { if (!next) setQuery(''); onOpenChange(next); }}
      search={{ value: query, onChange: setQuery, placeholder: '搜索模型名称' }}
      trigger={
        <button type="button" disabled={disabled} className="lit-model-trigger" title={`${title}：${model?.name || value}，点击切换`} aria-label={title}>
          {summary}<ChevronDown size={15} className="lit-settings-chevron" aria-hidden />
        </button>
      }
    >
      {visibleOptions.length === 0 ? <QuickMenuEmpty>{options.length ? '未找到匹配模型' : '暂无可用模型池'}</QuickMenuEmpty> : visibleOptions.map((option, index) => (
        <QuickMenuItem key={option.id} label={shortName(option.name)}
          description={shortName(option.name) !== option.name ? option.name : undefined}
          trailing={option.isDefault ? '系统默认' : undefined}
          tabIndex={index === 0 ? 0 : -1}
          disabled={disabled}
          selected={model?.id === option.id} onSelect={() => onSelect(option.id)} />
      ))}
    </QuickMenu>
  );
}
