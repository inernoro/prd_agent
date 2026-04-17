import { useState } from 'react';
import { EyeOff, Loader2, Check, AlertTriangle } from 'lucide-react';
import { retractPublicItem, type RetractDomain } from '@/services';

interface RetractButtonProps {
  domain: RetractDomain;
  /** 资源标识：多数领域是 id，skills 传 skillKey */
  itemKey: string;
  /** 展示给用户看的资源名（用于二次确认文案） */
  label: string;
  /** 撤回成功后回调，父组件可据此从列表中移除该项 */
  onRetracted: () => void;
}

/**
 * 公开页卡片上的「取消公开」按钮。
 * 仅在用户访问自己的公开页时渲染。
 * 点击后弹出二次确认悬浮气泡，避免误操作。
 */
export function RetractButton({ domain, itemKey, label, onRetracted }: RetractButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await retractPublicItem(domain, itemKey);
      if (res.success) {
        setDone(true);
        setTimeout(() => {
          onRetracted();
        }, 400);
      } else {
        setError(res.error?.message || '撤回失败');
      }
    } catch (err) {
      setError((err as Error).message || '撤回失败');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-100">
        <Check size={10} />
        已撤回
      </span>
    );
  }

  if (!confirmOpen) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setConfirmOpen(true);
        }}
        className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/35 px-1.5 py-0.5 text-[10px] text-white/75 backdrop-blur-sm transition-all hover:border-rose-400/40 hover:bg-rose-500/15 hover:text-rose-100"
        title="取消公开（变回私有）"
      >
        <EyeOff size={10} />
        取消公开
      </button>
    );
  }

  return (
    <div
      className="flex items-center gap-1 rounded-md border border-rose-400/40 bg-rose-950/60 px-2 py-1 text-[10px] text-rose-50 backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <AlertTriangle size={11} className="text-rose-300" />
      <span className="truncate max-w-[120px]">撤回「{label}」？</span>
      <button
        type="button"
        onClick={submit}
        disabled={loading}
        className="ml-1 inline-flex items-center gap-0.5 rounded border border-rose-300/40 bg-rose-500/30 px-1.5 py-0.5 text-[10px] font-medium hover:bg-rose-500/50 disabled:opacity-60"
      >
        {loading ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
        确认
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setConfirmOpen(false);
          setError(null);
        }}
        disabled={loading}
        className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/75 hover:bg-white/10"
      >
        取消
      </button>
      {error && <span className="ml-1 text-[9px] text-rose-200">{error}</span>}
    </div>
  );
}
