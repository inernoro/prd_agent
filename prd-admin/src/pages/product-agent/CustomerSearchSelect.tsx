import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import { ItemMultiSearchSelect } from '@/components/ItemMultiSearchSelect';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { createCustomer } from '@/services/real/productAgent';
import { toCustomerOptions } from './comboboxOptions';
import { readRecentCustomerIds, touchRecentCustomerIds } from './customerRecentStorage';
import type { Customer } from './types';

export function CustomerSearchSelect({
  value,
  onChange,
  customers,
  onCustomerCreated,
  uiSize = 'sm',
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  customers: Customer[];
  onCustomerCreated?: (customer: Customer) => void;
  uiSize?: 'sm' | 'md';
}) {
  const [recentIds, setRecentIds] = useState(() => readRecentCustomerIds());
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [creating, setCreating] = useState(false);
  const [quickError, setQuickError] = useState('');

  const options = useMemo(() => toCustomerOptions(customers), [customers]);

  const handleChange = (ids: string[]) => {
    onChange(ids);
    if (ids.length > 0) {
      touchRecentCustomerIds(ids);
      setRecentIds(readRecentCustomerIds());
    }
  };

  const quickCreate = async () => {
    const name = quickName.trim();
    if (!name) return setQuickError('请输入客户名称');
    setCreating(true);
    setQuickError('');
    const res = await createCustomer({ name });
    setCreating(false);
    if (!res.success || !res.data) {
      setQuickError(res.error?.message ?? '创建客户失败');
      return;
    }
    onCustomerCreated?.(res.data);
    const nextIds = value.includes(res.data.id) ? value : [...value, res.data.id];
    handleChange(nextIds);
    setQuickName('');
    setQuickOpen(false);
  };

  return (
    <div className="flex items-start gap-1.5 w-full">
      <div className="flex-1 min-w-0">
        <ItemMultiSearchSelect
          value={value}
          onChange={handleChange}
          options={options}
          placeholder="搜索客户名称..."
          countUnit="个"
          uiSize={uiSize}
          priorityIds={recentIds}
          emptyText="暂无客户，可点右侧 + 快速新建"
        />
      </div>
      <button
        type="button"
        title="快速新建客户"
        aria-label="快速新建客户"
        onClick={() => { setQuickOpen(true); setQuickName(''); setQuickError(''); }}
        className="shrink-0 flex items-center justify-center w-8 h-8 rounded-[8px] border border-white/12 bg-white/[0.04] text-white/55 hover:text-cyan-200 hover:border-cyan-500/35 hover:bg-cyan-500/10 transition-colors"
      >
        <Plus size={15} />
      </button>

      {quickOpen && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45" onClick={() => setQuickOpen(false)}>
          <div
            className="rounded-xl border border-white/10 bg-[#16181d] w-[min(400px,92vw)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <span className="text-sm font-medium text-white">快速新建客户</span>
              <button type="button" onClick={() => setQuickOpen(false)} className="text-white/40 hover:text-white"><X size={16} /></button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-white/55">客户名称</label>
                <input
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  placeholder="输入客户名称"
                  autoFocus
                  className="w-full h-9 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25 no-focus-ring"
                  onKeyDown={(e) => { if (e.key === 'Enter') void quickCreate(); }}
                />
              </div>
              {quickError && <div className="text-xs text-red-300/90">{quickError}</div>}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10">
              <button type="button" onClick={() => setQuickOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">取消</button>
              <button
                type="button"
                onClick={() => void quickCreate()}
                disabled={creating || !quickName.trim()}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30 disabled:opacity-40"
              >
                {creating ? <MapSpinner size={14} /> : null}
                创建并选中
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
