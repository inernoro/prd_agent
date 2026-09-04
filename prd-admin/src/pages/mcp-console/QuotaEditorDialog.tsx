import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { updateAgentApiKey } from '@/services';
import type { McpClientDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';

const LIMITS = {
  image: { min: 1, max: 500, label: '每日生图张数' },
  write: { min: 1, max: 2000, label: '每日写入次数' },
  rate: { min: 1, max: 600, label: '每分钟调用次数' },
} as const;

/**
 * 调整某把密钥的用量上限。
 *
 * 存在的理由很直接：配额触顶时后端会提示「可以在密钥管理里调高」，
 * 没有这个入口那句提示就是一条走不通的路。
 */
export function QuotaEditorDialog({
  client,
  open,
  onOpenChange,
  onSaved,
}: {
  client: McpClientDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [image, setImage] = useState('');
  const [write, setWrite] = useState('');
  const [rate, setRate] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!client) return;
    setImage(String(client.dailyImageQuota));
    setWrite(String(client.dailyWriteQuota));
    setRate(String(client.rateLimitPerMin));
  }, [client]);

  const save = async () => {
    if (!client) return;
    const parsed = {
      mcpDailyImageQuota: Number(image),
      mcpDailyWriteQuota: Number(write),
      mcpRateLimitPerMin: Number(rate),
    };
    const checks: Array<[number, { min: number; max: number; label: string }]> = [
      [parsed.mcpDailyImageQuota, LIMITS.image],
      [parsed.mcpDailyWriteQuota, LIMITS.write],
      [parsed.mcpRateLimitPerMin, LIMITS.rate],
    ];
    for (const [value, limit] of checks) {
      if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
        toast.error('上限不合法', `${limit.label}需在 ${limit.min}-${limit.max} 之间`);
        return;
      }
    }

    setSaving(true);
    const res = await updateAgentApiKey({ id: client.keyId, ...parsed });
    setSaving(false);
    if (!res.success) {
      toast.error('保存失败', res.error?.message);
      return;
    }
    toast.success('上限已更新');
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="调整用量上限"
      description={client ? `这把钥匙：${client.name}` : undefined}
      maxWidth={440}
      content={
        <div className="flex flex-col gap-3.5">
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            上限是给智能体设的安全绳：它重试成本极低，没有上限时一个循环就能把当天的模型额度烧光。
            额度按 UTC 自然日重置。
          </p>

          <QuotaField label={LIMITS.image.label} hint="1-500" value={image} onChange={setImage} />
          <QuotaField label={LIMITS.write.label} hint="1-2000" value={write} onChange={setWrite} />
          <QuotaField label={LIMITS.rate.label} hint="1-600" value={rate} onChange={setRate} />

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-9 rounded-[10px] px-4 text-[13px] font-medium"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="h-9 rounded-[10px] px-4 text-[13px] font-semibold disabled:opacity-60"
              style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      }
    />
  );
}

function QuotaField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="flex-1 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
        <span className="ml-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </span>
      </span>
      <input
        value={value}
        inputMode="numeric"
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        className="h-8 w-[92px] rounded-[9px] px-2.5 text-right text-[13px] tabular-nums"
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      />
    </label>
  );
}
