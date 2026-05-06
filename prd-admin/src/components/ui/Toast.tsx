import { cn } from '@/lib/cn';
import { useToastStore, type Toast as ToastModel } from '@/lib/toast';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { glassToast } from '@/lib/glassStyles';

const icons = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

const colors = {
  success: {
    bg: 'rgba(34, 197, 94, 0.18)',
    border: 'rgba(34, 197, 94, 0.38)',
    icon: '#22c55e',
  },
  error: {
    bg: 'rgba(239, 68, 68, 0.18)',
    border: 'rgba(239, 68, 68, 0.38)',
    icon: '#ef4444',
  },
  info: {
    bg: 'rgba(59, 130, 246, 0.18)',
    border: 'rgba(59, 130, 246, 0.38)',
    icon: '#3b82f6',
  },
  warning: {
    bg: 'rgba(251, 146, 60, 0.18)',
    border: 'rgba(251, 146, 60, 0.38)',
    icon: '#fb923c',
  },
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: ToastModel }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const [isExiting, setIsExiting] = useState(false);

  const Icon = icons[toast.type];
  const color = colors[toast.type];

  useEffect(() => {
    // 提前 300ms 开始退出动画，与 duration 联动（store 里 setTimeout(remove, duration) 后退出）
    const exitDelay = Math.max(0, (toast.duration ?? 3000) - 300);
    const timer = setTimeout(() => {
      setIsExiting(true);
    }, exitDelay);

    return () => clearTimeout(timer);
  }, [toast.duration]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => {
      removeToast(toast.id);
    }, 300);
  };

  const handleActionClick = () => {
    try {
      toast.action?.onClick();
    } finally {
      handleClose();
    }
  };

  return (
    <div
      className={cn(
        'pointer-events-auto min-w-[320px] max-w-[420px] rounded-[16px] p-4 shadow-lg',
        'flex items-start gap-3 transition-all duration-300',
        isExiting ? 'opacity-0 translate-x-8' : 'opacity-100 translate-x-0'
      )}
      style={glassToast(color.bg, color.border)}
    >
      <Icon size={20} style={{ color: color.icon, flexShrink: 0, marginTop: 2 }} />

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[13px] text-white mb-1">{toast.title}</div>
        {toast.message && (
          <div className="text-[12px] text-white/70 whitespace-pre-wrap">{toast.message}</div>
        )}
      </div>

      {toast.action && (
        <button
          onClick={handleActionClick}
          className="flex-shrink-0 px-2.5 h-7 rounded-lg text-[12px] font-medium hover:bg-white/10 transition-colors"
          style={{ color: color.icon, border: `1px solid ${color.border}` }}
        >
          {toast.action.label}
        </button>
      )}

      <button
        onClick={handleClose}
        className="flex-shrink-0 p-1 rounded-lg hover:bg-white/10 transition-colors"
        aria-label="关闭"
      >
        <X size={14} style={{ color: 'rgba(255,255,255,0.6)' }} />
      </button>
    </div>
  );
}
