import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { listMonthlyWeeklyCandidates } from '@/services';
import type { MonthlyWeeklyCandidate, WeeklyCandidateGroup } from '@/services/contracts/reportAgentMonthly';
import { formatWeekDateRange } from '../utils/weekRange';
import { WEEKLY_GROUP_LABELS, formatYearMonth } from './monthlyMeta';

const GROUP_ORDER: WeeklyCandidateGroup[] = ['current', 'adjacent', 'other'];

/**
 * 关联周报选择框：列出我在本团队的周报，按「周四归属」分组（分组由后端算好）。
 * 草稿周报置灰不可选——负责人点进链接不该看到半成品。
 */
export function WeeklyLinkPicker({
  teamId,
  year,
  month,
  selectedIds,
  onConfirm,
  onClose,
}: {
  teamId: string;
  year: number;
  month: number;
  selectedIds: string[];
  onConfirm: (ids: string[], picked: MonthlyWeeklyCandidate[]) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MonthlyWeeklyCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selectedIds));

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await listMonthlyWeeklyCandidates({ teamId, year, month });
      if (!alive) return;
      if (res.success && res.data) setItems(res.data.items);
      else {
        setItems([]);
        setError(res.error?.message || '周报列表加载失败');
      }
    })();
    return () => {
      alive = false;
    };
  }, [teamId, year, month]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grouped = useMemo(() => {
    const map: Record<WeeklyCandidateGroup, MonthlyWeeklyCandidate[]> = { current: [], adjacent: [], other: [] };
    for (const it of items ?? []) map[it.group].push(it);
    for (const g of GROUP_ORDER) map[g].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    return map;
  }, [items]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllCurrent = () => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const it of grouped.current) if (it.linkable) next.add(it.weeklyReportId);
      return next;
    });
  };

  const confirm = () => {
    // 保留已关联但不在候选里的（例如周报已被删除），由作者在编辑页自行移除
    const ids = [...picked];
    onConfirm(ids, (items ?? []).filter((it) => picked.has(it.weeklyReportId)));
  };

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'var(--modal-overlay)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col rounded-2xl"
        style={{
          width: 'min(560px, 94vw)',
          height: 'min(640px, 86vh)',
          maxHeight: '86vh',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="关联周报"
        data-testid="weekly-link-picker"
      >
        <div className="shrink-0 flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <div>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>关联周报</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {formatYearMonth(year, month)} · 一周按它的周四落在哪个月归入哪个月，也可以勾选其他周
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover-bg-soft" aria-label="关闭">
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        <div className="flex-1 px-5 py-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {items === null ? (
            <MapSectionLoader text="正在加载你的周报…" />
          ) : error ? (
            <div className="text-[12px] py-6 text-center" style={{ color: 'var(--accent-fg-error)' }}>{error}</div>
          ) : items.length === 0 ? (
            <div className="text-[12px] py-10 text-center leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              你在这个团队还没有周报。<br />没关系，可以直接在下方文字框里写本月成果。
            </div>
          ) : (
            GROUP_ORDER.filter((g) => grouped[g].length > 0).map((g) => (
              <div key={g} className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    {WEEKLY_GROUP_LABELS[g]}
                  </div>
                  {g === 'current' && grouped.current.some((it) => it.linkable) && (
                    <button type="button" className="text-[11px] px-1.5 py-0.5 rounded hover-bg-soft" style={{ color: 'var(--accent-fg-info)' }} onClick={selectAllCurrent}>
                      全选本月
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {grouped[g].map((it) => {
                    const checked = picked.has(it.weeklyReportId);
                    return (
                      <button
                        key={it.weeklyReportId}
                        type="button"
                        disabled={!it.linkable}
                        onClick={() => toggle(it.weeklyReportId)}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg text-left"
                        style={{
                          background: checked ? 'var(--status-going-soft)' : 'var(--bg-secondary)',
                          border: `1px solid ${checked ? 'var(--status-going-border)' : 'transparent'}`,
                          opacity: it.linkable ? 1 : 0.55,
                          cursor: it.linkable ? 'pointer' : 'not-allowed',
                        }}
                        data-testid="weekly-candidate"
                      >
                        <span
                          className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                          style={{
                            border: `1px solid ${checked ? 'var(--status-going)' : 'var(--border-default)'}`,
                            background: checked ? 'var(--status-going)' : 'transparent',
                          }}
                        >
                          {checked && <Check size={11} style={{ color: 'var(--accent-on-solid)' }} />}
                        </span>
                        <span className="text-[13px] font-medium shrink-0" style={{ color: 'var(--text-primary)' }}>
                          W{String(it.weekNumber).padStart(2, '0')}
                        </span>
                        <span className="text-[12px] flex-1 min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>
                          {formatWeekDateRange({ weekYear: it.weekYear, weekNumber: it.weekNumber })}
                        </span>
                        <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {it.linkable ? '已提交' : '草稿，先提交周报'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>已选 {picked.size} 份</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
            <Button variant="primary" size="sm" onClick={confirm} disabled={items === null}>确定</Button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
