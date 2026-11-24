import { useEffect, useRef, useState } from 'react';
import { getGatewayAppCallers, getModelBindingProbe, startModelBindingProbe, type ModelBindingProbeView } from '@/lib/api';
import type { GatewayAppCaller, LogicalModelItem, ModelOfferingItem } from '@/lib/types';
import { Button, InlineAlert, SectionLoader } from '@/components/ui';
import { FormGrid, HelpPopover } from '@/components/PageShell';
import { UpstreamNetworkTest } from '@/components/UpstreamProxySettings';
import { useDialogs } from '@/components/ConfirmDialog';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT } from '@/lib/typography';

export function ModelOfferingTestPanel({ logical, offering, providerId }: { logical: LogicalModelItem; offering: ModelOfferingItem; providerId?: string | null }) {
  const { confirm } = useDialogs();
  const [callers, setCallers] = useState<GatewayAppCaller[]>([]);
  const [caller, setCaller] = useState('');
  const [budget, setBudget] = useState('0.10');
  const [view, setView] = useState<ModelBindingProbeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const generation = useRef(0);
  const sending = useRef(false);
  const uncertain = useRef(false);
  const revision = JSON.stringify([logical.publicId, logical.enabled, logical.capabilities, logical.allowedAppCallerCodes, offering.targetKind, offering.targetId, offering.upstreamModelId, offering.protocol, offering.endpointPath, offering.enabled]);
  const running = view?.status === 'pending' || view?.status === 'running';
  useEffect(() => {
    const current = ++generation.current;
    setBusy(true); setView(null); setError(null); uncertain.current = false;
    void Promise.all([getModelBindingProbe(logical.id, offering.id), (async () => {
      const items: GatewayAppCaller[] = [];
      for (let page = 1; ; page++) {
        const result = await getGatewayAppCallers({ page, pageSize: 100, requestType: logical.modelType });
        if (!result.success) throw new Error('caller-directory');
        items.push(...result.data.items);
        if (items.length >= result.data.total || result.data.items.length === 0) return items.filter(item =>
          ['discovered', 'configured', 'active'].includes(item.status?.trim().toLowerCase() || 'discovered')
          && (!logical.allowedAppCallerCodes?.length || logical.allowedAppCallerCodes.includes(item.appCallerCode)));
      }
    })()]).then(([result, items]) => {
      if (generation.current !== current) return;
      setCallers(items); setCaller(items[0]?.appCallerCode ?? '');
      if (result.success) setView(result.data); else setError(result.error?.message || '测试记录未读取，请刷新后重试。');
    }).catch(() => { if (generation.current === current) setError('测试记录或调用用途未读取，请检查网络后刷新。'); })
      .finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current++; };
  }, [logical.id, logical.modelType, offering.id, revision]);
  async function refresh() {
    const current = generation.current;
    try {
      const result = await getModelBindingProbe(logical.id, offering.id, view?.requestId || undefined);
      if (current !== generation.current) return;
      if (result.success) { setView(result.data); setError(null); if (result.data.requestId) uncertain.current = false; }
      else setError(result.error?.message || '测试结果未读取，请稍后刷新。');
    } catch { if (current === generation.current) setError('测试结果未读取，请检查网络后刷新。'); }
  }
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [running, view?.requestId, logical.id, offering.id]);
  useEffect(() => {
    if (!running && !busy) { setSeconds(0); return; }
    const start = Date.now(); const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running, busy]);
  async function run() {
    if (sending.current || running || uncertain.current || view?.status === 'unknown') return;
    sending.current = true;
    if (!await confirm({ title: '测试所选线路的真实产物？', description: `${logical.name} → ${offering.targetName || offering.upstreamModelId}\n固定这条线路，最多发送一次请求，预占 ${budget} 美元。聊天只要求回复 OK；图片使用已登记的小图规格。不会切到其他线路，也不会修改默认。`, confirmLabel: '执行一次服务测试' })) { sending.current = false; return; }
    sending.current = true; setBusy(true); setError(null);
    const current = generation.current;
    try {
      const result = await startModelBindingProbe(logical.id, offering.id, { clientRequestId: crypto.randomUUID(), appCallerCode: caller, maxCostUsd: Number(budget) });
      if (current !== generation.current) return;
      if (result.success) setView(result.data); else setError(result.error?.message || '服务测试未登记，请核对规格与预算。');
    } catch { if (current === generation.current) { uncertain.current = true; setError('提交结果尚未确认，请刷新测试记录核对；不会重复发送。'); } }
    finally { sending.current = false; if (current === generation.current) setBusy(false); }
  }
  const labels: Record<string, string> = { 'not-run': '未测试', pending: '等待执行', running: '测试中', succeeded: '服务验证通过', failed: '服务验证未通过', unknown: '结果待核对', stale: '配置已变化，待重新测试', expired: '测试已过期，请重新登记' };
  return <div className="lg-model-binding-test">
    <UpstreamNetworkTest kind={offering.targetKind === 'exchange' ? 'exchange' : 'platform'} id={offering.targetKind === 'exchange' ? offering.targetId : providerId || ''} disabled={!offering.enabled || offering.targetKind !== 'exchange' && !providerId} revision={`${offering.protocol}:${offering.endpointPath}:${offering.upstreamModelId}`} />
    <FormGrid>
      <label style={FIELD_LABEL}><span>已有调用用途</span><select aria-label="服务测试调用用途" value={caller} onChange={event => setCaller(event.target.value)} style={FIELD_INPUT} disabled={busy || running}>{!callers.length ? <option value="">没有可用调用用途</option> : null}{callers.map(item => <option key={item.id} value={item.appCallerCode}>{item.title || item.appCallerCode}</option>)}</select></label>
      <label style={FIELD_LABEL}><span>本次预算（美元）<HelpPopover label="测试预算">复用既有单次调用金额合同。尚未登记近期价格或安全规格的格式会在发送前拒绝；不能用预算代替供应商计费保证。</HelpPopover></span><input aria-label="服务测试预算" type="number" min="0.01" max="1" step="0.01" value={budget} onChange={event => setBudget(event.target.value)} style={FIELD_INPUT} disabled={busy || running}/></label>
    </FormGrid>
    <div className="lg-model-create-actions"><Button size="sm" variant="primary" disabled={busy || running || !caller || !offering.enabled || !(Number(budget) > 0 && Number(budget) <= 1) || uncertain.current || view?.status === 'unknown'} onClick={() => void run()}>测试真实产物</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>刷新测试记录</Button><span style={HINT_TEXT}>{view ? labels[view.status] || '状态待核对' : '正在读取测试记录'}</span></div>
    {busy || running ? <SectionLoader text={`${running ? '等待所选线路测试完成' : '正在读取或登记测试'} · ${seconds} 秒`}/> : null}
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    {view && view.status !== 'not-run' ? <InlineAlert tone={view.status === 'succeeded' ? 'ok' : running ? 'info' : 'error'}><strong>{labels[view.status] || view.status}</strong> · {view.message}{view.httpStatus ? ` · HTTP ${view.httpStatus}` : ''}<br/><span style={HINT_TEXT}>实际型号：{view.upstreamModelId || '待执行'} · 线路：{view.offeringId || offering.id} · 请求：{view.requestId}</span>{view.outputUrl ? <img src={view.outputUrl} alt="所选线路服务测试返回的真实图片" style={{display:'block',maxWidth:240,width:'100%',marginTop:8}}/> : null}</InlineAlert> : null}
  </div>;
}
