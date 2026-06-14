import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X, Lock } from 'lucide-react';

/** 知识库 / 案例导入口令（团队内共享的软门槛，防误操作）。 */
export const IMPORT_PASSWORD = '090676';

/**
 * 导入口令校验弹窗：输入正确口令后才放行导入动作。
 * 纯前端软门槛——用于防止误导入，不作为安全边界。
 */
export function ImportPasswordModal({
  title = '导入口令',
  onConfirm,
  onClose,
}: {
  title?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    if (checking) return;
    if (value.trim() !== IMPORT_PASSWORD) {
      setError('口令不正确，无法导入');
      return;
    }
    setChecking(true);
    onConfirm();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[#0f1014] flex flex-col"
      >
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-white/10">
          <div className="text-sm font-medium text-white/90 inline-flex items-center gap-1.5">
            <Lock className="w-4 h-4 text-emerald-400" />
            {title}
          </div>
          <button onClick={onClose} className="p-1 rounded text-white/40 hover:text-white/80">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-2">
          <div className="text-xs text-white/55">导入知识库需要口令，请输入后继续。</div>
          <input
            ref={inputRef}
            type="password"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="请输入导入口令"
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
          />
          {error && <div className="text-xs text-rose-400">{error}</div>}
        </div>
        <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-white/10">
          <button onClick={onClose} className="px-3.5 py-1.5 rounded-lg text-sm text-white/70 hover:bg-white/5">
            取消
          </button>
          <button
            onClick={submit}
            disabled={checking || !value.trim()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-sm hover:bg-emerald-500/25 disabled:opacity-40"
          >
            {checking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            确认导入
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
