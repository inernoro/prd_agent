import { Plus, X } from 'lucide-react';

export interface PartnerDraft {
  name: string;
  reason: string;
}

const MAX_PARTNERS = 3;
const NAME_MAX = 30;
const REASON_MAX = 500;

/**
 * 第三章（选填）：手写伙伴名字 + 多行理由，最多 3 位。
 * 默认只有一个「添加伙伴」按钮，加一位才出现一行，保持版面简洁。
 */
export function PartnerSlots({
  value,
  onChange,
  placeholder,
}: {
  value: PartnerDraft[];
  onChange: (next: PartnerDraft[]) => void;
  placeholder: string;
}) {
  const update = (index: number, patch: Partial<PartnerDraft>) =>
    onChange(value.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));
  const add = () => onChange([...value, { name: '', reason: '' }]);

  return (
    <div className="flex flex-col gap-2" data-testid="partner-slots">
      {value.map((p, i) => {
        const missingName = !p.name.trim() && !!p.reason.trim();
        return (
          <div
            key={i}
            className="rounded-xl px-3 py-2.5 flex flex-col gap-1.5"
            style={{
              background: 'var(--bg-secondary)',
              border: `1px solid ${missingName ? 'var(--accent-fg-error)' : 'var(--border-primary)'}`,
            }}
          >
            <div className="flex items-center gap-2">
              <input
                className="flex-1 min-w-0 text-[13px] font-medium px-2.5 py-1.5 rounded-lg"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                value={p.name}
                maxLength={NAME_MAX}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="伙伴名字"
                data-testid="partner-name"
              />
              <button type="button" onClick={() => remove(i)} className="p-1 rounded hover-bg-soft shrink-0" aria-label="移除这位伙伴">
                <X size={14} style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>
            <textarea
              className="w-full text-[13px] leading-relaxed px-2.5 py-1.5 rounded-lg resize-y"
              style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              rows={2}
              value={p.reason}
              maxLength={REASON_MAX}
              onChange={(e) => update(i, { reason: e.target.value })}
              placeholder={placeholder}
              data-testid="partner-reason"
            />
            {missingName && <div className="text-[11px]" style={{ color: 'var(--accent-fg-error)' }}>写了理由，也请写上名字</div>}
          </div>
        );
      })}
      {value.length < MAX_PARTNERS && (
        <button
          type="button"
          onClick={add}
          className="self-start inline-flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-lg hover-bg-soft"
          style={{ color: 'var(--text-secondary)', border: '1px dashed var(--border-default)' }}
          data-testid="partner-add"
        >
          <Plus size={13} /> 添加伙伴{value.length > 0 ? `（还可以写 ${MAX_PARTNERS - value.length} 位）` : ''}
        </button>
      )}
    </div>
  );
}
