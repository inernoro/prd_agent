// 模型编辑抽屉。
//
// 在此之前模型建完就改不了——后端连 PUT 端点都没有，只能删了重建，而重建会丢掉池成员绑定。
// 于是没人敢动，价格要么一直空着（OpenAI 官方清单根本不返回价格），要么一直是半年前那个数。
//
// 这一屏解决的是同一件事的两头：能改，以及改完知道影响谁。最下面「生效范围」那块是后者——
// 真正参与计费的是模型池成员里的那份价格，只改档案不同步，线上会继续按旧价跑。
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { getModelPoolUsage, updateModel } from '@/lib/api';
import type { ModelItem, ModelPoolUsageData, UpdateModelRequest } from '@/lib/types';
import { Button, Chip, InlineAlert } from '@/components/ui';
import { GAP } from '@/lib/surface';
import { FIELD_INPUT, FIELD_LABEL, SECTION_TITLE } from '@/lib/typography';

/** 价格来源的人话标签与配色。说不出来源的价格是没有根的，界面上必须看得出来。 */
export const PRICE_SOURCE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  upstream: { label: '上游返回', color: '#38bdf8', bg: 'rgba(56,189,248,0.12)' },
  admin: { label: '人工录入', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  migrated: { label: '历史换算', color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' },
};

type Props = {
  model: ModelItem;
  onClose: () => void;
  onSaved: (updated: ModelItem) => void;
};

export function ModelPricingDrawer({ model, onClose, onSaved }: Props) {
  const [name, setName] = useState(model.name || '');
  const [maxTokens, setMaxTokens] = useState(model.maxTokens != null ? String(model.maxTokens) : '');
  const [remark, setRemark] = useState(model.remark || '');
  const [inputPrice, setInputPrice] = useState(numText(model.inputPricePerMillion));
  const [outputPrice, setOutputPrice] = useState(numText(model.outputPricePerMillion));
  const [cachedInputPrice, setCachedInputPrice] = useState(numText(model.cachedInputPricePerMillion));
  const [cacheWritePrice, setCacheWritePrice] = useState(numText(model.cacheWritePricePerMillion));
  const [pricePerCall, setPricePerCall] = useState(numText(model.pricePerCall));
  const [usage, setUsage] = useState<ModelPoolUsageData | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [syncPoolIds, setSyncPoolIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getModelPoolUsage(model.id).then((res) => {
      if (!alive) return;
      if (!res.success) { setUsageError(res.error?.message || '读取模型池引用失败'); return; }
      setUsage(res.data);
      // 默认只勾继承的：覆盖价是有人特意设的，不该被一次改档案价顺手抹掉。
      setSyncPoolIds(res.data.pools.filter((p) => p.inherits && !p.managed).map((p) => p.poolId));
    });
    return () => { alive = false; };
  }, [model.id]);

  const pricingTouched = useMemo(
    () => [inputPrice, outputPrice, cachedInputPrice, cacheWritePrice, pricePerCall].some((x) => x.trim().length > 0),
    [inputPrice, outputPrice, cachedInputPrice, cacheWritePrice, pricePerCall],
  );

  const staleNotice = model.priceStale && model.priceAgeDays != null
    ? `这份价格已经 ${model.priceAgeDays} 天没复核了`
    : model.priceStale ? '这份价格没有观测时间，无从判断还能不能信' : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    const req: UpdateModelRequest = {
      name: name.trim() || undefined,
      maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
      remark,
      syncPoolIds,
    };
    if (pricingTouched) {
      req.inputPricePerMillion = optionalNumber(inputPrice);
      req.outputPricePerMillion = optionalNumber(outputPrice);
      req.cachedInputPricePerMillion = optionalNumber(cachedInputPrice);
      req.cacheWritePricePerMillion = optionalNumber(cacheWritePrice);
      req.pricePerCall = optionalNumber(pricePerCall);
      // 计价口径只有美金一种，界面上没有可选项，这里也就不给第二种可能。
      req.priceCurrency = 'USD';
    }
    const res = await updateModel(model.id, req);
    setSaving(false);
    if (!res.success) { setError(res.error?.message || '保存失败'); return; }
    onSaved(res.data);
  };

  const syncablePools = usage?.pools.filter((p) => !p.managed) ?? [];

  return createPortal(
    <div className="lg-side-drawer-portal">
      <button className="lg-side-drawer-backdrop" type="button" aria-label="关闭" onClick={onClose} />
      <aside className="lg-side-drawer" role="dialog" aria-modal="true" aria-label="编辑模型">
        <header className="lg-side-drawer-header">
          <div className="lg-side-drawer-title">
            <div><small>编辑模型</small><h2>{model.modelName}</h2></div>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="lg-side-drawer-body">
          {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}

          <div style={SECTION_TITLE}>基本信息</div>
          <label style={FIELD_LABEL}>显示名<input value={name} onChange={(e) => setName(e.target.value)} style={FIELD_INPUT} /></label>
          <label style={FIELD_LABEL}>最大输出 token<input type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} style={FIELD_INPUT} placeholder="留空表示不限制" /></label>
          <label style={FIELD_LABEL}>备注<input value={remark} onChange={(e) => setRemark(e.target.value)} style={FIELD_INPUT} /></label>

          <div style={{ ...SECTION_TITLE, marginTop: GAP.section }}>计价 · 美金 / 百万 token</div>
          <label style={FIELD_LABEL}>输入<input type="number" min={0} step="any" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} style={FIELD_INPUT} /></label>
          <label style={FIELD_LABEL}>输出<input type="number" min={0} step="any" value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} style={FIELD_INPUT} /></label>
          <label style={FIELD_LABEL}>缓存读<input type="number" min={0} step="any" value={cachedInputPrice} onChange={(e) => setCachedInputPrice(e.target.value)} style={FIELD_INPUT} placeholder="留空按输入全价算" /></label>
          <label style={FIELD_LABEL}>缓存写<input type="number" min={0} step="any" value={cacheWritePrice} onChange={(e) => setCacheWritePrice(e.target.value)} style={FIELD_INPUT} placeholder="Anthropic 一类协议才用得上" /></label>
          <label style={FIELD_LABEL}>每次调用固定费<input type="number" min={0} step="any" value={pricePerCall} onChange={(e) => setPricePerCall(e.target.value)} style={FIELD_INPUT} placeholder="按次计费的模型才填" /></label>
          <p style={hintStyle}>
            缓存价留空不等于免费，计价时按输入全价算：宁可高估催人来补，也不低估放大真实开销——限额靠的就是这个数。
          </p>

          <div style={{ ...SECTION_TITLE, marginTop: GAP.section }}>来源与时效</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
            {model.priceSource && PRICE_SOURCE_LABELS[model.priceSource] ? (
              <Chip
                label={PRICE_SOURCE_LABELS[model.priceSource].label}
                color={PRICE_SOURCE_LABELS[model.priceSource].color}
                bg={PRICE_SOURCE_LABELS[model.priceSource].bg}
              />
            ) : (
              <Chip label="没有来源可考" color="var(--warn)" bg="var(--warn-bg)" />
            )}
            <span style={hintStyle}>
              {model.priceObservedAt ? `观测于 ${model.priceObservedAt.slice(0, 16).replace('T', ' ')}` : '没有观测时间'}
              {model.priceUpdatedBy ? ` · ${model.priceUpdatedBy}` : ''}
            </span>
          </div>
          {staleNotice ? <InlineAlert tone="info">{staleNotice}</InlineAlert> : null}
          <p style={hintStyle}>改动任一价格后，来源会记成「人工录入」，观测时间刷成此刻。</p>

          <div style={{ ...SECTION_TITLE, marginTop: GAP.section }}>生效范围</div>
          {usageError ? <InlineAlert tone="error">{usageError}</InlineAlert> : null}
          {usage && usage.pools.length === 0 ? (
            <p style={hintStyle}>还没有模型池引用这条模型，改价只影响档案本身。</p>
          ) : null}
          {syncablePools.map((pool) => (
            <label key={pool.poolId} style={poolRowStyle}>
              <input
                type="checkbox"
                checked={syncPoolIds.includes(pool.poolId)}
                onChange={(e) => setSyncPoolIds((prev) => (
                  e.target.checked ? [...prev, pool.poolId] : prev.filter((x) => x !== pool.poolId)
                ))}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block' }}>{pool.poolName}</span>
                <span style={hintStyle}>
                  {pool.inherits
                    ? '继承档案价'
                    : `用了覆盖价${pool.priceUpdatedBy ? ` · 由 ${pool.priceUpdatedBy} 设定` : ''}`}
                </span>
              </span>
              {pool.inherits
                ? <Chip label="继承" color="var(--text-secondary)" bg="var(--bg-elevated)" />
                : <Chip label="覆盖" color="var(--warn)" bg="var(--warn-bg)" />}
            </label>
          ))}
          {usage?.pools.some((p) => p.managed) ? (
            <p style={hintStyle}>托管的只追加池不接受从这里改价，已跳过。</p>
          ) : null}
          <p style={hintStyle}>不勾的池保留它自己的价格，并在模型池页面显示为「与档案价不同」。</p>
        </div>

        <div className="lg-side-drawer-footer">
          {/* 按钮一行排开，不允许换行 */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.tight, flexWrap: 'nowrap' }}>
            <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>取消</Button>
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中' : syncPoolIds.length > 0 ? `保存并同步 ${syncPoolIds.length} 个池` : '保存'}
            </Button>
          </span>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function numText(value?: number | null): string {
  return value == null ? '' : String(value);
}

function optionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const hintStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: 'var(--fs-caption)',
  lineHeight: 'var(--lh-body)',
};

const poolRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.normal,
  padding: 10,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  fontSize: 'var(--fs-body)',
};
