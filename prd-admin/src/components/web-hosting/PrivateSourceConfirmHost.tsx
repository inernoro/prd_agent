import { useEffect, useId } from 'react';
import { FileLock2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import {
  buildPrivateSourceHeadline,
  describePrivateSourceLocation,
  usePrivateSourceConfirmStore,
} from './privateSourceConfirm';

/**
 * 发布前私有资料确认层的唯一宿主（和 SystemDialogHost 同一层级挂载）。
 *
 * 同一时刻只有一个宿主在渲染：先挂上的认领，其余的静默让位，避免两处都挂时弹出两层。
 * 没有任何宿主的页面由 requestPrivateSourceConfirmation 退回浏览器原生确认框，不会悬空。
 *
 * 颜色全部走 token（双主题成立），列表区限高滚动，375px 宽度下标题与资料名都能换行不溢出。
 */
/** 确认层的层级：高于 AnchoredMenu 的 9999，见 privateSourceConfirm.test.ts 的守卫。 */
export const PRIVATE_SOURCE_CONFIRM_Z_INDEX = 10000;

export function PrivateSourceConfirmHost() {
  const id = useId();
  const hostId = usePrivateSourceConfirmStore((s) => s.hostId);
  const current = usePrivateSourceConfirmStore((s) => s.current);
  const claimHost = usePrivateSourceConfirmStore((s) => s.claimHost);
  const releaseHost = usePrivateSourceConfirmStore((s) => s.releaseHost);
  const settle = usePrivateSourceConfirmStore((s) => s.settle);

  useEffect(() => {
    claimHost(id);
    return () => releaseHost(id);
  }, [id, claimHost, releaseHost]);

  if (hostId !== id) return null;
  const report = current?.report;
  const items = report?.items ?? [];

  return (
    <Dialog
      open={!!current}
      // 必须压过 AnchoredMenu（fixed z-[9999]）：确认层常从卡片的「分享」下拉里弹出，
      // 层级低于它时下拉会盖住确认层一半、后果句被截断（2026-09-24 预览视觉验收发现）。
      zIndex={PRIVATE_SOURCE_CONFIRM_Z_INDEX}
      tone="danger"
      maxWidth={520}
      onOpenChange={(next) => {
        // 点 X / Esc / 遮罩一律视为取消：不确认就不发出去。
        if (!next && current) settle('cancel');
      }}
      title="发布前确认私有资料"
      content={
        !current ? null : (
          <div className="grid gap-3 min-w-0" data-private-source-confirm="open">
            <div
              className="rounded-[6px] px-3 py-2 text-[13px] leading-[1.7]"
              style={{
                background: 'var(--semantic-warning-soft)',
                border: '1px solid var(--semantic-warning-border)',
                color: 'var(--text-primary)',
                overflowWrap: 'anywhere',
              }}
            >
              {buildPrivateSourceHeadline(items.length)}。
            </div>
            <ul
              className="grid gap-1.5 max-h-[44vh] overflow-y-auto overscroll-contain"
              aria-label="本页引用的私有资料"
            >
              {items.map((item) => (
                <li
                  key={item.entryId}
                  className="flex items-start gap-2 rounded-[6px] px-3 py-2 min-w-0"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
                >
                  <FileLock2 size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--semantic-warning-text)' }} />
                  <div className="min-w-0">
                    <div
                      className="text-[13px] font-medium leading-[1.5]"
                      style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}
                    >
                      {item.title}
                    </div>
                    <div
                      className="text-[12px] leading-[1.5]"
                      style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}
                    >
                      {describePrivateSourceLocation(item)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[12px] leading-[1.6]" style={{ color: 'var(--text-secondary)' }}>
              确认后会记下是谁、在什么时候确认了这些资料。不想公开的话，可以先回去改掉引用这些资料的内容。
            </p>
          </div>
        )
      }
      actions={
        !current ? null : (
          <div className="flex flex-wrap justify-end gap-2 w-full">
            {current.allowRevise && (
              <Button variant="ghost" onClick={() => settle('revise')}>
                返回修改
              </Button>
            )}
            <Button variant="secondary" onClick={() => settle('cancel')}>
              取消
            </Button>
            <Button autoFocus variant="danger" onClick={() => settle('confirm')}>
              确认{current.actionLabel}
            </Button>
          </div>
        )
      }
    />
  );
}

export default PrivateSourceConfirmHost;
