import { X } from 'lucide-react';
import { UserSearchSelect } from '@/components/UserSearchSelect';

export interface PartnerDraft {
  userId: string;
  userName?: string;
  reason: string;
}

const SLOT_COUNT = 3;
const REASON_MAX = 200;

/**
 * 第三章：固定 3 个位置，每个位置 = 选人 + 一句理由。
 * 选了自己 / 重复选人当场提示（权威校验在后端）。
 */
export function PartnerSlots({
  value,
  onChange,
  selfUserId,
  placeholder,
}: {
  value: PartnerDraft[];
  onChange: (next: PartnerDraft[]) => void;
  selfUserId?: string;
  placeholder: string;
}) {
  const slots: PartnerDraft[] = Array.from({ length: SLOT_COUNT }, (_, i) => value[i] ?? { userId: '', reason: '' });

  const update = (index: number, patch: Partial<PartnerDraft>) => {
    const next = slots.map((s, i) => (i === index ? { ...s, ...patch } : s));
    // 只把填了人的位置交出去，空位不占名额
    onChange(next.filter((s) => s.userId));
  };

  const clear = (index: number) => onChange(slots.filter((s, i) => i !== index && s.userId));

  return (
    <div className="flex flex-col gap-2" data-testid="partner-slots">
      {slots.map((slot, i) => {
        const isSelf = !!slot.userId && slot.userId === selfUserId;
        const isDup = !!slot.userId && slots.findIndex((s) => s.userId === slot.userId) !== i;
        const warn = isSelf ? '不能选择自己' : isDup ? '这位伙伴已经选过了' : null;
        return (
          <div
            key={i}
            className="rounded-xl p-3 flex flex-col gap-2"
            style={{
              background: 'var(--bg-secondary)',
              border: `1px solid ${warn ? 'var(--accent-fg-error)' : 'var(--border-primary)'}`,
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0"
                style={{ background: 'var(--status-going-soft)', color: 'var(--status-going)' }}
              >
                {i + 1}
              </span>
              <UserSearchSelect
                value={slot.userId}
                onChange={(userId) => update(i, { userId })}
                onSelectUser={(u) => update(i, { userId: u.userId, userName: u.displayName || u.username })}
                placeholder="搜索并选择一位伙伴"
                className="flex-1 min-w-0"
              />
              {slot.userId && (
                <button type="button" onClick={() => clear(i)} className="p-1 rounded hover-bg-soft shrink-0" aria-label="移除这位伙伴">
                  <X size={14} style={{ color: 'var(--text-muted)' }} />
                </button>
              )}
            </div>
            {slot.userId && (
              <input
                className="w-full text-[13px] px-3 py-2 rounded-lg"
                style={{ background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
                value={slot.reason}
                maxLength={REASON_MAX}
                onChange={(e) => update(i, { reason: e.target.value })}
                placeholder={placeholder}
              />
            )}
            {warn && <div className="text-[11px]" style={{ color: 'var(--accent-fg-error)' }}>{warn}</div>}
          </div>
        );
      })}
    </div>
  );
}
