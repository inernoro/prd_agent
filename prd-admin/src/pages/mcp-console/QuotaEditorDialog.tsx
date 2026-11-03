import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { getLiteraryAgentAllModels, updateAgentApiKey } from '@/services';
import type { McpClientDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';

const LIMITS = {
  image: { min: 1, max: 500, label: '每日生图张数' },
  write: { min: 1, max: 2000, label: '每日写入次数' },
  rate: { min: 1, max: 600, label: '每分钟调用次数' },
} as const;

/**
 * 调整某把密钥的用量、模型和独立公开发布授权。
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
  onSaved: () => void | Promise<void>;
}) {
  const [image, setImage] = useState('');
  const [write, setWrite] = useState('');
  const [rate, setRate] = useState('');
  const [modelMode, setModelMode] = useState<'follow-user-panel' | 'fixed'>('follow-user-panel');
  const [fixedModel, setFixedModel] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [webPublicExposureAllowed, setWebPublicExposureAllowed] = useState(false);
  const sessionRef = useRef(0);
  const canEnableWebPublicExposure = client?.scopes.some((scope) => scope.toLowerCase() === 'web-pages:write') ?? false;

  useEffect(() => {
    sessionRef.current += 1;
    setSaving(false);
    return () => { sessionRef.current += 1; };
  }, [client?.keyId, open]);

  const changeOpen = (next: boolean) => {
    if (!next) sessionRef.current += 1;
    onOpenChange(next);
  };

  useEffect(() => {
    if (!client || !open) return;
    setImage(String(client.dailyImageQuota));
    setWrite(String(client.dailyWriteQuota));
    setRate(String(client.rateLimitPerMin));
    setModelMode(client.mcpLiteraryImageModelMode === 'fixed' ? 'fixed' : 'follow-user-panel');
    setFixedModel(client.mcpLiteraryImageModelPublicId || '');
    setWebPublicExposureAllowed(client.webPublicExposureAllowed === true);
  }, [client, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setModelsLoading(true);
    void getLiteraryAgentAllModels()
      .then((res) => {
        if (cancelled || !res.success || !res.data) return;
        const text = new Set(res.data.text2img.pools.map((pool) => pool.code).filter(Boolean));
        const both = res.data.img2img.pools
          .map((pool) => pool.code)
          .filter((code) => code && text.has(code));
        setModelOptions(Array.from(new Set(both)));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

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
    const modelSettingsChanged = modelMode !== (client.mcpLiteraryImageModelMode ?? 'follow-user-panel')
      || (modelMode === 'fixed' && fixedModel !== (client.mcpLiteraryImageModelPublicId ?? ''));
    if (modelSettingsChanged && modelMode === 'fixed' && !fixedModel) {
      toast.error('请选择模型', '固定模式必须选择一个文生图与图生图都可用的模型');
      return;
    }

    setSaving(true);
    const session = sessionRef.current;
    const res = await updateAgentApiKey({
      id: client.keyId,
      ...parsed,
      ...(modelSettingsChanged ? {
        mcpLiteraryImageModelMode: modelMode,
        mcpLiteraryImageModelPublicId: modelMode === 'fixed' ? fixedModel : undefined,
      } : {}),
      ...(webPublicExposureAllowed === (client.webPublicExposureAllowed === true)
        ? {}
        : { webPublicExposureAllowed }),
    });
    if (!res.success) {
      if (session !== sessionRef.current) return;
      setSaving(false);
      toast.error('保存失败', res.error?.message);
      return;
    }
    // 列表读回后再关闭：否则立即重开会把旧客户端快照重新写进开关。
    await onSaved();
    if (session !== sessionRef.current) return;
    setSaving(false);
    toast.success('客户端设置已更新');
    changeOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="调整客户端设置"
      description={client ? `这把钥匙：${client.name}（${client.keyPrefix}…）` : undefined}
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

          <div className="mt-1 flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <label className="flex items-start gap-2 text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <input
                type="checkbox"
                checked={webPublicExposureAllowed}
                disabled={saving || (!webPublicExposureAllowed && !canEnableWebPublicExposure)}
                onChange={(event) => setWebPublicExposureAllowed(event.target.checked)}
                aria-describedby="mcp-web-public-exposure-hint"
              />
              <span>允许这台客户端对外发布网页</span>
            </label>
            <p id="mcp-web-public-exposure-hint" className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              允许公开或登录可见分享、永久分享与续期，以及更新已对外分享的站点内容。默认关闭，自动授权不会开启。
            </p>
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              关闭后只阻止后续发布；已有分享链接请在网页托管中撤销。
            </p>
            {!canEnableWebPublicExposure && !webPublicExposureAllowed && (
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                需先授予网页托管写入权限，才能开启对外发布。
              </p>
            )}
          </div>

          <div className="mt-1 flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              文学配图模型
            </span>
            <label className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="radio"
                checked={modelMode === 'follow-user-panel'}
                onChange={() => setModelMode('follow-user-panel')}
              />
              <span>
                跟随用户面板
                <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  使用这把密钥绑定用户在文学创作中的选择；用户没选时使用当时的系统默认。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="radio"
                checked={modelMode === 'fixed'}
                onChange={() => setModelMode('fixed')}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                固定模型
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  网页切换模型不会影响这台客户端；模型不可用时明确失败，不会静默换模型。
                </span>
                {modelMode === 'fixed' && (
                  <select
                    value={fixedModel}
                    disabled={modelsLoading}
                    onChange={(e) => setFixedModel(e.target.value)}
                    className="h-9 rounded-[9px] px-2.5 text-[12px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <option value="">{modelsLoading ? '正在读取模型目录' : '选择模型'}</option>
                    {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                )}
              </span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => changeOpen(false)}
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
