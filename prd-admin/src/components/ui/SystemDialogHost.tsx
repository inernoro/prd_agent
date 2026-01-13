import * as React from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { useSystemDialogStore } from '@/lib/systemDialog';

function MessageBlock({ message }: { message: string }) {
  return (
    <div className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
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

  React.useEffect(() => {
    if (current?.kind === 'prompt') {
      setPromptValue(String(current.defaultValue ?? ''));
    }
  }, [current?.kind === 'prompt' ? current.title : null, current?.kind === 'prompt' ? current.message : null]);

  const open = !!current;

  return (
    <Dialog
      open={open}
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
      maxWidth={560}
      content={
        !current ? null : current.kind === 'alert' ? (
          <div className="grid gap-5">
            <MessageBlock message={current.message} />
            <div className="flex items-center justify-end gap-2">
              <Button variant={current.tone === 'danger' ? 'danger' : 'primary'} onClick={() => closeAlert()}>
                {current.confirmText}
              </Button>
            </div>
          </div>
        ) : current.kind === 'confirm' ? (
          <div className="grid gap-5">
            <MessageBlock message={current.message} />
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => closeConfirm(false)}>
                {current.cancelText}
              </Button>
              <Button variant={current.tone === 'danger' ? 'danger' : 'primary'} onClick={() => closeConfirm(true)}>
                {current.confirmText}
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-5">
            <MessageBlock message={current.message} />
            <input
              autoFocus
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={current.placeholder}
              className="w-full rounded-[14px] px-3 py-2 text-sm outline-none"
              style={{
                background: 'rgba(6, 6, 7, 1)',
                border: '1px solid var(--border-default)',
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
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => closePrompt(null)}>
                {current.cancelText}
              </Button>
              <Button
                variant={current.tone === 'danger' ? 'danger' : 'primary'}
                onClick={() => closePrompt(promptValue)}
              >
                {current.confirmText}
              </Button>
            </div>
          </div>
        )
      }
    />
  );
}




