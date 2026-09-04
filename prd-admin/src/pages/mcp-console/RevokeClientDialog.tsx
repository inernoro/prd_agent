import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { revokeAgentApiKey } from '@/services';
import type { McpClientDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';

/**
 * 断开一台接进来的客户端（作废它那把钥匙）。
 *
 * 为什么这个入口必须在接入台里：钥匙一旦泄露，或者某台客户端不用了，用户需要**立刻**
 * 让它调不动。而作废的操作原先只藏在另一个密钥管理页里，从接入台进来的人根本不知道
 * 那个页面存在——找不到，就只能眼看着一把带写入和花钱权限的钥匙活到 90 天期满。
 *
 * 做成一次确认而不是直接点就断：这是收不回来的动作，钥匙明文只在创建时给过一次，
 * 断了就得重新发一把、客户端那边也要重配。
 */
export function RevokeClientDialog({
  client,
  open,
  onOpenChange,
  onRevoked,
}: {
  client: McpClientDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!client || busy) return;
    setBusy(true);
    try {
      const res = await revokeAgentApiKey({ id: client.keyId });
      if (!res.success) {
        toast.error(res.error?.message || '断开失败，请稍后重试');
        return;
      }
      toast.success(`已断开「${client.name}」，这把钥匙立刻失效`);
      onOpenChange(false);
      onRevoked();
    } catch {
      toast.error('断开失败，请检查网络后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="断开这台客户端"
      description={client ? `这把钥匙：${client.name}` : undefined}
      maxWidth={440}
      content={
        <div className="flex flex-col gap-3">
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          断开之后，「{client?.name}」那把钥匙立刻失效，它再调任何工具都会被拒。
          已经做过的事不会被撤销，调用记录也照旧留着。
        </p>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--semantic-warning-text)' }}>
          这一步收不回来：钥匙明文只在创建那一次给过，断了就得重新发一把，客户端那边也要重新配一次。
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="h-8 cursor-pointer rounded-[9px] px-3 text-[12px] font-medium"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            先不断
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="h-8 cursor-pointer rounded-[9px] px-3 text-[12px] font-semibold"
            style={{
              background: 'var(--button-danger-bg)',
              border: '1px solid var(--button-danger-border)',
              color: 'var(--button-danger-fg)',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? '断开中…' : '确认断开'}
          </button>
        </div>
        </div>
      }
    />
  );
}
