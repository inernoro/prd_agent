// 模型池：每个池一张卡，展示策略/类型/默认标记 + 池内每个模型的健康 chip。
// 「默认池」可就地切换：GW 权威池写 llm_gateway，MAP 来源池写旧集合。
import { useEffect, useState } from 'react';
import { bulkCalibratePoolPriceCurrency, bulkClaimPools, bulkImportPoolModels, claimPoolToGateway, createPool, getModels, getParameterCapabilitiesMeta, getPools, removePoolModel, setPoolDefault, updatePool, upsertPoolModel } from '@/lib/api';
import type { ModelCapability, ModelItem, ModelPool, ParameterCapabilityMetaItem, PoolModelInfo } from '@/lib/types';
import { Chip, SectionLoader, Button } from '@/components/ui';
import { healthChip } from '@/components/poolsHelpers';

const STRATEGY_LABEL: Record<number, string> = {
  0: '优先级', 1: '轮询', 2: '加权', 3: '最少连接', 4: '随机', 5: '故障转移',
};
type PoolEditDraft = { name: string; code: string; modelType: string; priority: string; strategyType: string; description: string };
type PoolMemberDraft = { modelKey: string; priority: string; protocol: string; parameterCapabilities: string };
type PoolBulkImportDraft = { platformId: string; capabilityFilter: string; maxCount: string; enabledOnly: boolean; overwriteExisting: boolean };
type PriceCurrencyCalibrationDraft = { modelType: string; targetCurrency: string; onlyMissing: boolean; includeMembersWithoutPrice: boolean };

