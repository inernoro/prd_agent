import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as React from 'react';

import { Button } from '@/components/design/Button';

export function ConfirmTip({
  children,
  title = '确认执行该操作？',
  description,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  disabled,
  side = 'top',
  align = 'center',
}: {
  children: React.ReactElement;
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  side?: DropdownMenu.DropdownMenuContentProps['side'];
  align?: DropdownMenu.DropdownMenuContentProps['align'];
}) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const handleConfirm = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={side}
          align={align}
          sideOffset={10}
          className="z-50 rounded-[14px] p-3"
          style={{
            background: 'rgba(15, 15, 18, 1)',
            border: '1px solid var(--border-default)',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
            minWidth: 240,
          }}
        >
          <div className="grid gap-2">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {title}
            </div>
            {description && (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {description}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={loading}
              >
                {cancelText}
              </Button>
              <Button variant="danger" size="sm" onClick={handleConfirm} disabled={loading}>
                {loading ? '处理中...' : confirmText}
              </Button>
            </div>
          </div>
          <DropdownMenu.Arrow
            className="fill-[color:var(--bg-elevated)]"
            style={{ filter: 'drop-shadow(0 1px 0 rgba(255,255,255,0.10))' }}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}





