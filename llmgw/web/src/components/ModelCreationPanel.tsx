import { useEffect, useRef, useState } from 'react';
import { createLogicalModel, createModelOffering, getModels, getPlatforms, getUpstreamModels, importUpstreamModels } from '@/lib/api';
import type { ExchangeItem, ExchangeOptionItem, LogicalModelItem, ModelItem, PlatformItem, UpstreamModelItem } from '@/lib/types';
import { Button, InlineAlert, SectionLoader } from '@/components/ui';
import { FormGrid, HelpPopover } from '@/components/PageShell';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT } from '@/lib/typography';

const IMAGE_CAPABILITIES = ['image_generation', 'text2img', 'img2img', 'vision_generation'];

/** 同一个创建入口完成自定义命名、上游登记与首次绑定，不额外生成同型号公开模型。 */
export function ModelCreationPanel({ models, exchanges, modelTypes, onCreated, onCancel }: {
  models: ModelItem[]; exchanges: ExchangeItem[]; modelTypes: ExchangeOptionItem[];
  onCreated: (item: LogicalModelItem, needsBinding: boolean) => void; onCancel: () => void;
}) {
  const [mode, setMode] = useState<'custom' | 'upstream'>('custom');
  const [platforms, setPlatforms] = useState<PlatformItem[]>([]);
  const [source, setSource] = useState('');
  const [discovered, setDiscovered] = useState<UpstreamModelItem[]>([]);
  const [wire, setWire] = useState('');
  const [name, setName] = useState('');
  const [publicId, setPublicId] = useState('');
  const [modelType, setModelType] = useState('generation');
  const [identityKind, setIdentityKind] = useState<'stable' | 'fixed'>('fixed');
  const [capabilities, setCapabilities] = useState(IMAGE_CAPABILITIES.join(', '));
  const [allowedCallers, setAllowedCallers] = useState('');
  const [aliases, setAliases] = useState('');
  const submitting = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<LogicalModelItem | null>(null);
  useEffect(() => { void getPlatforms().then(res => {
    if (res.success) setPlatforms(res.data.items.filter(item => item.authority === 'llm_gateway' && item.enabled));
    else setError(res.error?.message || '读取上游失败，请重试。');
  }).catch(() => setError('上游清单未读到，请检查网络后重试。')); }, []);
  const [kind, sourceId = ''] = source.split(':');
  const exchange = kind === 'exchange' ? exchanges.find(item => item.id === sourceId) : undefined;
  const available = kind === 'platform' ? [...new Set([
    ...models.filter(item => item.platformId === sourceId).map(item => item.modelName),
    ...discovered.map(item => item.modelId),
  ])] : (exchange?.models.filter(item => item.enabled).map(item => item.modelId) ?? []);

  function chooseWire(value: string) {
    setWire(value);
    if (!name || name === wire) setName(value);
    if (!publicId || publicId === wire.replaceAll('/', '-')) setPublicId(value.replaceAll('/', '-'));
  }

  async function discover() {
    if (!sourceId || kind !== 'platform') return;
    setBusy('正在读取上游型号清单'); setError(null);
    try {
      const result = await getUpstreamModels(sourceId);
      if (result.success) setDiscovered(result.data.items);
      else setError(result.error?.message || '未读到型号清单，请选择已登记型号或稍后重试。');
    } catch { setError('型号清单未读到，请检查网络后重试。'); }
    finally { setBusy(null); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError(null);
    if (!modelTypes.some(item => item.value === modelType)) { setError('请选择当前支持的用途。'); return; }
    if (mode === 'upstream' && (!sourceId || !available.includes(wire))) { setError('请选择上游及其已登记或返回的实际型号。'); return; }
    submitting.current = true; setBusy('正在登记模型');
    try {
      let targetId = sourceId;
      if (mode === 'upstream' && kind === 'platform') {
        let physical = models.find(item => item.platformId === sourceId && item.modelName === wire);
        if (!physical) {
          const selected = discovered.find(item => item.modelId === wire)!;
          const imported = await importUpstreamModels(sourceId, [{
            modelId: wire, capabilities: modelType === 'generation' ? IMAGE_CAPABILITIES : [modelType],
            allowOutsideCatalog: !selected.inCatalog,
            inputPricePerMillion: selected.inputPricePerMillion, outputPricePerMillion: selected.outputPricePerMillion,
            pricePerCall: selected.pricePerCall, priceCurrency: selected.priceCurrency,
          }], { publishToWhitelist: false });
          if (!imported.success) throw new Error(imported.error?.message || '上游型号登记失败。');
          const fresh = await getModels({ platformId: sourceId, enabled: true });
          physical = fresh.success ? fresh.data.items.find(item => item.modelName === wire && item.platformId === sourceId) : undefined;
        }
        if (!physical) throw new Error('上游型号尚未读回，未创建重复模型，请重试。');
        targetId = physical.id;
      }
      let logical = created;
      if (!logical) {
        const result = await createLogicalModel({ name: name.trim(), publicId: publicId.trim(), modelType,
          identityKind, capabilities: capabilities.split(',').map(value => value.trim()).filter(Boolean),
          ...(identityKind === 'stable' ? { aliases: aliases.split(/\r?\n/).map(value => value.trim()).filter(Boolean) } : {}),
          routingStrategy: 'priority', allowedAppCallerCodes: allowedCallers.split(',').map(value => value.trim()).filter(Boolean) });
        if (!result.success) throw new Error(result.error?.message || '创建模型失败。');
        logical = result.data; setCreated(logical);
      }
      if (mode === 'custom') { onCreated(logical, true); return; }
      setBusy('正在绑定所选上游');
      const binding = await createModelOffering(logical.id, {
        targetKind: kind === 'exchange' ? 'exchange' : 'model', targetId, upstreamModelId: wire, priority: 100,
      });
      if (!binding.success) throw new Error(`模型已创建，上游绑定未完成：${binding.error?.message || '请重试绑定。'}`);
      onCreated({ ...logical, offerings: [...logical.offerings, binding.data] }, false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '创建未完成，请核对后重试。'); }
    finally { submitting.current = false; setBusy(null); }
  }

  return <form onSubmit={event => void submit(event)} aria-label="新建模型">
    <div className="lg-model-create-mode"><Button type="button" size="sm" variant={mode === 'custom' ? 'primary' : 'ghost'} disabled={Boolean(created) || Boolean(busy)} onClick={() => setMode('custom')}>自定义创建</Button><Button type="button" size="sm" variant={mode === 'upstream' ? 'primary' : 'ghost'} disabled={Boolean(created) || Boolean(busy)} onClick={() => setMode('upstream')}>从上游登记</Button></div>
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    {mode === 'upstream' ? <FormGrid>
      <label style={FIELD_LABEL}><span>选择上游</span><select required value={source} disabled={Boolean(created) || Boolean(busy)} onChange={event => { setSource(event.target.value); setDiscovered([]); setWire(''); }} style={FIELD_INPUT}><option value="">请选择已配置上游</option><optgroup label="Provider">{platforms.map(item => <option key={item.id} value={`platform:${item.id}`}>{item.name}</option>)}</optgroup><optgroup label="协议适配器">{exchanges.map(item => <option key={item.id} value={`exchange:${item.id}`}>{item.name} · {item.transformerType}</option>)}</optgroup></select></label>
      <label style={FIELD_LABEL}><span>上游实际型号</span><input required value={wire} list="create-upstream-models" disabled={Boolean(created) || Boolean(busy)} onChange={event => chooseWire(event.target.value)} placeholder="搜索或选择上游返回的型号" style={FIELD_INPUT}/><datalist id="create-upstream-models">{available.map(value => <option key={value} value={value}/>)}</datalist></label>
      {kind === 'platform' ? <Button type="button" size="sm" disabled={Boolean(busy) || !sourceId} onClick={() => void discover()}>读取上游型号</Button> : null}
    </FormGrid> : null}
    <FormGrid>
      <label style={FIELD_LABEL}><span>模型名称</span><input required maxLength={120} value={name} disabled={Boolean(created) || Boolean(busy)} onChange={event => setName(event.target.value)} placeholder="自由命名，例如「我的画师」" style={FIELD_INPUT}/></label>
      <label style={FIELD_LABEL}><span>公开标识<HelpPopover label="公开标识">用于 API 和 MCP 的稳定标识，须在组织内唯一。显示名称可以自定义。</HelpPopover></span><input required value={publicId} disabled={Boolean(created) || Boolean(busy)} onChange={event => setPublicId(event.target.value)} placeholder="例如 studio-image" style={FIELD_INPUT}/></label>
      <label style={FIELD_LABEL}><span>模型用途</span><select aria-label="模型用途" value={modelType} disabled={Boolean(created) || Boolean(busy) || !modelTypes.length} onChange={event => { const next = event.target.value; setModelType(next); if (capabilities === IMAGE_CAPABILITIES.join(', ') || !capabilities) setCapabilities(next === 'generation' ? IMAGE_CAPABILITIES.join(', ') : ''); }} style={FIELD_INPUT}>{modelTypes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    </FormGrid>
    <details><summary style={HINT_TEXT}>更多设置</summary><label style={FIELD_LABEL}><span>版本方式</span><select aria-label="模型身份" value={identityKind} disabled={Boolean(created) || Boolean(busy)} onChange={event => setIdentityKind(event.target.value as 'stable' | 'fixed')} style={FIELD_INPUT}><option value="stable">稳定标识，支持后续升级</option><option value="fixed">固定版本</option></select></label>{identityKind === 'stable' ? <label style={FIELD_LABEL}><span>兼容旧标识</span><textarea aria-label="兼容旧标识（可选，一行一个）" value={aliases} disabled={Boolean(created) || Boolean(busy)} onChange={event => setAliases(event.target.value)} style={{...FIELD_INPUT,height:'auto'}} rows={3}/></label> : null}<label style={FIELD_LABEL}><span>能力，逗号分隔</span><input value={capabilities} disabled={Boolean(created) || Boolean(busy)} onChange={event => setCapabilities(event.target.value)} style={FIELD_INPUT}/></label><label style={FIELD_LABEL}><span>允许的 appCaller</span><input value={allowedCallers} disabled={Boolean(created) || Boolean(busy)} onChange={event => setAllowedCallers(event.target.value)} style={FIELD_INPUT}/></label></details>
    {busy ? <SectionLoader text={busy}/> : null}
    <div className="lg-model-create-actions"><Button type="button" size="sm" disabled={Boolean(busy)} onClick={onCancel}>取消</Button><Button type="submit" size="sm" variant="primary" disabled={Boolean(busy) || !modelTypes.length}>{created ? '继续绑定' : mode === 'custom' ? '创建并绑定上游' : '登记并绑定上游'}</Button></div>
  </form>;
}
