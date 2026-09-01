import * as React from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { useSystemDialogStore } from '@/lib/systemDialog';

/**
 * alert / confirm / prompt 三态的宿主。控制台形态下三者共用同一套骨架：
 * 标题 → 正文 → （prompt 多一个输入）→ 贴底动作条。
 *
 * 正文放宽到 13px / 行高 1.85：控制台的密度纪律用在按钮和边距上是对的，
 * 用在连着读六七行的告警正文上就反过来伤可读性（这是方向 A 自己写明的弱档）。
 */
function MessageBlock({ message }: { message: string }) {
  return (
    <div
      className="text-[13px] leading-[1.85]"
      style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
    >
      {message}
    </div>
  );
}

export function SystemDialogHost() {
  const current = useSystemDialogStore((s) => s.current);
  const closeAlert = useSystemDialogStore((s) => s.closeAlert);
  const closeConfirm = useSystemDialogStore((s) => s.closeConfirm);
  const closePrompt = useSystemDialogStore((s) => s.closePrompt);

  const [promptValue, setPromptValue] = React.useState('');
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (current?.kind === 'prompt') {
      setPromptValue(String(current.defaultValue ?? ''));
    }
  }, [current?.kind === 'prompt' ? current.title : null, current?.kind === 'prompt' ? current.message : null]);

  const open = !!current;
  const isDanger = current?.tone === 'danger';

  const confirmVariant = isDanger ? 'danger' : 'primary';

  return (
    <Dialog
      open={open}
      zIndex={500}
      tone={isDanger ? 'danger' : 'default'}
      onOpenChange={(nextOpen) => {
        // 统一：用户点 X / Esc / 点遮罩关闭时，视为取消
        if (nextOpen) return;
        if (!current) return;
        if (current.kind === 'alert') closeAlert();
        else if (current.kind === 'confirm') closeConfirm(false);
        else closePrompt(null);
      }}
      title={current?.title || '提示'}
      description={undefined}
      maxWidth={460}
      actions={
        !current ? null : current.kind === 'alert' ? (
          <Button variant={confirmVariant} onClick={() => closeAlert()}>
            {current.confirmText}
          </Button>
        ) : current.kind === 'confirm' ? (
          <>
            <Button variant="secondary" onClick={() => closeConfirm(false)}>
              {current.cancelText}
            </Button>
            <Button autoFocus variant={confirmVariant} onClick={() => closeConfirm(true)}>
              {current.confirmText}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => closePrompt(null)}>
              {current.cancelText}
            </Button>
            <Button variant={confirmVariant} onClick={() => closePrompt(promptValue)}>
              {current.confirmText}
            </Button>
          </>
        )
      }
      content={
        !current ? null : (
          <div className="grid gap-3">
            <MessageBlock message={current.message} />
            {current.kind === 'prompt' && (
              <input
                autoFocus
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={current.placeholder}
                className="w-full h-[34px] rounded-[6px] px-[10px] text-[13px] outline-none"
                style={{
                  background: 'var(--dialog-input-bg)',
                  // 聚焦描边走 inset box-shadow 而不是 border：换 border 颜色会让
                  // 输入框在聚焦瞬间跳 1px（border-width 不变但渲染舍入会变），inset 不会。
                  boxShadow: `inset 0 0 0 1px ${focused ? 'var(--border-focus)' : 'var(--dialog-border)'}`,
                  color: 'var(--text-primary)',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    closePrompt(promptValue);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closePrompt(null);
                  }
                }}
              />
            )}
          </div>
        )
      }
    />
  );
}
