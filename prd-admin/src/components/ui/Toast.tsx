import { cn } from '@/lib/cn';
import { useToastStore } from '@/lib/toast';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useEffect, useState } from 'react';

const icons = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

const colors = {
  success: {
    bg: 'rgba(34, 197, 94, 0.1)',
    border: 'rgba(34, 197, 94, 0.3)',
    icon: '#22c55e',
  },
  error: {
    bg: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.3)',
    icon: '#ef4444',
  },
  info: {
    bg: 'rgba(59, 130, 246, 0.1)',
    border: 'rgba(59, 130, 246, 0.3)',
    icon: '#3b82f6',
  },
  warning: {
    bg: 'rgba(251, 146, 60, 0.1)',
    border: 'rgba(251, 146, 60, 0.3)',
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

function ToastItem({ toast }: { toast: { id: string; type: 'success' | 'error' | 'info' | 'warning'; title: string; message?: string } }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const [isExiting, setIsExiting] = useState(false);

  const Icon = icons[toast.type];
  const color = colors[toast.type];

  useEffect(() => {
    // 提前 300ms 开始退出动画
    const timer = setTimeout(() => {
      setIsExiting(true);
    }, toast.type === 'error' ? 3700 : 2700);

    return () => clearTimeout(timer);
  }, [toast.type]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => {
      removeToast(toast.id);
    }, 300);
  };

  return (
    <div
      className={cn(
        'pointer-events-auto min-w-[320px] max-w-[420px] rounded-[16px] p-4 shadow-lg',
        'flex items-start gap-3 transition-all duration-300',
        isExiting ? 'opacity-0 translate-x-8' : 'opacity-100 translate-x-0'
      )}
      style={{
        background: color.bg,
        border: `1px solid ${color.border}`,
        backdropFilter: 'blur(12px)',
      }}
    >
      <Icon size={20} style={{ color: color.icon, flexShrink: 0, marginTop: 2 }} />
      
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[13px] text-white mb-1">{toast.title}</div>
        {toast.message && (
          <div className="text-[12px] text-white/70 whitespace-pre-wrap">{toast.message}</div>
        )}
      </div>

      <button
        onClick={handleClose}
        className="flex-shrink-0 p-1 rounded-lg hover:bg-white/10 transition-colors"
      >
        <X size={14} style={{ color: 'rgba(255,255,255,0.6)' }} />
      </button>
    </div>
  );
}
