import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCatalogEntries, getModelUpgrade, getModels, getPlatforms, runModelUpgradeAction, saveModelUpgradePolicy } from '@/lib/api';
import type { CatalogEntriesData, ModelItem, ModelUpgradeAction, ModelUpgradePhase, ModelUpgradePolicy, ModelUpgradeSuccessor, ModelUpgradeView } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { useDialogs } from '@/components/ConfirmDialog';
import { CollectionFacts, CollectionView } from '@/components/CollectionView';
import { capabilityLabel } from '@/components/ProviderSetup';
import { DetailsBlock, FormGrid } from '@/components/PageShell';
import { Button, Chip, InlineAlert, ReadOnlyNotice, SectionLoader, Spinner } from '@/components/ui';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, SECTION_TITLE } from '@/lib/typography';
import { GAP } from '@/lib/surface';

const PHASES: Record<ModelUpgradePhase, { label: string; tone: 'ok' | 'warn' | 'info'; running?: boolean }> = {
  idle: { label: '等待检查', tone: 'info' },
  checking: { label: '正在检查新版本', tone: 'info', running: true },
  candidate: { label: '发现候选版本', tone: 'info' },
  validating: { label: '正在验证候选版本', tone: 'info', running: true },
  validated: { label: '候选版本已验证', tone: 'ok' },
  blocked: { label: '已阻止升级', tone: 'warn' },
  promoting: { label: '正在切换版本', tone: 'info', running: true },
  promoted: { label: '已升级', tone: 'ok' },
  rolling_back: { label: '正在回滚', tone: 'info', running: true },
  rolled_back: { label: '已回滚', tone: 'ok' },
  failed: { label: '本次操作未完成', tone: 'warn' },
};
const VALIDATION_STATUS: Record<ModelUpgradeView['validationStatus'], string> = { 'not-run': '未执行', pending: '验证中', passed: '通过', failed: '未通过', unknown: '结果未知' };
const ACTIONS: Record<ModelUpgradeAction, string> = { check: '检查新版本', validate: '验证候选版本', promote: '采用候选版本', rollback: '回滚最近升级' };
const BUSY_LABELS: Record<string, string> = { ...ACTIONS, save: '正在保存策略', refresh: '正在读取状态' };
const HISTORY_ACTIONS: Record<string, string> = { check: '检查版本', validate: '验证候选', promote: '采用候选', rollback: '回滚升级', policy: '更新策略', policy_update: '更新策略', 'policy.update': '更新策略' };
const HISTORY_STATUS: Record<string, string> = { queued: '等待执行', running: '执行中', succeeded: '成功', success: '成功', completed: '已完成', failed: '未完成', blocked: '已阻止' };

