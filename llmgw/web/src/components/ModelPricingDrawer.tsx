// 模型编辑抽屉。
//
// 在此之前模型建完就改不了——后端连 PUT 端点都没有，只能删了重建，而重建会丢掉池成员绑定。
// 于是没人敢动，价格要么一直空着（OpenAI 官方清单根本不返回价格），要么一直是半年前那个数。
//
// 这一屏解决的是同一件事的两头：能改，以及改完知道影响谁。最下面「生效范围」那块是后者。
//
// 2026-09-15 断流之后「生效范围」换了主语：线上计费读的是**这个模型文档自己**的价格
// （运行时解析直接从物理模型取价，不再经过模型池）。下面那份池清单只剩一个用途——
// 万一要回滚到池路由，那几个池里的价还得是对的。所以它是**回滚备份**，不是计费依据；
// 原先那句「真正参与计费的是池成员里的那份价格」现在是假的，照着它去改池、以为改了线上账，
// 是白改一场（第 60 轮 review）。
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
      /*
        默认一个都不勾。

        断流之后这几个池不参与计费，替人预先勾上等于替他做了一个「顺手写一批过时数据」的决定，
        而界面还让他以为这是在改线上账。要回滚备份的人自己勾，勾的是明明白白的额外动作
        （原先默认勾继承的那几个，理由是「不该被顺手抹掉」——那条理由在池还计费时成立）。
      */
      setSyncPoolIds([]);
    });
    return () => { alive = false; };
  }, [model.id]);

  /*
    价格的判据是「动没动过」，不是「填没填」。

    这两件事此前被混作一谈，于是同一个 bug 长出两种形态：
      - 五个框全清空 → 判成「没动过」，一个价格字段都不发，旧价原样留着。
        过期价格在这个抽屉里根本删不掉，而界面显示保存成功。
      - 只改名字或备注 → 框里还摆着旧价，判成「动过」，于是把五个价原样重发一遍。
        服务端当成一次人工改价，把 PriceSource 改写成 admin、PriceObservedAt 刷成现在——
        一个从上游抓来的价被贴上「人刚填的」标签，而三十天后没人说得清它到底可不可信。

    正确判据只有一个：和进来时的初始值比，变了才发（形状 1：判据比它该管的范围窄，
    「清空」和「没碰」这两种输入都让它给出了相反答案）。
  */
  const initialPrices = useMemo(
    () => [
      numText(model.inputPricePerMillion),
      numText(model.outputPricePerMillion),
      numText(model.cachedInputPricePerMillion),
      numText(model.cacheWritePricePerMillion),
      numText(model.pricePerCall),
    ],
    [model],
  );
  const currentPrices = [inputPrice, outputPrice, cachedInputPrice, cacheWritePrice, pricePerCall];
  const pricingChanged = currentPrices.some((x, i) => x.trim() !== initialPrices[i].trim());
  const hasAnyPriceInput = currentPrices.some((x) => x.trim().length > 0);
  const clearPricing = pricingChanged && !hasAnyPriceInput;

  // 最大输出 token 同理：清空要发显式标志，否则那个字段被序列化省掉，
  // 服务端分不清「清空」与「这次没动它」，界面上「留空表示不限制」就兑现不了。
  const initialMaxTokens = model.maxTokens != null ? String(model.maxTokens) : '';
  const maxTokensChanged = maxTokens.trim() !== initialMaxTokens.trim();
  const clearMaxTokens = maxTokensChanged && maxTokens.trim().length === 0;

  const staleNotice = model.priceStale && model.priceAgeDays != null
    ? `这份价格已经 ${model.priceAgeDays} 天没复核了`
    : model.priceStale ? '这份价格没有观测时间，无从判断还能不能信' : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    const req: UpdateModelRequest = {
      name: name.trim() || undefined,
      remark,
      syncPoolIds,
    };
    if (clearMaxTokens) {
      req.clearMaxTokens = true;
    } else if (maxTokensChanged && maxTokens.trim()) {
      req.maxTokens = Number(maxTokens);
    }
    if (clearPricing) {
      req.clearPricing = true;
    } else if (pricingChanged) {
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
          {optionalNumber(pricePerCall) !== undefined ? (
            <p style={hintStyle}>
              填了「每次调用固定费」就只按次收费，上面那几个 token 单价不参与计价。
              两种价同时生效是另一种计费模式，这里不靠「两个字段都填了」去猜——真要那样，得先有一个明确的计费模式开关。
            </p>
          ) : null}

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
          <p style={hintStyle}>
            线上计费读的就是上面这份价——运行时解析直接从这条模型文档取价，保存即生效。
          </p>
          {usageError ? <InlineAlert tone="error">{usageError}</InlineAlert> : null}
          {usage && usage.pools.length === 0 ? null : (
            <>
              <div style={{ ...SECTION_TITLE, marginTop: GAP.section }}>回滚备份 · 旧模型池（不参与计费）</div>
              <p style={hintStyle}>
                模型池已经不在计费链路上，勾选只是把这份价也写进那几个池，留给「万一要回滚到池路由」那一天。
                不勾不影响线上任何一笔账。
              </p>
            </>
          )}
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
          {usage && usage.pools.length > 0 ? (
            <p style={hintStyle}>不勾的池保留它自己的价格，并在模型池页面显示为「与档案价不同」——这不影响计费。</p>
          ) : null}
        </div>

        <div className="lg-side-drawer-footer">
          {/* 按钮一行排开，不允许换行 */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.tight, flexWrap: 'nowrap' }}>
            <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>取消</Button>
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中' : syncPoolIds.length > 0 ? `保存并回写 ${syncPoolIds.length} 个旧池` : '保存'}
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