export function ModelPoolsPage() {
  const [pools, setPools] = useState<ModelPool[] | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [parameterMeta, setParameterMeta] = useState<ParameterCapabilityMetaItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState({ name: '', code: '', modelType: 'chat', priority: '50', isDefaultForType: false, description: '' });
  const [bulkModelType, setBulkModelType] = useState('');
  const [priceCurrencyDraft, setPriceCurrencyDraft] = useState<PriceCurrencyCalibrationDraft>({
    modelType: '',
    targetCurrency: 'CNY',
    onlyMissing: true,
    includeMembersWithoutPrice: false,
  });
  const [addDrafts, setAddDrafts] = useState<Record<string, PoolMemberDraft>>({});
  const [bulkImportDrafts, setBulkImportDrafts] = useState<Record<string, PoolBulkImportDraft>>({});
  const [memberParameterCaps, setMemberParameterCaps] = useState<Record<string, string>>({});
  const [memberPriorities, setMemberPriorities] = useState<Record<string, string>>({});
  const [editDrafts, setEditDrafts] = useState<Record<string, PoolEditDraft>>({});

  useEffect(() => {
    let alive = true;
    Promise.all([getPools(), getModels({ enabled: true }), getParameterCapabilitiesMeta()]).then(([poolRes, modelRes, parameterRes]) => {
      if (!alive) return;
      if (poolRes.success) setPools(poolRes.data.items);
      else setError(poolRes.error?.message || '加载失败');
      if (modelRes.success) setModels(modelRes.data.items);
      if (parameterRes.success) setParameterMeta(parameterRes.data.items);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function makeDefault(pool: ModelPool) {
    if (pool.isDefaultForType) return;
    setBusyId(pool.id);
    setToast(null);
    const res = await setPoolDefault(pool.id, true);
    setBusyId(null);
    if (res.success) {
      // 同类型互斥：本池置默认，其它同 modelType 池清默认（前端同步反映后端行为）。
      setPools((prev) => (prev ? prev.map((x) => (x.modelType === res.data.modelType ? { ...x, isDefaultForType: x.id === res.data.id } : x)) : prev));
      setToast(`已将「${res.data.name}」设为 ${res.data.modelType || 'chat'} 类型的默认池`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function claimPool(pool: ModelPool) {
    setBusyId(pool.id);
    setToast(null);
    const res = await claimPoolToGateway(pool.id);
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已将「${res.data.name}」导入平台模型池`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function createGatewayPool() {
    const name = createDraft.name.trim();
    const modelType = createDraft.modelType.trim();
    const priority = toPositiveInt(createDraft.priority);
    if (!name) {
      setToast('模型池名称不能为空');
      return;
    }
    if (!modelType) {
      setToast('模型类型不能为空');
      return;
    }
    if (priority === null) {
      setToast('优先级必须是正整数');
      return;
    }
    setBusyId('create-pool');
    setToast(null);
    const res = await createPool({
      name,
      code: createDraft.code.trim() || undefined,
      modelType,
      priority,
      isDefaultForType: createDraft.isDefaultForType,
      strategyType: 0,
      description: createDraft.description.trim() || undefined,
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => {
        const current = prev || [];
        const normalized = res.data.isDefaultForType
          ? current.map((p) => (p.modelType === res.data.modelType ? { ...p, isDefaultForType: false } : p))
          : current;
        return [res.data, ...normalized];
      });
      setCreateDraft({ name: '', code: '', modelType, priority: '50', isDefaultForType: false, description: '' });
      setToast(`已创建 GW 模型池「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function bulkClaim() {
    setBusyId('bulk-claim-pools');
    setToast(null);
    const res = await bulkClaimPools({ modelType: bulkModelType.trim() || undefined, overwrite: false });
    setBusyId(null);
    if (res.success) {
      const fresh = await getPools();
      if (fresh.success) setPools(fresh.data.items);
      setToast(`批量认领完成：新增/更新 ${res.data.claimed} 个，跳过 ${res.data.skipped} 个`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function calibratePriceCurrency() {
    setBusyId('bulk-calibrate-price-currency');
    setToast(null);
    const res = await bulkCalibratePoolPriceCurrency({
      modelType: priceCurrencyDraft.modelType.trim() || undefined,
      targetCurrency: priceCurrencyDraft.targetCurrency,
      onlyMissing: priceCurrencyDraft.onlyMissing,
      includeMembersWithoutPrice: priceCurrencyDraft.includeMembersWithoutPrice,
    });
    setBusyId(null);
    if (res.success) {
      const fresh = await getPools();
      if (fresh.success) setPools(fresh.data.items);
      setToast(`价格币种校准完成：扫描 ${res.data.scannedPools} 个池，更新 ${res.data.updatedMembers} 个成员为 ${res.data.targetCurrency}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  function startEditPool(pool: ModelPool) {
    setEditDrafts((prev) => ({
      ...prev,
      [pool.id]: {
        name: pool.name,
        code: pool.code,
        modelType: pool.modelType || 'chat',
        priority: String(pool.priority),
        strategyType: String(pool.strategyType),
        description: pool.description || '',
      },
    }));
  }

  function cancelEditPool(poolId: string) {
    setEditDrafts((prev) => {
      const next = { ...prev };
      delete next[poolId];
      return next;
    });
  }

  async function savePool(pool: ModelPool) {
    const draft = editDrafts[pool.id];
    if (!draft) return;
    const name = draft.name.trim();
    const code = draft.code.trim();
    const modelType = draft.modelType.trim();
    const priority = toPositiveInt(draft.priority);
    const strategyType = toStrategyType(draft.strategyType);
    if (!name) {
      setToast('模型池名称不能为空');
      return;
    }
    if (!code) {
      setToast('模型池 Code 不能为空');
      return;
    }
    if (!modelType) {
      setToast('模型类型不能为空');
      return;
    }
    if (priority === null) {
      setToast('优先级必须是正整数');
      return;
    }
    if (strategyType === null) {
      setToast('策略类型必须是 0 到 5');
      return;
    }
    setBusyId(`pool-edit:${pool.id}`);
    setToast(null);
    const res = await updatePool(pool.id, {
      name,
      code,
      modelType,
      priority,
      strategyType,
      description: draft.description.trim(),
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => {
        if (!prev) return prev;
        const normalized = res.data.isDefaultForType
          ? prev.map((p) => (p.modelType === res.data.modelType ? { ...p, isDefaultForType: false } : p))
          : prev;
        return normalized.map((p) => (p.id === res.data.id ? res.data : p));
      });
      cancelEditPool(pool.id);
      setToast(`已保存模型池「${res.data.name}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function addPoolModel(pool: ModelPool) {
    const draft = addDrafts[pool.id];
    if (!draft?.modelKey) {
      setToast('请选择要加入模型池的模型');
      return;
    }
    const selected = models.find((m) => modelOptionKey(m) === draft.modelKey);
    if (!selected) {
      setToast('模型不存在或已被筛选移除');
      return;
    }
    const priority = toPositiveInt(draft.priority);
    if (priority === null) {
      setToast('优先级必须是正整数');
      return;
    }
    setBusyId(pool.id);
    setToast(null);
    const res = await upsertPoolModel(pool.id, {
      modelId: selected.modelName || selected.id,
      platformId: selected.platformId || undefined,
      priority,
      protocol: draft.protocol.trim() || undefined,
      enablePromptCache: selected.enablePromptCache ?? undefined,
      maxTokens: selected.maxTokens ?? undefined,
      capabilities: mergeParameterCapabilities(selected.capabilities, draft.parameterCapabilities),
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setAddDrafts((prev) => ({ ...prev, [pool.id]: emptyMemberDraft() }));
      setToast(`已更新「${res.data.name}」的模型池成员`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function bulkImportModels(pool: ModelPool) {
    const draft = bulkImportDrafts[pool.id] || emptyBulkImportDraft();
    const maxCount = toPositiveInt(draft.maxCount);
    if (maxCount === null) {
      setToast('最大数量必须是正整数');
      return;
    }
    if (!window.confirm(`批量导入「${pool.name}」的模型池成员？`)) return;
    setBusyId(`pool-bulk-import:${pool.id}`);
    setToast(null);
    const res = await bulkImportPoolModels(pool.id, {
      platformId: draft.platformId || undefined,
      capabilityFilter: draft.capabilityFilter,
      enabledOnly: draft.enabledOnly,
      overwriteExisting: draft.overwriteExisting,
      maxCount,
    });
    setBusyId(null);
    if (res.success) {
      if (res.data.pool) {
        setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.pool?.id ? res.data.pool : x)) : prev));
      }
      setToast(`批量导入完成：新增 ${res.data.imported}，更新 ${res.data.updated}，跳过已有 ${res.data.skippedExisting}`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  async function savePoolModelPriority(pool: ModelPool, member: PoolModelInfo) {
    const key = memberKey(pool.id, member);
    const priority = toPositiveInt(memberPriorities[key] ?? String(member.priority));
    if (priority === null) {
      setToast('优先级必须是正整数');
      return;
    }
    setBusyId(key);
    setToast(null);
    const parameterCapabilities = memberParameterCaps[key] ?? parameterCapabilityText(member.capabilities);
    const res = await upsertPoolModel(pool.id, {
      modelId: member.modelId,
      platformId: member.platformId,
      priority,
      protocol: member.protocol || undefined,
      enablePromptCache: member.enablePromptCache ?? undefined,
      maxTokens: member.maxTokens ?? undefined,
      inputPricePerMillion: member.inputPricePerMillion ?? undefined,
      outputPricePerMillion: member.outputPricePerMillion ?? undefined,
      pricePerCall: member.pricePerCall ?? undefined,
      priceCurrency: member.priceCurrency || undefined,
      capabilities: mergeParameterCapabilities(member.capabilities, parameterCapabilities),
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setMemberParameterCaps((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setToast(`已保存「${member.modelId}」的池内优先级`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  function updateMemberPriceCurrency(poolId: string, member: PoolModelInfo, priceCurrency: string) {
    setPools((prev) => {
      if (!prev) return prev;
      return prev.map((poolItem) => {
        if (poolItem.id !== poolId) return poolItem;
        return {
          ...poolItem,
          models: poolItem.models.map((currentMember) => (
            currentMember.modelId === member.modelId && currentMember.platformId === member.platformId
              ? { ...currentMember, priceCurrency }
              : currentMember
          )),
        };
      });
    });
  }

  async function deletePoolModel(pool: ModelPool, member: PoolModelInfo) {
    setBusyId(memberKey(pool.id, member));
    setToast(null);
    const res = await removePoolModel(pool.id, member.modelId, member.platformId);
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? res.data : x)) : prev));
      setToast(`已从「${res.data.name}」移除「${member.modelId}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  if (error) return <Empty text={error} />;
  if (!pools) return <SectionLoader text="正在加载模型池…" />;
  const modelTypes = Array.from(new Set(pools.map((p) => p.modelType).filter(Boolean))).sort();
  const platformIds = Array.from(new Set(models.map((m) => m.platformId).filter((x): x is string => !!x))).sort();

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ParameterCapabilityOptions parameterMeta={parameterMeta} />
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      <PoolCreateBar
        draft={createDraft}
        modelTypes={modelTypes}
        busyId={busyId}
        bulkModelType={bulkModelType}
        priceCurrencyDraft={priceCurrencyDraft}
        onDraftChange={setCreateDraft}
        onBulkModelTypeChange={setBulkModelType}
        onPriceCurrencyDraftChange={setPriceCurrencyDraft}
        onCreate={() => void createGatewayPool()}
        onBulkClaim={() => void bulkClaim()}
        onCalibratePriceCurrency={() => void calibratePriceCurrency()}
      />
      {pools.length === 0 ? <Empty text="暂无模型池，可先新建第一个模型池" /> : null}
      {pools.map((p) => (
        <div
          key={p.id}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius)',
            padding: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{p.name}</span>
            <Chip label={p.modelType || 'chat'} color="var(--accent)" bg="var(--accent-soft)" />
            <Chip label={STRATEGY_LABEL[p.strategyType] || `策略${p.strategyType}`} color="var(--text-secondary)" bg="var(--bg-elevated)" />
            {p.isDefaultForType ? <Chip label="默认池" color="#3fb950" bg="rgba(63,185,80,0.14)" /> : null}
            {p.authority === 'llm_gateway' ? (
              <Chip label="平台配置" color="#7aa2ff" bg="rgba(122,162,255,0.14)" title={p.claimedAt ? `导入于 ${p.claimedAt}` : undefined} />
            ) : (
              <Chip label="待导入" color="var(--text-muted)" bg="var(--bg-elevated)" />
            )}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>优先级 {p.priority}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.models.length} 个模型</span>
              {p.authority === 'llm_gateway' ? null : (
                <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void claimPool(p)}>
                  {busyId === p.id ? '处理中…' : '导入到平台'}
                </Button>
              )}
              {p.authority === 'llm_gateway' ? (
                <Button size="sm" variant="ghost" disabled={busyId === `pool-edit:${p.id}`} onClick={() => (editDrafts[p.id] ? cancelEditPool(p.id) : startEditPool(p))}>
                  {editDrafts[p.id] ? '取消编辑' : '编辑属性'}
                </Button>
              ) : null}
              {p.isDefaultForType ? null : (
                <Button size="sm" variant="secondary" disabled={busyId === p.id} onClick={() => void makeDefault(p)}>
                  {busyId === p.id ? '处理中…' : '设为默认'}
                </Button>
              )}
            </span>
          </div>
          {editDrafts[p.id] ? (
            <PoolEditBar
              draft={editDrafts[p.id]}
              busy={busyId === `pool-edit:${p.id}`}
              onDraftChange={(next) => setEditDrafts((prev) => ({ ...prev, [p.id]: next }))}
              onSave={() => void savePool(p)}
              onCancel={() => cancelEditPool(p.id)}
            />
          ) : null}
          {p.description ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{p.description}</div>
          ) : null}
          {p.authority === 'llm_gateway' ? (
            <>
              <PoolBulkImportBar
                pool={p}
                platformIds={platformIds}
                draft={bulkImportDrafts[p.id] || emptyBulkImportDraft()}
                busyId={busyId}
                onDraftChange={(next) => setBulkImportDrafts((prev) => ({ ...prev, [p.id]: next }))}
                onImport={() => void bulkImportModels(p)}
              />
              <PoolMemberEditor
                pool={p}
                models={models}
                parameterMeta={parameterMeta}
                draft={addDrafts[p.id] || emptyMemberDraft()}
                busyId={busyId}
                onDraftChange={(next) => setAddDrafts((prev) => ({ ...prev, [p.id]: next }))}
                onAdd={() => void addPoolModel(p)}
              />
            </>
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {p.models.map((m, i) => {
              const chip = healthChip(m.healthStatus);
              const key = memberKey(p.id, m);
              return (
                <div
                  key={`${m.modelId}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    padding: '8px 10px',
                    background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                  }}
                >
                  <Chip label={chip.label} color={chip.color} bg={chip.bg} title={`连续失败 ${m.consecutiveFailures} / 连续成功 ${m.consecutiveSuccesses}`} />
                  <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text-primary)' }}>{m.modelId}</span>
                  {m.protocol ? <span style={{ color: 'var(--text-muted)' }}>{m.protocol}</span> : null}
                  <CapabilityTags labels={capabilityLabelsForMember(m)} />
                  {p.authority === 'llm_gateway' ? (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                      P
                      <input
                        value={memberPriorities[key] ?? String(m.priority)}
                        onChange={(e) => setMemberPriorities((prev) => ({ ...prev, [key]: e.target.value }))}
                        style={smallInputStyle(56)}
                        inputMode="numeric"
                      />
                    </label>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>P{m.priority}</span>
                  )}
                  {m.maxTokens ? <span style={{ color: 'var(--text-muted)' }}>maxTokens {m.maxTokens}</span> : null}
	                  {p.authority === 'llm_gateway' ? (
	                    <select
	                      value={(m.priceCurrency || 'CNY').toUpperCase()}
	                      onChange={(e) => updateMemberPriceCurrency(p.id, m, e.target.value)}
	                      style={smallSelectStyle(74)}
                      aria-label="价格币种"
                      title="价格币种：CNY 为历史模型池价格默认值；USD 可参与月预算美元统计"
                    >
                      <option value="CNY">CNY</option>
                      <option value="USD">USD</option>
                    </select>
                  ) : m.priceCurrency ? (
                    <span style={{ color: 'var(--text-muted)' }}>{m.priceCurrency}</span>
                  ) : null}
                  {m.consecutiveFailures > 0 ? (
                    <span style={{ color: '#f85149' }}>连败 {m.consecutiveFailures}</span>
                  ) : null}
                  {p.authority === 'llm_gateway' ? (
                    <input
                      value={memberParameterCaps[key] ?? parameterCapabilityText(m.capabilities)}
                      onChange={(e) => setMemberParameterCaps((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="seed, stop=false"
                      list="gw-parameter-capability-options"
                      style={{ ...inputStyle, flex: '1 1 180px', minWidth: 160 }}
                      aria-label="字段级参数能力"
                      title="字段级参数能力，例：seed, stop=false；保存为 parameter:<name>"
                    />
                  ) : null}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                    {p.authority === 'llm_gateway' ? (
                      <>
                        <Button size="sm" variant="ghost" disabled={busyId === key} onClick={() => void savePoolModelPriority(p, m)}>
                          {busyId === key ? '处理中…' : '保存'}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busyId === key} onClick={() => void deletePoolModel(p, m)}>
                          移除
                        </Button>
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PoolCreateBar({
  draft,
  modelTypes,
  busyId,
  bulkModelType,
  priceCurrencyDraft,
  onDraftChange,
  onBulkModelTypeChange,
  onPriceCurrencyDraftChange,
  onCreate,
  onBulkClaim,
  onCalibratePriceCurrency,
}: {
  draft: { name: string; code: string; modelType: string; priority: string; isDefaultForType: boolean; description: string };
  modelTypes: string[];
  busyId: string | null;
  bulkModelType: string;
  priceCurrencyDraft: PriceCurrencyCalibrationDraft;
  onDraftChange: (draft: { name: string; code: string; modelType: string; priority: string; isDefaultForType: boolean; description: string }) => void;
  onBulkModelTypeChange: (value: string) => void;
  onPriceCurrencyDraftChange: (draft: PriceCurrencyCalibrationDraft) => void;
  onCreate: () => void;
  onBulkClaim: () => void;
  onCalibratePriceCurrency: () => void;
}) {
  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-surface)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input
          value={draft.name}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          placeholder="新 GW 模型池名称"
          style={{ ...inputStyle, flex: '1 1 180px' }}
          aria-label="新 GW 模型池名称"
        />
        <input
          value={draft.code}
          onChange={(e) => onDraftChange({ ...draft, code: e.target.value })}
          placeholder="Code 可选"
          style={{ ...inputStyle, width: 150 }}
          aria-label="模型池 Code"
        />
        <input
          value={draft.modelType}
          onChange={(e) => onDraftChange({ ...draft, modelType: e.target.value })}
          placeholder="chat"
          style={{ ...inputStyle, width: 110 }}
          aria-label="模型类型"
          list="gw-pool-model-types"
        />
        <datalist id="gw-pool-model-types">
          {modelTypes.map((type) => <option key={type} value={type} />)}
        </datalist>
        <input
          value={draft.priority}
          onChange={(e) => onDraftChange({ ...draft, priority: e.target.value })}
          placeholder="50"
          inputMode="numeric"
          style={{ ...inputStyle, width: 72 }}
          aria-label="模型池优先级"
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
          <input
            type="checkbox"
            checked={draft.isDefaultForType}
            onChange={(e) => onDraftChange({ ...draft, isDefaultForType: e.target.checked })}
          />
          默认
        </label>
        <Button size="sm" variant="secondary" disabled={busyId === 'create-pool'} onClick={onCreate}>
          {busyId === 'create-pool' ? '处理中…' : '新建 GW 池'}
        </Button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={bulkModelType} onChange={(e) => onBulkModelTypeChange(e.target.value)} style={{ ...selectStyle, width: 180 }} aria-label="批量认领模型类型">
          <option value="">全部类型</option>
          {modelTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-claim-pools'} onClick={onBulkClaim}>
          {busyId === 'bulk-claim-pools' ? '处理中…' : '批量认领 MAP 池'}
        </Button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>默认跳过已存在的 GW 池，不覆盖已有调整。</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select
          value={priceCurrencyDraft.modelType}
          onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, modelType: e.target.value })}
          style={{ ...selectStyle, width: 180 }}
          aria-label="价格币种校准模型类型"
        >
          <option value="">全部类型</option>
          {modelTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <select
          value={priceCurrencyDraft.targetCurrency}
          onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, targetCurrency: e.target.value })}
          style={{ ...selectStyle, width: 86 }}
          aria-label="价格币种校准目标币种"
        >
          <option value="CNY">CNY</option>
          <option value="USD">USD</option>
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
          <input
            type="checkbox"
            checked={priceCurrencyDraft.onlyMissing}
            onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, onlyMissing: e.target.checked })}
          />
          只补空币种
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
          <input
            type="checkbox"
            checked={priceCurrencyDraft.includeMembersWithoutPrice}
            onChange={(e) => onPriceCurrencyDraftChange({ ...priceCurrencyDraft, includeMembersWithoutPrice: e.target.checked })}
          />
          包含无价格成员
        </label>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-calibrate-price-currency'} onClick={onCalibratePriceCurrency}>
          {busyId === 'bulk-calibrate-price-currency' ? '处理中…' : '校准价格币种'}
        </Button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>只更新平台配置中的模型池，默认仅校准已有价格字段的历史成员。</span>
      </div>
    </div>
  );
}

function PoolEditBar({
  draft,
  busy,
  onDraftChange,
  onSave,
  onCancel,
}: {
  draft: PoolEditDraft;
  busy: boolean;
  onDraftChange: (draft: PoolEditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        marginBottom: 10,
        padding: 10,
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
      }}
    >
      <input
        value={draft.name}
        onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
        placeholder="模型池名称"
        style={{ ...inputStyle, flex: '1 1 180px' }}
        aria-label="模型池名称"
      />
      <input
        value={draft.code}
        onChange={(e) => onDraftChange({ ...draft, code: e.target.value })}
        placeholder="Code"
        style={{ ...inputStyle, width: 150 }}
        aria-label="模型池 Code"
      />
      <input
        value={draft.modelType}
        onChange={(e) => onDraftChange({ ...draft, modelType: e.target.value })}
        placeholder="模型类型"
        style={{ ...inputStyle, width: 110 }}
        aria-label="模型类型"
      />
      <input
        value={draft.priority}
        onChange={(e) => onDraftChange({ ...draft, priority: e.target.value })}
        placeholder="优先级"
        inputMode="numeric"
        style={{ ...inputStyle, width: 82 }}
        aria-label="模型池优先级"
      />
      <select
        value={draft.strategyType}
        onChange={(e) => onDraftChange({ ...draft, strategyType: e.target.value })}
        style={{ ...selectStyle, width: 120 }}
        aria-label="策略类型"
      >
        {Object.entries(STRATEGY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input
        value={draft.description}
        onChange={(e) => onDraftChange({ ...draft, description: e.target.value })}
        placeholder="描述"
        style={{ ...inputStyle, flex: '1 1 220px' }}
        aria-label="模型池描述"
      />
      <Button size="sm" variant="secondary" disabled={busy} onClick={onSave}>
        {busy ? '处理中…' : '保存属性'}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}

function PoolBulkImportBar({
  pool,
  platformIds,
  draft,
  busyId,
  onDraftChange,
  onImport,
}: {
  pool: ModelPool;
  platformIds: string[];
  draft: PoolBulkImportDraft;
  busyId: string | null;
  onDraftChange: (draft: PoolBulkImportDraft) => void;
  onImport: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        marginBottom: 10,
        padding: 10,
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>批量导入成员</span>
      <select
        value={draft.platformId}
        onChange={(e) => onDraftChange({ ...draft, platformId: e.target.value })}
        style={{ ...selectStyle, width: 180 }}
        aria-label="批量导入平台"
      >
        <option value="">全部平台</option>
        {platformIds.map((platformId) => <option key={platformId} value={platformId}>{platformId}</option>)}
      </select>
      <select
        value={draft.capabilityFilter}
        onChange={(e) => onDraftChange({ ...draft, capabilityFilter: e.target.value })}
        style={{ ...selectStyle, width: 160 }}
        aria-label="批量导入能力过滤"
      >
        <option value="compatible">匹配当前池</option>
        <option value="all">全部模型</option>
        <option value="vision">Vision</option>
        <option value="image">Image</option>
        <option value="function_calling">Tool calls</option>
        <option value="parallel_tool_calls">Parallel tools</option>
        <option value="parameter_capabilities">Parameters</option>
        <option value="thinking">Thinking</option>
        <option value="structured_output">Structured output</option>
        <option value="logprobs">Logprobs</option>
        <option value="prompt_cache">Prompt cache</option>
      </select>
      <input
        value={draft.maxCount}
        onChange={(e) => onDraftChange({ ...draft, maxCount: e.target.value })}
        placeholder="200"
        inputMode="numeric"
        style={{ ...inputStyle, width: 76 }}
        aria-label="批量导入最大数量"
      />
      <label style={inlineCheckStyle}>
        <input
          type="checkbox"
          checked={draft.enabledOnly}
          onChange={(e) => onDraftChange({ ...draft, enabledOnly: e.target.checked })}
        />
        仅启用
      </label>
      <label style={inlineCheckStyle}>
        <input
          type="checkbox"
          checked={draft.overwriteExisting}
          onChange={(e) => onDraftChange({ ...draft, overwriteExisting: e.target.checked })}
        />
        覆盖已有
      </label>
      <Button size="sm" variant="ghost" disabled={busyId === `pool-bulk-import:${pool.id}`} onClick={onImport}>
        {busyId === `pool-bulk-import:${pool.id}` ? '处理中…' : '批量导入'}
      </Button>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>只更新平台配置中的模型池，默认跳过已有成员。</span>
    </div>
  );
}

function PoolMemberEditor({
  pool,
  models,
  parameterMeta,
  draft,
  busyId,
  onDraftChange,
  onAdd,
}: {
  pool: ModelPool;
  models: ModelItem[];
  parameterMeta: ParameterCapabilityMetaItem[];
  draft: PoolMemberDraft;
  busyId: string | null;
  onDraftChange: (draft: PoolMemberDraft) => void;
  onAdd: () => void;
}) {
  const [filterMode, setFilterMode] = useState('compatible');
  const filteredModels = models.filter((m) => matchesModelFilter(m, pool.modelType, filterMode));
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        marginBottom: 10,
        padding: 10,
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated)',
      }}
    >
      <select
        value={filterMode}
        onChange={(e) => setFilterMode(e.target.value)}
        style={{ ...selectStyle, width: 150 }}
        aria-label="能力过滤"
      >
        <option value="compatible">匹配当前池</option>
        <option value="all">全部模型</option>
        <option value="vision">Vision</option>
        <option value="image">Image</option>
        <option value="function_calling">Tool calls</option>
        <option value="parallel_tool_calls">Parallel tools</option>
        <option value="parameter_capabilities">Parameters</option>
        <option value="thinking">Thinking</option>
        <option value="structured_output">Structured output</option>
        <option value="logprobs">Logprobs</option>
        <option value="prompt_cache">Prompt cache</option>
      </select>
      <select
        value={draft.modelKey}
        onChange={(e) => onDraftChange({ ...draft, modelKey: e.target.value })}
        style={{ ...selectStyle, flex: '1 1 260px' }}
        aria-label="选择模型"
      >
        <option value="">{filteredModels.length ? '选择要加入的模型' : '当前过滤无可用模型'}</option>
        {filteredModels.map((m) => (
          <option key={modelOptionKey(m)} value={modelOptionKey(m)}>
            {(m.modelName || m.name || m.id)} · {m.platformId || 'no-platform'} · {capabilityLabelsForModel(m).slice(0, 4).join('/')}
          </option>
        ))}
      </select>
      <input
        value={draft.priority}
        onChange={(e) => onDraftChange({ ...draft, priority: e.target.value })}
        placeholder={`P${pool.models.length + 1}`}
        inputMode="numeric"
        style={{ ...inputStyle, width: 84 }}
        aria-label="优先级"
      />
      <input
        value={draft.protocol}
        onChange={(e) => onDraftChange({ ...draft, protocol: e.target.value })}
        placeholder="协议覆盖"
        style={{ ...inputStyle, width: 130 }}
        aria-label="协议覆盖"
      />
      <input
        value={draft.parameterCapabilities}
        onChange={(e) => onDraftChange({ ...draft, parameterCapabilities: e.target.value })}
        placeholder="seed, stop=false"
        list="gw-parameter-capability-options"
        style={{ ...inputStyle, flex: '1 1 180px' }}
        aria-label="字段级参数能力"
        title="字段级参数能力，例：seed, stop=false；保存为 parameter:<name>"
      />
      <Button size="sm" variant="secondary" disabled={busyId === pool.id} onClick={onAdd}>
        {busyId === pool.id ? '处理中…' : '添加/更新'}
      </Button>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{filteredModels.length}/{models.length} 个候选</span>
      {parameterMeta.length ? (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          参数能力 {parameterMeta.length} 项
        </span>
      ) : null}
    </div>
  );
}

function ParameterCapabilityOptions({ parameterMeta }: { parameterMeta: ParameterCapabilityMetaItem[] }) {
  if (parameterMeta.length === 0) return null;
  return (
    <datalist id="gw-parameter-capability-options">
      {parameterMeta.map((item) => (
        <option key={item.capabilityType} value={item.name}>
          {item.label} · {item.category}
        </option>
      ))}
      {parameterMeta.map((item) => (
        <option key={`${item.capabilityType}:false`} value={`${item.name}=false`}>
          {item.label} 不支持
        </option>
      ))}
    </datalist>
  );
}

function CapabilityTags({ labels }: { labels: string[] }) {
  const visible = labels.slice(0, 5);
  if (visible.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {visible.map((label) => (
        <Chip key={label} label={label} color="var(--text-secondary)" bg="var(--bg-surface)" />
      ))}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}

function matchesModelFilter(model: ModelItem, poolModelType: string, filterMode: string) {
  if (filterMode === 'all') return true;
  if (filterMode === 'compatible') return isModelCompatibleWithPool(model, poolModelType);
  if (filterMode === 'vision') return hasModelCapability(model, 'vision', 'image_input', 'multimodal') || model.isVision;
  if (filterMode === 'image') return hasModelCapability(model, 'image_generation', 'text_to_image', 'image') || model.isImageGen;
  if (filterMode === 'function_calling') return hasModelCapability(model, 'function_calling', 'tool_calling', 'tools');
  if (filterMode === 'parallel_tool_calls') return hasParallelToolCallsCapability(model);
  if (filterMode === 'parameter_capabilities') return hasParameterCapabilities(model.capabilities);
  if (filterMode === 'thinking') return hasModelCapability(model, 'thinking', 'reasoning');
  if (filterMode === 'structured_output') return hasStructuredOutputCapability(model);
  if (filterMode === 'logprobs') return hasLogprobsCapability(model);
  if (filterMode === 'prompt_cache') return model.enablePromptCache === true || hasModelCapability(model, 'prompt_cache', 'prompt_caching');
  return true;
}

function isModelCompatibleWithPool(model: ModelItem, poolModelType: string) {
  const type = poolModelType.toLowerCase();
  if (type.includes('vision')) return model.isVision || hasModelCapability(model, 'vision', 'image_input', 'multimodal');
  if (type.includes('image') || type.includes('generation')) return model.isImageGen || hasModelCapability(model, 'image_generation', 'text_to_image', 'image');
  if (type.includes('intent')) return model.isIntent || model.isMain;
  if (type.includes('chat') || type.includes('code')) return model.isMain || model.isIntent || (!model.isImageGen && !type.includes('vision'));
  if (type.includes('asr') || type.includes('speech')) return hasModelCapability(model, 'asr', 'speech_to_text', 'audio');
  if (type.includes('video')) return hasModelCapability(model, 'video_generation', 'video');
  return true;
}

function hasModelCapability(model: ModelItem, ...types: string[]) {
  const wanted = new Set(types.map((x) => x.toLowerCase()));
  return model.capabilities.some((c) => c.value && wanted.has(c.type.toLowerCase()));
}

function hasMemberCapability(member: PoolModelInfo, ...types: string[]) {
  const wanted = new Set(types.map((x) => x.toLowerCase()));
  return member.capabilities.some((c) => c.value && wanted.has(c.type.toLowerCase()));
}

function hasStructuredOutputCapability(model: ModelItem) {
  return hasModelCapability(model, 'structured_output', 'json_schema', 'json_mode', 'response_format');
}

function hasMemberStructuredOutputCapability(member: PoolModelInfo) {
  return hasMemberCapability(member, 'structured_output', 'json_schema', 'json_mode', 'response_format');
}

function hasLogprobsCapability(model: ModelItem) {
  return hasModelCapability(model, 'logprobs', 'top_logprobs', 'token_logprobs');
}

function hasMemberLogprobsCapability(member: PoolModelInfo) {
  return hasMemberCapability(member, 'logprobs', 'top_logprobs', 'token_logprobs');
}

function hasParallelToolCallsCapability(model: ModelItem) {
  return hasModelCapability(model, 'parallel_tool_calls', 'parallel_tools', 'parallel_function_calling');
}

function hasMemberParallelToolCallsCapability(member: PoolModelInfo) {
  return hasMemberCapability(member, 'parallel_tool_calls', 'parallel_tools', 'parallel_function_calling');
}

function hasParameterCapabilities(capabilities: ModelCapability[]) {
  return capabilities.some((c) => parameterCapabilityName(c.type) !== null);
}

function capabilityLabelsForModel(model: ModelItem) {
  return uniqueLabels([
    model.isMain ? 'chat' : '',
    model.isIntent ? 'intent' : '',
    model.isVision ? 'vision' : '',
    model.isImageGen ? 'image' : '',
    model.enablePromptCache ? 'prompt-cache' : '',
    hasStructuredOutputCapability(model) ? 'structured-output' : '',
    hasLogprobsCapability(model) ? 'logprobs' : '',
    hasParallelToolCallsCapability(model) ? 'parallel-tools' : '',
    hasParameterCapabilities(model.capabilities) ? 'parameters' : '',
    ...model.capabilities.filter((c) => c.value).map((c) => c.type),
  ]);
}

function capabilityLabelsForMember(member: PoolModelInfo) {
  return uniqueLabels([
    member.isMain ? 'chat' : '',
    member.isIntent ? 'intent' : '',
    member.isVision ? 'vision' : '',
    member.isImageGen ? 'image' : '',
    member.enablePromptCache ? 'prompt-cache' : '',
    hasMemberCapability(member, 'function_calling', 'tool_calling', 'tools') ? 'tools' : '',
    hasMemberParallelToolCallsCapability(member) ? 'parallel-tools' : '',
    hasMemberCapability(member, 'thinking', 'reasoning') ? 'thinking' : '',
    hasMemberStructuredOutputCapability(member) ? 'structured-output' : '',
    hasMemberLogprobsCapability(member) ? 'logprobs' : '',
    hasParameterCapabilities(member.capabilities) ? 'parameters' : '',
    ...member.capabilities.filter((c) => c.value).map((c) => c.type),
  ]);
}

function uniqueLabels(labels: string[]) {
  return Array.from(new Set(labels.map((x) => x.trim()).filter(Boolean)));
}

function emptyMemberDraft(): PoolMemberDraft {
  return { modelKey: '', priority: '', protocol: '', parameterCapabilities: '' };
}

function emptyBulkImportDraft(): PoolBulkImportDraft {
  return { platformId: '', capabilityFilter: 'compatible', maxCount: '200', enabledOnly: true, overwriteExisting: false };
}

function mergeParameterCapabilities(base: ModelCapability[], text: string): ModelCapability[] {
  const parsed = parseParameterCapabilities(text);
  const next = base.filter((cap) => parameterCapabilityName(cap.type) === null);
  const byName = new Map<string, ModelCapability>();
  for (const capability of base) {
    const name = parameterCapabilityName(capability.type);
    if (name) byName.set(name.toLowerCase(), capability);
  }
  for (const capability of parsed) {
    const name = parameterCapabilityName(capability.type);
    if (name) byName.set(name.toLowerCase(), capability);
  }
  return [...next, ...Array.from(byName.values()).sort((a, b) => a.type.localeCompare(b.type))];
}

function parseParameterCapabilities(text: string): ModelCapability[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawName, rawValue] = part.split('=');
      const name = parameterCapabilityName(rawName) || normalizeParameterName(rawName);
      if (!name) return null;
      return {
        type: `parameter:${name}`,
        source: 'user',
        value: rawValue === undefined ? true : parseCapabilityBool(rawValue),
      };
    })
    .filter((x): x is ModelCapability => x !== null);
}

function parameterCapabilityText(capabilities: ModelCapability[]) {
  return capabilities
    .map((capability) => {
      const name = parameterCapabilityName(capability.type);
      if (!name) return null;
      return capability.value ? name : `${name}=false`;
    })
    .filter((x): x is string => x !== null)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}

function parameterCapabilityName(type: string) {
  const normalized = type.trim();
  for (const prefix of ['parameter:', 'parameter.', 'param:', 'param.']) {
    if (normalized.toLowerCase().startsWith(prefix)) {
      return normalizeParameterName(normalized.slice(prefix.length));
    }
  }
  return null;
}

function normalizeParameterName(value: string) {
  const normalized = value.trim().replace(/\s+/g, '_');
  return /^[a-zA-Z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function parseCapabilityBool(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off';
}

function modelOptionKey(model: ModelItem) {
  return `${model.platformId || ''}::${model.modelName || model.name || model.id}::${model.id}`;
}

function memberKey(poolId: string, member: PoolModelInfo) {
  return `${poolId}::${member.platformId}::${member.modelId}`;
}

function toPositiveInt(value: string | undefined) {
  const normalized = (value || '').trim();
  if (normalized.length === 0) return 1;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function toStrategyType(value: string | undefined) {
  const normalized = (value || '').trim();
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) return null;
  return parsed;
}

const inputStyle = {
  width: '100%',
  height: 30,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  padding: '0 8px',
  fontSize: 12,
};

const selectStyle = {
  ...inputStyle,
};

const inlineCheckStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--text-muted)',
  fontSize: 12,
};

function smallInputStyle(width: number) {
  return {
    ...inputStyle,
    width,
    height: 26,
    padding: '0 6px',
  };
}

function smallSelectStyle(width: number) {
  return {
    ...smallInputStyle(width),
    padding: '0 4px',
  };
}
