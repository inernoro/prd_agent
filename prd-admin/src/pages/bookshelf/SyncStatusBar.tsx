/**
 * 「这次改动没同步上」的告知条 —— 桌面档与手机档共用这一份。
 *
 * 为什么必须共用：进度保存是静默的，失败只改一个 store 字段。桌面档画了这条，
 * 手机档没画——于是手机用户继续标已读、写心得、交卷，屏幕上全是打好的勾，
 * 而那些改动只在这台设备上；换台设备或退出登录就没了，中间一次提示都没有。
 * 这正是 `degradation-must-alarm` 说的那种铃：链路建了一半，删掉不会红
 * （`predicate-and-wiring-discipline` 形状 2），只有真实用户在另一台设备上才发现。
 *
 * 所以判据与文案收在这一个组件里，两套外观都渲染它，不许任一侧自己再写一份。
 */
import { CloudOff, RefreshCw } from 'lucide-react';
import { useBookshelfStore } from '@/stores/bookshelfStore';

const EDGE_THIN = '2.5px solid var(--shelf-edge)';

export function SyncStatusBar({ className = '' }: { className?: string }) {
  const syncState = useBookshelfStore((s) => s.syncState);
  const retrySync = useBookshelfStore((s) => s.retrySync);

  // 同步得上就不占地方：这条是异常态的告知，不是常驻状态栏。
  if (syncState !== 'failed' && syncState !== 'local') return null;

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 rounded-[16px] flex-wrap ${className}`}
      style={{ background: 'var(--shelf-surface)', border: EDGE_THIN }}
    >
      <CloudOff size={16} strokeWidth={2.6} style={{ color: 'var(--accent-fg-amber)' }} className="shrink-0" />
      <span className="text-[12.5px] font-bold">
        {syncState === 'failed' ? '本次改动没同步上，只存在这台设备' : '当前是本机记录，没连上服务端'}
      </span>
      <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
        {syncState === 'failed' ? '网络恢复或下次操作会自动重试' : '登录后进度会跨设备保留'}
      </span>
      {syncState === 'failed' && (
        <button
          type="button"
          onClick={() => { void retrySync(); }}
          className="ml-auto shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold transition-transform duration-150 hover:-translate-y-[1px]"
          style={{ background: 'var(--bg-base)', border: EDGE_THIN }}
        >
          <RefreshCw size={12} strokeWidth={2.8} />
          立即重试
        </button>
      )}
    </div>
  );
}