export function ModelUpgradePanel({ logicalModelId, onRoutingChanged }: { logicalModelId: string; onRoutingChanged?: () => void }) {
  const { tenant } = useAuth();
  const { confirm } = useDialogs();
  const [view, setView] = useState<ModelUpgradeView | null>(null);
  const [draft, setDraft] = useState<ModelUpgradePolicy | null>(null);
  const [providers, setProviders] = useState<Map<string, string>>(() => new Map());
  const [models, setModels] = useState<ModelItem[]>([]);
  const [capabilityCatalog, setCapabilityCatalog] = useState<Pick<CatalogEntriesData, 'knownCapabilities' | 'legacyCapabilityAliases'> | null>(null);
  const [successorDraft, setSuccessorDraft] = useState<ModelUpgradeSuccessor | null>(null);
  const [successorIndex, setSuccessorIndex] = useState<number | null>(null);
  const [successorError, setSuccessorError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [evidenceRequestId, setEvidenceRequestId] = useState('');
  const [validationMode, setValidationMode] = useState<'evidence' | 'canary'>('evidence');
  const [modelLookupFailed, setModelLookupFailed] = useState(false);
  const generation = useRef(0);
  const draftRef = useRef<ModelUpgradePolicy | null>(null);
  const draftBasePolicy = useRef<ModelUpgradePolicy | null>(null);
  const draftVersion = useRef<number | null>(null);
  draftRef.current = draft;
  const currentVersion = useRef<ModelUpgradeView['current'] | null>(null);
  const canWrite = canUseCapability(tenant?.role, 'configWrite') && view?.identityKind === 'stable';
  const phase = view ? PHASES[view.phase] ?? { label: '状态待刷新', tone: 'info' as const } : null;
  const running = !!phase?.running;
  const dirty = !!view && !!draft && JSON.stringify(view.policy) !== JSON.stringify(draft);
  const unavailable = busy !== null || running || dirty || successorDraft !== null;

  useEffect(() => {
    const current = ++generation.current;
    setView(null); setDraft(null); setError(null); setNotice(null); setBusy(null); setLoading(true); setEvidenceRequestId(''); setProviders(new Map()); setModels([]); setCapabilityCatalog(null); setValidationMode('evidence'); setModelLookupFailed(false); setSuccessorDraft(null); setSuccessorError(null); currentVersion.current = null; draftBasePolicy.current = null; draftVersion.current = null;
    void Promise.all([getModelUpgrade(logicalModelId), getPlatforms(), getModels(), getCatalogEntries()]).then(([result, platforms, physical, catalog]) => {
      if (current !== generation.current) return;
      if (result.success) { currentVersion.current = result.data.current; draftBasePolicy.current = result.data.policy; draftVersion.current = result.data.version; setView(result.data); setDraft(result.data.policy); setValidationMode(result.data.validationMode || 'evidence'); }
      else setError(result.error.message || '升级策略未读取成功，请重试');
      if (platforms.success) setProviders(new Map(platforms.data.items.map(item => [item.id, item.name])));
      if (physical.success) setModels(physical.data.items.filter(item => item.authority === 'llm_gateway'));
      if (catalog.success) setCapabilityCatalog(catalog.data);
      setModelLookupFailed(!physical.success || !platforms.success || !catalog.success);
    }).catch(() => {
      if (current === generation.current) setError('升级策略未读取成功，请检查网络后重试');
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [logicalModelId, tenant?.id]);

  useEffect(() => {
    if (!busy && !running) { setSeconds(0); return; }
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy, running]);

  async function refresh(showBusy = true) {
    const current = ++generation.current;
    if (showBusy) { setBusy('refresh'); setNotice(null); }
    try {
      const result = await getModelUpgrade(logicalModelId);
      if (current !== generation.current) return;
      if (result.success) {
        const previous = currentVersion.current;
        currentVersion.current = result.data.current;
        setView(result.data); setError(null);
        if (!draftRef.current || JSON.stringify(draftRef.current) === JSON.stringify(draftBasePolicy.current)) {
          setDraft(result.data.policy); draftBasePolicy.current = result.data.policy; draftVersion.current = result.data.version;
        } else if (JSON.stringify(draftBasePolicy.current) === JSON.stringify(result.data.policy)) {
          draftVersion.current = result.data.version;
        } else setError('策略已被其他操作更新，草稿已保留。请核对最新策略后还原或重新修改。');
        if (previous && (previous.offeringId !== result.data.current?.offeringId || previous.upstreamModelId !== result.data.current?.upstreamModelId)) onRoutingChanged?.();
      }
      else setError(result.error.message || '状态暂未更新，请重试');
    } catch { if (current === generation.current) setError('状态暂未更新，请检查网络后重试'); }
    finally { if (current === generation.current && showBusy) setBusy(null); }
  }

  useEffect(() => {
    if (!view || busy) return;
    const timer = window.setInterval(() => { void refresh(false); }, running ? 3000 : 15000);
    return () => window.clearInterval(timer);
  }, [logicalModelId, view !== null, running, busy]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!view || !draft || !canWrite || busy !== null || running || successorDraft !== null) return;
    const current = ++generation.current;
    setBusy('save'); setError(null); setNotice(null);
    try {
      const result = await saveModelUpgradePolicy(logicalModelId, { ...draft, version: draftVersion.current ?? view.version });
      if (current !== generation.current) return;
      if (result.success) { currentVersion.current = result.data.current; draftBasePolicy.current = result.data.policy; draftVersion.current = result.data.version; setView(result.data); setDraft(result.data.policy); setNotice('升级策略已保存。稳定标识和历史别名保持不变。'); }
      else setError(result.error.message || '策略未保存，请刷新状态后重试');
    } catch { if (current === generation.current) setError('策略保存结果未确认，请先刷新状态，避免重复提交'); }
    finally { if (current === generation.current) setBusy(null); }
  }

  async function actOnUpgrade(action: ModelUpgradeAction) {
    if (!view || !canWrite || unavailable) return;
    if (action === 'validate') {
      if (validationMode === 'evidence' && !evidenceRequestId.trim()) { setError('请填写已有真实验证请求编号'); return; }
      const description = validationMode === 'evidence'
        ? '将核对这条已有真实验证记录，不重复发起付费验证。'
        : `将向候选版本发起一次真实请求，可能产生费用。单次预算 ${budget(view.policy.maxValidationCostUsd)}，每日预算 ${budget(view.policy.maxDailyCostUsd)}，本次费用预留上界 ${budget(view.policy.canaryUnitCostUpperBoundUsd)}。结果未确认时请先查看记录，系统不会自动重复这次验证。`;
      if (!await confirm({ title: '验证候选版本？', description, confirmLabel: '开始验证' })) return;
    }
    if (action === 'promote' && !await confirm({ title: '采用已验证的候选版本？', description: `稳定标识 ${view.publicId} 和历史别名保持不变。${view.gates.price ? '后续请求将使用候选版本。' : '候选价格尚未通过检查，自动升级已被阻止；此次手动采用需自行确认费用风险。'}`, confirmLabel: '采用候选版本' })) return;
    if (action === 'rollback' && !await confirm({ title: '回滚最近一次升级？', description: '将恢复上一次保存的版本配置，稳定标识和历史别名保持不变。之后仍可重新检查候选版本。', confirmLabel: '回滚升级' })) return;
    const current = ++generation.current;
    setBusy(action); setError(null); setNotice(null);
    try {
      const body = action === 'validate' ? { version: view.version, mode: validationMode, ...(validationMode === 'evidence' ? { requestId: evidenceRequestId.trim() } : {}) } : { version: view.version };
      const result = await runModelUpgradeAction(logicalModelId, action, body);
      if (current !== generation.current) return;
      if (!result.success) { setError(result.error.message || '本次操作未完成，请刷新状态后重试'); return; }
      currentVersion.current = result.data.current; draftBasePolicy.current = result.data.policy; draftVersion.current = result.data.version; setView(result.data); setDraft(result.data.policy);
      if (action === 'promote' || action === 'rollback') onRoutingChanged?.();
    } catch { if (current === generation.current) setError('操作结果未确认，请先刷新状态并查看记录，不要重复发起付费验证'); }
    finally { if (current === generation.current) setBusy(null); }
  }

  const provider = (id?: string) => id ? providers.get(id) || '上游名称待刷新' : '未指定上游';
  const successorModels = successorDraft ? models.filter(model => model.platformId === successorDraft.providerId) : [];
  const successorNames = [...new Set(successorModels.map(model => model.modelName))];
  const fromNames = successorDraft && view?.current?.providerId === successorDraft.providerId
    ? [...new Set([...successorNames, view.current.upstreamModelId].filter(Boolean))] : [...successorNames];
  if (successorIndex !== null && successorDraft?.fromModel && !fromNames.includes(successorDraft.fromModel)) fromNames.push(successorDraft.fromModel);
  const toNames = successorIndex !== null && successorDraft?.toModel ? [...new Set([...successorNames, successorDraft.toModel])] : successorNames;
  const selectedSuccessorModel = successorDraft ? successorModels.find(model => model.modelName === successorDraft.toModel) : null;
  // Only the server catalog defines routable capabilities; parameter metadata is not a capability.
  function canonicalCapabilities(codes: string[]) {
    const known = new Set(capabilityCatalog?.knownCapabilities ?? []);
    return [...new Set(codes.map(code => {
      const normalized = code.trim().toLowerCase();
      return known.has(normalized) ? normalized : capabilityCatalog?.legacyCapabilityAliases?.[normalized];
    }).filter((code): code is string => !!code && known.has(code)))];
  }
  function modelCapabilities(model?: ModelItem | null) {
    return canonicalCapabilities(model?.capabilities.filter(capability => capability.value === true).map(capability => capability.type) ?? []);
  }
  const successorCapabilities = selectedSuccessorModel ? modelCapabilities(selectedSuccessorModel) : canonicalCapabilities(successorIndex !== null ? successorDraft?.capabilities ?? [] : []);

  function editSuccessor(index: number | null) {
    if (!draft || !view) return;
    setSuccessorIndex(index); setSuccessorError(null);
    setSuccessorDraft(index === null ? { providerId: view.current?.providerId || '', fromModel: view.current?.upstreamModelId || '', toModel: '', documentationUrl: '', capabilities: [] } : { ...draft.successors[index], capabilities: canonicalCapabilities(draft.successors[index].capabilities) });
  }
  function stageSuccessor() {
    if (!draft || !successorDraft) return;
    if (!successorDraft.providerId || !successorDraft.fromModel || !successorDraft.toModel) { setSuccessorError('请选择上游、原版本和继任版本'); return; }
    if (successorDraft.fromModel === successorDraft.toModel) { setSuccessorError('继任版本需要与原版本不同'); return; }
    if (!safeDocumentUrl(successorDraft.documentationUrl) || new URL(successorDraft.documentationUrl).protocol !== 'https:') { setSuccessorError('请填写官方 HTTPS 版本资料地址'); return; }
    const capabilities = canonicalCapabilities(successorDraft.capabilities).filter(capability => successorCapabilities.includes(capability));
    if (capabilities.length === 0) { setSuccessorError('请选择已登记的继任版本能力'); return; }
    if (draft.successors.some((item, index) => index !== successorIndex && item.providerId === successorDraft.providerId && item.fromModel === successorDraft.fromModel && item.toModel === successorDraft.toModel)) { setSuccessorError('这条继任关系已在策略中'); return; }
    const successors = [...draft.successors];
    if (successorIndex === null) successors.push({ ...successorDraft, capabilities }); else successors[successorIndex] = { ...successorDraft, capabilities };
    setDraft({ ...draft, successors }); setSuccessorDraft(null); setSuccessorError(null);
  }
  async function reloadTargets() {
    const [platforms, physical, catalog] = await Promise.all([getPlatforms(), getModels(), getCatalogEntries()]);
    if (platforms.success) setProviders(new Map(platforms.data.items.map(item => [item.id, item.name])));
    if (physical.success) setModels(physical.data.items.filter(item => item.authority === 'llm_gateway'));
    if (catalog.success) setCapabilityCatalog(catalog.data);
    setModelLookupFailed(!platforms.success || !physical.success || !catalog.success);
  }

  return <section data-testid="model-upgrade-panel" aria-label="升级策略" style={{ display: 'flex', flexDirection: 'column', gap: GAP.section, padding: 14, minWidth: 0 }}>
    {loading ? <SectionLoader text="正在读取升级策略" /> : null}
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    {notice ? <InlineAlert tone="ok">{notice}</InlineAlert> : null}
    {!loading ? <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>刷新状态</Button>
      <span style={HINT_TEXT}>最近更新：{formatTime(view?.updatedAt)}</span>
    </div> : null}
    {view && draft && phase ? <>
      <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal }}>{busy || running ? <Spinner size={14} /> : null}<Chip label={phase.label} color={`var(--${phase.tone})`} bg={`var(--${phase.tone}-bg)`} />{busy || running ? <span style={HINT_TEXT}>{busy ? BUSY_LABELS[busy] || phase.label : phase.label} · {seconds} 秒</span> : null}</div>
        {view.message ? <span style={HINT_TEXT}>{view.message}</span> : null}
      </div>
      <CollectionFacts items={[
        { label: '稳定标识', value: <code>{view.publicId}</code> },
        { label: '历史别名', value: view.aliases.length ? view.aliases.map(alias => <code key={alias} style={{ display: 'block' }}>{alias}</code>) : '无' },
        { label: '当前版本', value: <><strong>{view.current?.upstreamModelId || '尚未配置'}</strong><div style={HINT_TEXT}>{provider(view.current?.providerId)}</div></> },
        { label: '候选版本', value: view.candidate ? <><strong>{view.candidate.upstreamModelId}</strong><div style={HINT_TEXT}>{provider(view.candidate.providerId)}</div><div style={HINT_TEXT}>发现于 {formatTime(view.candidate.discoveredAt)}</div>{safeDocumentUrl(view.candidate.documentationUrl) ? <a href={view.candidate.documentationUrl} target="_blank" rel="noreferrer">官方版本资料</a> : null}</> : '尚未发现候选版本' },
        { label: '上次检查', value: formatTime(view.lastCheckedAt) },
        { label: '下次检查', value: view.nextCheckAt ? formatTime(view.nextCheckAt) : '尚未安排' },
      ]} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
        <h3 style={{ ...SECTION_TITLE, margin: 0 }}>升级前检查</h3>
        <div style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap' }}>{([
          ['capabilities', '能力兼容'], ['price', '价格变化'], ['budget', '验证预算'], ['validation', '真实验证'],
        ] as const).map(([key, label]) => <Chip key={key} label={`${label} · ${key === 'validation' ? VALIDATION_STATUS[view.validationStatus] || '结果未知' : view.gates[key] ? '通过' : '待满足'}`} color={view.gates[key] ? 'var(--ok)' : 'var(--warn)'} bg={view.gates[key] ? 'var(--ok-bg)' : 'var(--warn-bg)'} />)}</div>
        {view.candidate ? <span style={HINT_TEXT}>最近验证：{formatTime(view.candidate.validatedAt)}{view.candidate.validationRequestId ? <> · <Link to={`/logs?requestId=${encodeURIComponent(view.candidate.validationRequestId)}`}>查看验证记录</Link></> : null}</span> : null}
        {view.actionDisabledReason ? <span style={HINT_TEXT}>{view.actionDisabledReason}</span> : null}
      </div>
      {view.identityKind !== 'stable' ? <InlineAlert tone="info">固定版本保持原始标识，不参与自动升级。</InlineAlert> : !canWrite ? <ReadOnlyNotice /> : null}
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: GAP.section }}>
        <h3 style={{ ...SECTION_TITLE, margin: 0 }}>版本策略</h3>
        <FormGrid>
          <label style={FIELD_LABEL}><span>版本选择</span><select aria-label="版本选择" style={FIELD_INPUT} disabled={!canWrite || busy !== null || running} value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as ModelUpgradePolicy['mode'] })}><option value="manual">固定当前版本，手动采用候选</option><option value="auto">自动采用通过检查的新版本</option></select></label>
          <label style={FIELD_LABEL}><span>定期检查</span><select aria-label="定期检查" style={FIELD_INPUT} disabled={!canWrite || busy !== null || running} value={String(draft.enabled)} onChange={event => setDraft({ ...draft, enabled: event.target.value === 'true' })}><option value="false">暂停定期检查</option><option value="true">启用定期检查</option></select></label>
          <label style={FIELD_LABEL}><span>检查间隔（小时）</span><input aria-label="检查间隔（小时）" type="number" min={1} step={1} required style={FIELD_INPUT} disabled={!canWrite || busy !== null || running} value={draft.checkIntervalHours} onChange={event => setDraft({ ...draft, checkIntervalHours: Number(event.target.value) })} /></label>
        </FormGrid>
        <DetailsBlock title="验证预算与自动升级限制">
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
            <label style={{ ...HINT_TEXT, display: 'flex', alignItems: 'center', gap: GAP.tight }}><input type="checkbox" aria-label="允许自动付费验证" disabled={!canWrite || busy !== null || running} checked={draft.autoValidate} onChange={event => setDraft({ ...draft, autoValidate: event.target.checked })} />自动模式允许在预算内发起真实验证</label>
            <FormGrid>{([
              ['maxValidationCostUsd', '单次验证预算（美元）'], ['canaryUnitCostUpperBoundUsd', '验证费用保守上界（美元）'], ['maxDailyCostUsd', '每日验证预算（美元）'], ['maxPriceIncreasePercent', '允许涨价上限（%）'],
            ] as const).map(([key, label]) => <label key={key} style={FIELD_LABEL}><span>{label}</span><input aria-label={label} type="number" min={0} step="any" style={FIELD_INPUT} disabled={!canWrite || busy !== null || running} value={draft[key] ?? ''} onChange={event => setDraft({ ...draft, [key]: event.target.value === '' ? null : Number(event.target.value) })} /></label>)}</FormGrid>
            <span style={HINT_TEXT}>真实验证可能产生费用。费用上界用于预留验证预算，不代表供应商按次收费；未知价格不会自动升级。</span>
            <span style={HINT_TEXT}>验证场景：{draft.validationAppCallerCode || '尚未设置'}</span>
          </div>
        </DetailsBlock>
        <section aria-label="版本继任关系" style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}><h3 style={{ ...SECTION_TITLE, margin: 0 }}>版本继任关系</h3>{canWrite ? <Button type="button" size="sm" variant="ghost" disabled={busy !== null || running} onClick={() => editSuccessor(null)}>添加继任版本</Button> : null}</div>
          {draft.successors.length ? draft.successors.map((successor, index) => <div key={`${successor.providerId}:${successor.fromModel}:${successor.toModel}`} style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight, paddingBlock: GAP.normal, borderBottom: '1px solid var(--border-subtle)' }}>
            <strong style={{ overflowWrap: 'anywhere' }}>{successor.fromModel} → {successor.toModel}</strong><span style={HINT_TEXT}>{provider(successor.providerId)} · {successor.capabilities.map(capabilityLabel).join(' · ') || '能力待确认'}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>{safeDocumentUrl(successor.documentationUrl) ? <a href={successor.documentationUrl} target="_blank" rel="noreferrer">官方版本资料</a> : null}{canWrite ? <><Button type="button" size="sm" variant="ghost" disabled={busy !== null || running} onClick={() => editSuccessor(index)}>编辑关系</Button><Button type="button" size="sm" variant="ghost" disabled={busy !== null || running} onClick={() => { setDraft({ ...draft, successors: draft.successors.filter((_, candidateIndex) => candidateIndex !== index) }); setSuccessorDraft(null); }}>移除关系</Button></> : null}</div>
          </div>) : <span style={HINT_TEXT}>尚未配置继任关系，自动升级不会切换版本。</span>}
          {successorDraft && canWrite ? <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
            {modelLookupFailed ? <InlineAlert tone="error">上游模型或能力清单暂未读取成功。<Button type="button" size="sm" onClick={() => void reloadTargets()}>重新读取模型</Button></InlineAlert> : null}
            {successorDraft.providerId && successorModels.length === 0 ? <span style={HINT_TEXT}>此上游尚无已接入模型，请先到<Link to="/platforms">上游</Link>接入原版本与新版本。</span> : null}
            <FormGrid>
              <label style={FIELD_LABEL}><span>继任关系的上游</span><select aria-label="继任关系的上游" value={successorDraft.providerId} style={FIELD_INPUT} onChange={event => setSuccessorDraft({ providerId: event.target.value, fromModel: '', toModel: '', documentationUrl: '', capabilities: [] })}><option value="">选择已接入的上游</option>{[...providers].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
              <label style={FIELD_LABEL}><span>原版本</span><select aria-label="原版本" value={successorDraft.fromModel} style={FIELD_INPUT} onChange={event => setSuccessorDraft({ ...successorDraft, fromModel: event.target.value })}><option value="">选择原版本</option>{fromNames.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
              <label style={FIELD_LABEL}><span>继任版本</span><select aria-label="继任版本" value={successorDraft.toModel} style={FIELD_INPUT} onChange={event => { const model = successorModels.find(item => item.modelName === event.target.value); setSuccessorDraft({ ...successorDraft, toModel: event.target.value, capabilities: modelCapabilities(model) }); }}><option value="">选择已接入的新版本</option>{toNames.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
              <label style={FIELD_LABEL}><span>官方版本资料地址</span><input aria-label="官方版本资料地址" type="url" value={successorDraft.documentationUrl} onChange={event => setSuccessorDraft({ ...successorDraft, documentationUrl: event.target.value.trim() })} style={FIELD_INPUT} placeholder="https://官方文档中的版本说明" /></label>
            </FormGrid>
            <fieldset style={{ margin: 0, padding: 0, border: 0 }}><legend style={FIELD_LABEL}>继任版本能力</legend><div style={{ display: 'flex', gap: GAP.normal, flexWrap: 'wrap' }}>{successorCapabilities.map(capability => <label key={capability} style={{ ...HINT_TEXT, display: 'flex', alignItems: 'center', gap: GAP.tight }}><input type="checkbox" aria-label={`继任能力 ${capability}`} checked={successorDraft.capabilities.includes(capability)} onChange={event => setSuccessorDraft({ ...successorDraft, capabilities: event.target.checked ? [...successorDraft.capabilities, capability] : successorDraft.capabilities.filter(item => item !== capability) })} />{capabilityLabel(capability)}</label>)}</div></fieldset>
            {successorDraft.toModel && !successorCapabilities.length ? <span style={HINT_TEXT}>该版本尚未登记能力，请先到<Link to="/platforms">上游</Link>完善模型配置。</span> : null}
            {successorError ? <InlineAlert tone="error">{successorError}</InlineAlert> : null}
            <div style={{ display: 'flex', gap: GAP.normal }}><Button type="button" size="sm" disabled={busy !== null || running} onClick={stageSuccessor}>加入策略</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setSuccessorDraft(null); setSuccessorError(null); }}>取消关系编辑</Button></div>
          </div> : null}
        </section>
        {successorDraft ? <span style={HINT_TEXT}>请先加入继任关系或取消编辑，再保存升级策略。</span> : null}
        {canWrite ? <div style={{ display: 'flex', gap: GAP.normal, flexWrap: 'wrap' }}><Button type="submit" variant="primary" size="sm" disabled={busy !== null || running || !dirty || successorDraft !== null}>{busy === 'save' ? '保存中…' : '保存升级策略'}</Button><Button type="button" variant="ghost" size="sm" disabled={busy !== null || !dirty} onClick={() => { setDraft(view.policy); draftBasePolicy.current = view.policy; draftVersion.current = view.version; setSuccessorDraft(null); setSuccessorError(null); setError(null); }}>还原修改</Button></div> : null}
      </form>
      {dirty ? <InlineAlert tone="info">策略有未保存的修改，请先保存或还原，再执行版本检查。</InlineAlert> : null}
      {canWrite ? <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
        <label style={FIELD_LABEL}><span>验证方式</span><select aria-label="验证方式" value={validationMode} style={FIELD_INPUT} disabled={unavailable} onChange={event => setValidationMode(event.target.value as 'evidence' | 'canary')}>{(view.validationModes || ['evidence']).map(mode => <option key={mode} value={mode}>{mode === 'evidence' ? '核对已有真实验证记录' : '在预算内执行一次真实验证'}</option>)}</select></label>
        {validationMode === 'evidence' ? <label style={FIELD_LABEL}><span>已有验证请求编号</span><input aria-label="已有验证请求编号" style={FIELD_INPUT} value={evidenceRequestId} disabled={unavailable} onChange={event => setEvidenceRequestId(event.target.value)} placeholder="填写此候选版本的真实验证记录" /></label> : <span style={HINT_TEXT}>真实验证受系统预算与调用权限保护；未执行或结果未知都不会标记为验证成功。</span>}
        <div style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap' }}>
          <Button size="sm" disabled={unavailable} onClick={() => void actOnUpgrade('check')}>检查新版本</Button>
          <Button size="sm" disabled={unavailable || !view.candidate || (validationMode === 'evidence' && !evidenceRequestId.trim())} onClick={() => void actOnUpgrade('validate')}>验证候选版本</Button>
          <Button size="sm" variant="primary" disabled={unavailable || !view.canPromote} title={view.actionDisabledReason || undefined} onClick={() => void actOnUpgrade('promote')}>采用候选版本</Button>
          <Button size="sm" variant="ghost" disabled={unavailable || !view.canRollback} onClick={() => void actOnUpgrade('rollback')}>回滚最近升级</Button>
        </div>
      </div> : null}
      {view.discoveries?.length ? <DetailsBlock title={`待确认的新型号（${view.discoveries.length}）`}>
        <span style={HINT_TEXT}>这些型号尚未指定继任关系，不会自动替换当前版本。<Link to="/platforms">前往上游接入</Link>后可配置继任关系。</span>
        <div style={{ minHeight: 180 }}><CollectionView items={view.discoveries} placeholder="搜索待确认型号" searchText={item => `${item.upstreamModelId} ${provider(item.providerId)} ${item.message}`}>{items => <>{items.map(item => <div key={`${item.providerId}:${item.upstreamModelId}`} style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight, paddingBlock: GAP.normal, borderBottom: '1px solid var(--border-subtle)' }}><strong style={{ overflowWrap: 'anywhere' }}>{item.upstreamModelId}</strong><span style={HINT_TEXT}>{provider(item.providerId)} · 待确认</span><span style={HINT_TEXT}>{item.message}</span></div>)}</>}</CollectionView></div>
      </DetailsBlock> : null}
      <h3 style={{ ...SECTION_TITLE, margin: 0 }}>升级与回滚记录</h3>
      <div style={{ minHeight: 180 }}><CollectionView items={view.history} placeholder="搜索升级记录" searchText={item => `${item.message} ${HISTORY_ACTIONS[item.action] || item.action}`} emptyText="尚无升级或回滚记录。">{items => <>{items.map(item => <div key={item.id} style={{ paddingBlock: GAP.normal, borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: GAP.tight }}><strong>{HISTORY_ACTIONS[item.action] || '版本维护'} · {HISTORY_STATUS[item.status] || '状态待确认'}</strong><span style={{ ...HINT_TEXT, overflowWrap: 'anywhere' }}>{item.message}</span><span style={HINT_TEXT}>{formatTime(item.createdAt)}{item.requestId ? <> · <Link to={`/logs?requestId=${encodeURIComponent(item.requestId)}`}>查看请求</Link></> : null}</span></div>)}</>}</CollectionView></div>
    </> : null}
  </section>;
}

function formatTime(value?: string | null): string {
  if (!value) return '暂无记录';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '时间待确认' : time.toLocaleString();
}
function budget(value: number | null): string { return value === null ? '尚未设置' : `$${value}`; }
function safeDocumentUrl(value?: string): boolean {
  if (!value) return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
