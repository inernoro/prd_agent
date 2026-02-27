import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as React from 'react';

import { Button } from '@/components/design/Button';
import { glassPanel } from '@/lib/glassStyles';

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
          className="rounded-[14px] p-3"
          style={{
            ...glassPanel,
            zIndex: 150,
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}





