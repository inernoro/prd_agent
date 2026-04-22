import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, X, Monitor } from 'lucide-react';
import { resolveMobileCompat, type MobileCompatLevel } from '@/lib/mobileCompatibility';

interface Props {
  pathname: string;
}

const DISMISS_KEY = 'map.mobile-compat-dismissed.v1';

function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function writeDismissed(set: Set<string>) {
  try {
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

/**
 * 移动端兼容性门槛 —— 只在 isMobile 视口下由 AppShell 渲染。
 *
 *  - `full` 或无注册：不渲染
 *  - `limited`：顶部黄色细 banner（非阻断）
 *  - `pc-only`：中央半透明提示卡 + 继续 / 复制链接；已关闭过的路由本会话内不再提示
 */
export function MobileCompatGate({ pathname }: Props) {
  const entry = useMemo(() => resolveMobileCompat(pathname), [pathname]);
  const level: MobileCompatLevel | null = entry?.level ?? null;
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());
  const [bannerClosed, setBannerClosed] = useState(false);

  // 路由切换时清掉 banner 关闭状态（每个新路由都重新显示）
  useEffect(() => {
    setBannerClosed(false);
  }, [pathname]);

  const dismissPcOnly = () => {
    const next = new Set(dismissed);
    next.add(pathname);
    setDismissed(next);
    writeDismissed(next);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = window.location.href;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  if (!level) {
    // 未注册：给一条非常轻的提示条，仅出现一次
    return null;
  }

  if (level === 'full') return null;

  if (level === 'limited') {
    if (bannerClosed) return null;
    return (
      <div
        className="mb-3 flex items-start gap-2 px-3 py-2 rounded-xl"
        style={{
          background: 'rgba(251, 191, 36, 0.10)',
          border: '1px solid rgba(251, 191, 36, 0.25)',
          color: 'rgba(255, 236, 179, 0.95)',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <AlertTriangle size={14} style={{ color: '#FBBF24', marginTop: 2, flexShrink: 0 }} />
        <div className="flex-1">
          <span>移动端部分功能受限。</span>
          {entry?.note && <span style={{ opacity: 0.85 }}> {entry.note}</span>}
        </div>
        <button
          type="button"
          aria-label="关闭提示"
          onClick={() => setBannerClosed(true)}
          className="shrink-0 p-1 rounded hover:bg-white/10"
          style={{ color: 'rgba(255, 236, 179, 0.7)' }}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  // pc-only：全屏门槛
  if (dismissed.has(pathname)) return null;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center px-5"
      style={{ background: 'rgba(8, 8, 12, 0.82)', backdropFilter: 'blur(8px)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-5"
        style={{
          background: 'rgba(22, 22, 28, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          color: 'var(--text-primary, #f7f7fb)',
          boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div className="flex items-start gap-3 mb-3">
          <div
            className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(248, 113, 113, 0.18)' }}
          >
            <Monitor size={20} style={{ color: '#f87171' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold mb-1">此页面建议在 PC 上使用</div>
            <div className="text-[13px] opacity-75 leading-relaxed">
              {entry?.note || '该功能依赖大屏幕 / 鼠标拖拽，移动端体验不佳。'}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            type="button"
            onClick={dismissPcOnly}
            className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all active:scale-95"
            style={{ background: 'rgba(129, 140, 248, 0.22)', color: '#c7d2fe' }}
          >
            继续浏览
          </button>
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] transition-all active:scale-95"
            style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-primary)' }}
          >
            <Copy size={13} /> 复制链接
          </button>
        </div>
        <div className="mt-3 text-center text-[11px]" style={{ color: 'var(--text-muted, rgba(255,255,255,0.45))' }}>
          复制链接后在 PC 浏览器打开即可
        </div>
      </div>
    </div>
  );
}
