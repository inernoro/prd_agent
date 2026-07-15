// 模型池：每个池一张卡，展示策略/类型/默认标记 + 池内每个模型的健康 chip。
// 「默认池」可就地切换：GW 权威池写 llm_gateway，MAP 来源池写旧集合。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bulkCalibratePoolPriceCurrency, bulkClaimPools, bulkImportPoolModels, claimPoolToGateway, createPool, ensurePoolTypes, getModels, getParameterCapabilitiesMeta, getPools, getPoolTypes, removePoolModel, setPoolDefault, updatePool, upsertPoolModel } from '@/lib/api';
import type { ModelCapability, ModelItem, ModelPool, ParameterCapabilityMetaItem, PoolModelInfo, PoolTypesData } from '@/lib/types';
import { Chip, SectionLoader, Button, ReadOnlyNotice } from '@/components/ui';
import { healthChip } from '@/components/poolsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

const STRATEGY_LABEL: Record<number, string> = {
  0: '优先级', 1: '轮询', 2: '加权', 3: '最少连接', 4: '随机', 5: '故障转移',
};
type PoolEditDraft = { name: string; code: string; modelType: string; priority: string; strategyType: string; description: string };
type PoolMemberDraft = { modelKey: string; priority: string; protocol: string; parameterCapabilities: string };
type PoolBulkImportDraft = { platformId: string; capabilityFilter: string; maxCount: string; enabledOnly: boolean; overwriteExisting: boolean };
type PriceCurrencyCalibrationDraft = { modelType: string; targetCurrency: string; onlyMissing: boolean; includeMembersWithoutPrice: boolean };

export function ModelPoolsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [pools, setPools] = useState<ModelPool[] | null>(null);
  const [poolTypes, setPoolTypes] = useState<PoolTypesData | null>(null);
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
  const [drawer, setDrawer] = useState<{ kind: 'create' } | { kind: 'pool'; poolId: string } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getPools(), getPoolTypes(), getModels({ enabled: true }), getParameterCapabilitiesMeta()]).then(([poolRes, typeRes, modelRes, parameterRes]) => {
      if (!alive) return;
      if (poolRes.success) setPools(poolRes.data.items);
      else setError(poolRes.error?.message || '加载失败');
      if (typeRes.success) setPoolTypes(typeRes.data);
      if (modelRes.success) setModels(modelRes.data.items);
      if (parameterRes.success) setParameterMeta(parameterRes.data.items);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function ensureDefaultPools() {
    setBusyId('ensure-pool-types');
    setToast(null);
    const res = await ensurePoolTypes();
    setBusyId(null);
    if (!res.success) {
      setToast(res.error?.message || '补齐失败');
      return;
    }
    setPoolTypes(res.data.types);
    const fresh = await getPools();
    if (fresh.success) setPools(fresh.data.items);
    setToast(`补齐完成：新增 ${res.data.typesCreated} 个类型、${res.data.poolsCreated} 个默认池，追加 ${res.data.modelsAppended} 个兼容模型`);
  }

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
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
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
      isDefaultForType: false,
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
      setDrawer({ kind: 'pool', poolId: res.data.id });
      setToast(`已创建模型池「${res.data.name}」`);
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
        description: publicPoolDescription(pool.description) || '',
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
      code: pool.appendOnly ? undefined : code,
      modelType: pool.appendOnly ? undefined : modelType,
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
        return normalized.map((p) => (p.id === res.data.id ? mergePoolMutation(p, res.data) : p));
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
      priority: pool.appendOnly ? undefined : priority,
      protocol: pool.appendOnly ? undefined : draft.protocol.trim() || undefined,
      enablePromptCache: pool.appendOnly ? undefined : selected.enablePromptCache ?? undefined,
      maxTokens: pool.appendOnly ? undefined : selected.maxTokens ?? undefined,
      capabilities: pool.appendOnly ? undefined : mergeParameterCapabilities(selected.capabilities, draft.parameterCapabilities),
    });
    setBusyId(null);
    if (res.success) {
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
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
      capabilityFilter: pool.appendOnly ? 'compatible' : draft.capabilityFilter,
      enabledOnly: pool.appendOnly ? true : draft.enabledOnly,
      overwriteExisting: pool.appendOnly ? false : draft.overwriteExisting,
      maxCount,
    });
    setBusyId(null);
    if (res.success) {
      if (res.data.pool) {
        setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.pool?.id ? mergePoolMutation(x, res.data.pool) : x)) : prev));
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
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
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
      setPools((prev) => (prev ? prev.map((x) => (x.id === res.data.id ? mergePoolMutation(x, res.data) : x)) : prev));
      setToast(`已从「${res.data.name}」移除「${member.modelId}」`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  if (error) return <Empty text={error} />;
  if (!pools) return <SectionLoader text="正在加载模型池…" />;
  const modelTypes = poolTypes?.items.map((item) => item.code) ?? Array.from(new Set(pools.map((p) => p.modelType).filter(Boolean))).sort();
  const platformIds = Array.from(new Set(models.map((m) => m.platformId).filter((x): x is string => !!x))).sort();
  const selectedPool = drawer?.kind === 'pool' ? pools.find((pool) => pool.id === drawer.poolId) ?? null : null;
  const totalBoundAppCallers = pools.reduce((sum, pool) => sum + pool.boundAppCallerCount, 0);
  const totalRecentRequests = pools.reduce((sum, pool) => sum + pool.recentRequests, 0);
  const attentionPools = pools.filter((pool) => pool.health === 'unavailable' || pool.health === 'empty').length;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ParameterCapabilityOptions parameterMeta={parameterMeta} />
      <section style={{ display: 'flex', gap: 16, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 760 }}>
          <h1 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 24 }}>模型池</h1>
          <p style={{ margin: '7px 0 0', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7 }}>
            模型池把同一类业务需要的多个模型组织成一条稳定路由。先看它服务谁、承接多少请求和是否健康，需要调整时再进入详情。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canWrite ? <Button size="sm" variant="secondary" onClick={() => setDrawer({ kind: 'create' })}>新建模型池</Button> : null}
          <Link to="/learn" style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 12, textDecoration: 'none' }}>了解模型池如何参与路由</Link>
        </div>
      </section>
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      <section style={{ display: 'flex', gap: 14, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
        <div>
          <strong style={{ color: 'var(--text-primary)', fontSize: 14 }}>程序池类型规则</strong>
          <p style={{ margin: '5px 0 0', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
            有则增加，无则不变：只创建缺失类型默认池，只向平台托管默认池追加兼容且未存在的模型，不覆盖、删除或重排已有成员。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip label={`${poolTypes?.total ?? 0} 类规则`} color="var(--accent)" bg="var(--accent-soft)" />
          <Chip label={`${poolTypes?.ready ?? 0} 已可用`} color="#3fb950" bg="rgba(63,185,80,0.14)" />
          <Chip label={`${poolTypes?.waiting ?? 0} 待补模型`} color="#d29922" bg="rgba(210,153,34,0.14)" />
          {canWrite ? <Button size="sm" variant="secondary" disabled={busyId === 'ensure-pool-types'} onClick={() => void ensureDefaultPools()}>
            {busyId === 'ensure-pool-types' ? '正在补齐' : '按平台规则补齐'}
          </Button> : null}
        </div>
      </section>
      {!canWrite ? <ReadOnlyNotice>当前角色可以查看模型池、成员健康和路由使用情况，但不能修改平台配置。</ReadOnlyNotice> : null}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 10 }}>
        <PoolMetric label="模型池" value={String(pools.length)} hint={`${modelTypes.length} 类业务路由`} />
        <PoolMetric label="已绑定 appCaller" value={String(totalBoundAppCallers)} hint="明确绑定到模型池的调用方" />
        <PoolMetric label="近 7 天请求" value={String(totalRecentRequests)} hint="按当前租户请求记录统计" />
        <PoolMetric label="需要处理" value={String(attentionPools)} hint={attentionPools ? '无可用成员或尚未配置成员' : '所有模型池均有可用成员'} tone={attentionPools ? '#d29922' : '#3fb950'} />
      </section>
      {pools.length === 0 ? <Empty text={canWrite ? '暂无模型池，可先新建第一个模型池' : '当前租户暂无模型池，请联系 Owner 或 Admin 配置'} /> : null}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 330px), 1fr))', gap: 12 }}>
        {pools.map((pool) => <PoolOverviewCard key={pool.id} pool={pool} busyId={busyId} canWrite={canWrite} onOpen={() => setDrawer({ kind: 'pool', poolId: pool.id })} onMakeDefault={() => void makeDefault(pool)} />)}
      </section>
      {canWrite ? <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)', padding: 12 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }}>高级维护</summary>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>用于批量导入历史配置和校准价格币种。日常查看与路由判断不需要操作这里。</p>
        <PoolCreateBar
          mode="advanced"
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
      </details> : null}
      {drawer ? (
        <div role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDrawer(null); }} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.42)', display: 'flex', justifyContent: 'flex-end' }}>
          <aside role="dialog" aria-modal="true" aria-label={drawer.kind === 'create' ? '新建模型池' : '模型池详情'} style={{ width: 'min(680px, 100vw)', height: '100%', overflowY: 'auto', background: 'var(--bg-surface)', borderLeft: '1px solid var(--border-subtle)', padding: 18, boxShadow: '-16px 0 40px rgba(0,0,0,0.22)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
              <div style={{ flex: 1 }}><h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 19 }}>{drawer.kind === 'create' ? '新建模型池' : selectedPool?.name || '模型池详情'}</h2><p style={{ margin: '5px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>{drawer.kind === 'create' ? '先定义业务类型，再添加实际承接流量的模型。' : poolPurpose(selectedPool)}</p></div>
              <Button size="sm" variant="ghost" onClick={() => setDrawer(null)}>关闭</Button>
            </div>
            {drawer.kind === 'create' && canWrite ? (
              <PoolCreateBar
                mode="create"
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
            ) : selectedPool ? (
              <>
                <PoolDetailSummary pool={selectedPool} />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
                  {canWrite ? (selectedPool.authority === 'llm_gateway' ? <Button size="sm" variant="secondary" onClick={() => (editDrafts[selectedPool.id] ? cancelEditPool(selectedPool.id) : startEditPool(selectedPool))}>{editDrafts[selectedPool.id] ? '取消编辑' : '编辑属性'}</Button> : <Button size="sm" variant="secondary" disabled={busyId === selectedPool.id} onClick={() => void claimPool(selectedPool)}>导入为可维护配置</Button>) : null}
                  {canWrite && !selectedPool.isDefaultForType ? <Button size="sm" variant="ghost" disabled={busyId === selectedPool.id} onClick={() => void makeDefault(selectedPool)}>设为默认池</Button> : null}
                  <Link to={`/app-callers?modelPoolId=${encodeURIComponent(selectedPool.id)}`} style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 12, textDecoration: 'none' }}>查看 appCaller</Link>
                  <Link to={`/logs?modelPoolId=${encodeURIComponent(selectedPool.id)}`} style={{ alignSelf: 'center', color: 'var(--accent)', fontSize: 12, textDecoration: 'none' }}>查看请求记录</Link>
                </div>
                {canWrite && editDrafts[selectedPool.id] ? <PoolEditBar draft={editDrafts[selectedPool.id]} managed={selectedPool.appendOnly} busy={busyId === `pool-edit:${selectedPool.id}`} onDraftChange={(next) => setEditDrafts((prev) => ({ ...prev, [selectedPool.id]: next }))} onSave={() => void savePool(selectedPool)} onCancel={() => cancelEditPool(selectedPool.id)} /> : null}
                {canWrite && selectedPool.authority === 'llm_gateway' ? <PoolMemberEditor pool={selectedPool} models={models} parameterMeta={parameterMeta} draft={addDrafts[selectedPool.id] || emptyMemberDraft()} busyId={busyId} onDraftChange={(next) => setAddDrafts((prev) => ({ ...prev, [selectedPool.id]: next }))} onAdd={() => void addPoolModel(selectedPool)} /> : null}
                {selectedPool.appendOnly ? <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>平台托管默认池只追加同类型、已启用且未存在的权威模型。已有成员的顺序、价格、协议和能力不可在这里覆盖或删除；特殊配置请新建专用模型池。</div> : null}
                <h3 style={{ color: 'var(--text-primary)', fontSize: 14, margin: '18px 0 8px' }}>模型成员</h3>
                <PoolMembers pool={selectedPool} busyId={busyId} canWrite={canWrite} memberPriorities={memberPriorities} memberParameterCaps={memberParameterCaps} onPriorityChange={(key, value) => setMemberPriorities((prev) => ({ ...prev, [key]: value }))} onParameterChange={(key, value) => setMemberParameterCaps((prev) => ({ ...prev, [key]: value }))} onCurrencyChange={updateMemberPriceCurrency} onSave={savePoolModelPriority} onDelete={deletePoolModel} />
                {canWrite && selectedPool.authority === 'llm_gateway' ? <details style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}><summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12 }}>高级成员维护</summary><div style={{ marginTop: 10 }}><PoolBulkImportBar pool={selectedPool} platformIds={platformIds} draft={bulkImportDrafts[selectedPool.id] || emptyBulkImportDraft()} busyId={busyId} onDraftChange={(next) => setBulkImportDrafts((prev) => ({ ...prev, [selectedPool.id]: next }))} onImport={() => void bulkImportModels(selectedPool)} /></div></details> : null}
              </>
            ) : <Empty text="模型池不存在或已被移除" />}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function PoolMetric({ label, value, hint, tone = 'var(--text-primary)' }: { label: string; value: string; hint: string; tone?: string }) {
  return <div style={{ padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}><div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</div><div style={{ marginTop: 5, color: tone, fontSize: 23, fontWeight: 700 }}>{value}</div><div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5 }}>{hint}</div></div>;
}

function PoolOverviewCard({ pool, busyId, canWrite, onOpen, onMakeDefault }: { pool: ModelPool; busyId: string | null; canWrite: boolean; onOpen: () => void; onMakeDefault: () => void }) {
  const status = poolHealthChip(pool);
  const visibleModels = pool.models.slice().sort((a, b) => a.priority - b.priority).slice(0, 3);
  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: 16, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}><strong style={{ color: 'var(--text-primary)', fontSize: 15 }}>{pool.name}</strong><Chip label={pool.modelType || 'chat'} color="var(--accent)" bg="var(--accent-soft)" />{pool.isDefaultForType ? <Chip label="默认路由" color="#3fb950" bg="rgba(63,185,80,0.14)" /> : null}{pool.appendOnly ? <Chip label="平台托管，只追加" color="var(--text-secondary)" bg="var(--bg-elevated)" /> : null}</div><p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.65, margin: '7px 0 0' }}>{poolPurpose(pool)}</p></div>
        <Chip label={status.label} color={status.color} bg={status.bg} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <CardStat label="绑定" value={`${pool.boundAppCallerCount} 个`} />
        <CardStat label="近 7 天" value={`${pool.recentRequests} 次`} />
        <CardStat label="成功率" value={pool.recentSuccessRatePercent == null ? '暂无数据' : `${pool.recentSuccessRatePercent}%`} />
      </div>
      <div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 7 }}>模型组成</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {visibleModels.length ? visibleModels.map((model) => { const chip = healthChip(model.healthStatus); return <div key={`${model.platformId}:${model.modelId}`} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, color: 'var(--text-secondary)', fontSize: 12 }}><span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: chip.color }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.modelId}</span><span style={{ marginLeft: 'auto', color: 'var(--text-muted)', flexShrink: 0 }}>优先级 {model.priority}</span></div>; }) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>尚未添加模型，当前不能承接请求。</span>}
          {pool.models.length > visibleModels.length ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>另有 {pool.models.length - visibleModels.length} 个模型</span> : null}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto' }}><Button size="sm" variant="secondary" onClick={onOpen}>{canWrite ? '查看与维护' : '查看详情'}</Button>{canWrite && !pool.isDefaultForType ? <Button size="sm" variant="ghost" disabled={busyId === pool.id} onClick={onMakeDefault}>设为默认</Button> : null}<span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>{formatRecentTime(pool.lastRequestAt)}</span></div>
    </article>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return <div style={{ padding: '9px 8px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', minWidth: 0 }}><div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{label}</div><div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 650, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div></div>;
}

function PoolDetailSummary({ pool }: { pool: ModelPool }) {
  const status = poolHealthChip(pool);
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-elevated)' }}><div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}><Chip label={status.label} color={status.color} bg={status.bg} /><Chip label={STRATEGY_LABEL[pool.strategyType] || `策略 ${pool.strategyType}`} color="var(--text-secondary)" bg="var(--bg-surface)" />{pool.isDefaultForType ? <Chip label={`${pool.modelType} 默认池`} color="#3fb950" bg="rgba(63,185,80,0.14)" /> : null}{pool.appendOnly ? <Chip label="平台托管，只追加" color="var(--text-secondary)" bg="var(--bg-surface)" /> : null}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}><CardStat label="绑定 appCaller" value={`${pool.boundAppCallerCount} 个`} /><CardStat label="近 7 天请求" value={`${pool.recentRequests} 次`} /><CardStat label="成功率" value={pool.recentSuccessRatePercent == null ? '暂无数据' : `${pool.recentSuccessRatePercent}%`} /><CardStat label="成员健康" value={`${pool.healthyMembers} 健康 / ${pool.unavailableMembers} 不可用`} /></div>{pool.boundAppCallers.length ? <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.65 }}>服务对象：{pool.boundAppCallers.map((caller) => caller.title || caller.appCallerCode).join('、')}{pool.boundAppCallerCount > pool.boundAppCallers.length ? ` 等 ${pool.boundAppCallerCount} 个` : ''}</div> : <div style={{ color: '#d29922', fontSize: 12 }}>尚无明确绑定的 appCaller。若它是默认池，仍可能承接同类型的自动路由流量。</div>}</section>;
}

function PoolMembers({ pool, busyId, canWrite, memberPriorities, memberParameterCaps, onPriorityChange, onParameterChange, onCurrencyChange, onSave, onDelete }: { pool: ModelPool; busyId: string | null; canWrite: boolean; memberPriorities: Record<string, string>; memberParameterCaps: Record<string, string>; onPriorityChange: (key: string, value: string) => void; onParameterChange: (key: string, value: string) => void; onCurrencyChange: (poolId: string, member: PoolModelInfo, value: string) => void; onSave: (pool: ModelPool, member: PoolModelInfo) => Promise<void>; onDelete: (pool: ModelPool, member: PoolModelInfo) => Promise<void> }) {
  if (!pool.models.length) return <div style={{ padding: 16, border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', fontSize: 12 }}>暂无模型成员。添加至少一个健康模型后，这个池才能承接请求。</div>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{pool.models.slice().sort((a, b) => a.priority - b.priority).map((member) => { const chip = healthChip(member.healthStatus); const key = memberKey(pool.id, member); return <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 10, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}><Chip label={chip.label} color={chip.color} bg={chip.bg} /><span style={{ color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{member.modelId}</span>{member.protocol ? <span style={{ color: 'var(--text-muted)' }}>{member.protocol}</span> : null}<CapabilityTags labels={capabilityLabelsForMember(member)} />{canWrite && pool.authority === 'llm_gateway' && !pool.appendOnly ? <><label style={inlineCheckStyle}>优先级<input value={memberPriorities[key] ?? String(member.priority)} onChange={(event) => onPriorityChange(key, event.target.value)} style={smallInputStyle(58)} inputMode="numeric" /></label><select value={(member.priceCurrency || 'CNY').toUpperCase()} onChange={(event) => onCurrencyChange(pool.id, member, event.target.value)} style={smallSelectStyle(74)} aria-label="价格币种"><option value="CNY">CNY</option><option value="USD">USD</option></select><input value={memberParameterCaps[key] ?? parameterCapabilityText(member.capabilities)} onChange={(event) => onParameterChange(key, event.target.value)} placeholder="字段能力，例如 seed" list="gw-parameter-capability-options" style={{ ...inputStyle, flex: '1 1 170px' }} aria-label="字段级参数能力" /><span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}><Button size="sm" variant="ghost" disabled={busyId === key} onClick={() => void onSave(pool, member)}>保存</Button><Button size="sm" variant="ghost" disabled={busyId === key} onClick={() => void onDelete(pool, member)}>移除</Button></span></> : <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>优先级 {member.priority}</span>}</div>; })}</div>;
}

function poolPurpose(pool: ModelPool | null) {
  if (!pool) return '';
  if (pool.boundAppCallerCount > 0) {
    const names = pool.boundAppCallers.slice(0, 2).map((caller) => caller.title || caller.appCallerCode).filter(Boolean);
    return `为 ${names.join('、')}${pool.boundAppCallerCount > names.length ? ` 等 ${pool.boundAppCallerCount} 个 appCaller` : ''} 提供 ${pool.modelType || 'chat'} 路由。`;
  }
  if (pool.isDefaultForType) return `作为 ${pool.modelType || 'chat'} 类型的默认路由，在调用方未指定其他池时提供模型选择。`;
  return `用于组织 ${pool.modelType || 'chat'} 模型；尚未绑定业务，当前不会承接已登记 appCaller 的指定流量。`;
}

function poolHealthChip(pool: ModelPool) {
  if (pool.health === 'healthy') return { label: '运行健康', color: '#3fb950', bg: 'rgba(63,185,80,0.14)' };
  if (pool.health === 'degraded') return { label: '部分模型异常', color: '#d29922', bg: 'rgba(210,153,34,0.14)' };
  if (pool.health === 'unavailable') return { label: '无可用模型', color: '#f85149', bg: 'rgba(248,81,73,0.14)' };
  return { label: '尚未配置模型', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
}

function formatRecentTime(value?: string | null) {
  if (!value) return '近 7 天无请求';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '最近有请求' : `最近请求 ${date.toLocaleString()}`;
}

function publicPoolDescription(value?: string | null) {
  if (!value) return null;
  return /\b(?:P\d+|legacy|stub|full-http|gate)\b|权威|迁移|兜底/i.test(value) ? null : value;
}

function mergePoolMutation(previous: ModelPool, next: ModelPool): ModelPool {
  const healthyMembers = next.models.filter((model) => model.healthStatus === 0).length;
  const degradedMembers = next.models.filter((model) => model.healthStatus === 1).length;
  const unavailableMembers = next.models.filter((model) => model.healthStatus === 2).length;
  const health: ModelPool['health'] = next.models.length === 0
    ? 'empty'
    : healthyMembers === 0
      ? 'unavailable'
      : degradedMembers > 0 || unavailableMembers > 0
        ? 'degraded'
        : 'healthy';
  return {
    ...next,
    boundAppCallerCount: previous.boundAppCallerCount,
    boundAppCallers: previous.boundAppCallers,
    recentRequests: previous.recentRequests,
    recentSucceeded: previous.recentSucceeded,
    recentFailed: previous.recentFailed,
    recentSuccessRatePercent: previous.recentSuccessRatePercent,
    lastRequestAt: previous.lastRequestAt,
    trafficWindowHours: previous.trafficWindowHours,
    health,
    healthyMembers,
    degradedMembers,
    unavailableMembers,
  };
}

function PoolCreateBar({
  mode,
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
  mode: 'create' | 'advanced';
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
      {mode === 'create' ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input
          value={draft.name}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          placeholder="模型池名称，例如客服对话"
          style={{ ...inputStyle, flex: '1 1 180px' }}
          aria-label="新模型池名称"
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
        <Button size="sm" variant="secondary" disabled={busyId === 'create-pool'} onClick={onCreate}>
          {busyId === 'create-pool' ? '处理中…' : '创建模型池'}
        </Button>
        <input value={draft.description} onChange={(e) => onDraftChange({ ...draft, description: e.target.value })} placeholder="业务说明（可选）" style={{ ...inputStyle, flex: '1 1 100%' }} aria-label="模型池业务说明" />
      </div> : null}
      {mode === 'advanced' ? <><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={bulkModelType} onChange={(e) => onBulkModelTypeChange(e.target.value)} style={{ ...selectStyle, width: 180 }} aria-label="批量认领模型类型">
          <option value="">全部类型</option>
          {modelTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <Button size="sm" variant="ghost" disabled={busyId === 'bulk-claim-pools'} onClick={onBulkClaim}>
          {busyId === 'bulk-claim-pools' ? '处理中…' : '批量导入历史模型池'}
        </Button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>默认跳过已存在的平台模型池，不覆盖已有调整。</span>
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
      </div></> : null}
    </div>
  );
}

function PoolEditBar({
  draft,
  managed,
  busy,
  onDraftChange,
  onSave,
  onCancel,
}: {
  draft: PoolEditDraft;
  managed: boolean;
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
        disabled={managed}
      />
      <input
        value={draft.modelType}
        onChange={(e) => onDraftChange({ ...draft, modelType: e.target.value })}
        placeholder="模型类型"
        style={{ ...inputStyle, width: 110 }}
        aria-label="模型类型"
        disabled={managed}
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
        value={pool.appendOnly ? 'compatible' : draft.capabilityFilter}
        onChange={(e) => onDraftChange({ ...draft, capabilityFilter: e.target.value })}
        style={{ ...selectStyle, width: 160 }}
        aria-label="批量导入能力过滤"
        disabled={pool.appendOnly}
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
          checked={pool.appendOnly || draft.enabledOnly}
          onChange={(e) => onDraftChange({ ...draft, enabledOnly: e.target.checked })}
          disabled={pool.appendOnly}
        />
        仅启用
      </label>
      <label style={inlineCheckStyle}>
        <input
          type="checkbox"
          checked={!pool.appendOnly && draft.overwriteExisting}
          onChange={(e) => onDraftChange({ ...draft, overwriteExisting: e.target.checked })}
          disabled={pool.appendOnly}
        />
        覆盖已有
      </label>
      <Button size="sm" variant="ghost" disabled={busyId === `pool-bulk-import:${pool.id}`} onClick={onImport}>
        {busyId === `pool-bulk-import:${pool.id}` ? '处理中…' : '批量导入'}
      </Button>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pool.appendOnly ? '平台托管池固定只导入已启用、同类型且未存在的模型。' : '只更新平台配置中的模型池，默认跳过已有成员。'}</span>
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
  const effectiveFilterMode = pool.appendOnly ? 'compatible' : filterMode;
  const existingMembers = new Set(pool.models.map((member) => `${member.platformId || ''}::${member.modelId}`));
  const filteredModels = models.filter((model) => {
    const modelId = model.modelName || model.name || model.id;
    return model.enabled
      && !existingMembers.has(`${model.platformId || ''}::${modelId}`)
      && matchesModelFilter(model, pool.modelType, effectiveFilterMode);
  });
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
        value={effectiveFilterMode}
        onChange={(e) => setFilterMode(e.target.value)}
        disabled={pool.appendOnly}
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
      {!pool.appendOnly ? (
        <>
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
        </>
      ) : null}
      <Button size="sm" variant="secondary" disabled={busyId === pool.id} onClick={onAdd}>
        {busyId === pool.id ? '处理中…' : pool.appendOnly ? '追加模型' : '添加/更新'}
      </Button>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {filteredModels.length} 个可追加候选{pool.appendOnly ? '，已过滤已有成员与不匹配模型' : ''}
      </span>
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
  if (type === 'vision') return model.isVision || hasModelCapability(model, 'vision', 'image_input', 'multimodal');
  if (type === 'generation') return model.isImageGen || hasModelCapability(model, 'image_generation', 'text_to_image', 'image');
  if (type === 'intent') return model.isIntent || model.isMain;
  if (type === 'chat') return model.isMain || model.isIntent || hasModelCapability(model, 'chat', 'text_generation', 'reasoning');
  if (type === 'code') return hasModelCapability(model, 'code', 'code_generation', 'code_completion');
  if (type === 'long-context') return model.isMain || hasModelCapability(model, 'long_context', 'long-context');
  if (type === 'embedding') return hasModelCapability(model, 'embedding', 'embeddings', 'vector');
  if (type === 'rerank') return hasModelCapability(model, 'rerank', 'reranking');
  if (type === 'asr') return hasModelCapability(model, 'asr', 'speech_to_text', 'audio_input');
  if (type === 'tts') return hasModelCapability(model, 'tts', 'text_to_speech', 'audio_output');
  if (type === 'video-gen') return hasModelCapability(model, 'video_generation', 'text_to_video', 'image_to_video', 'video');
  if (type === 'audio-gen') return hasModelCapability(model, 'audio_generation', 'music_generation', 'audio');
  if (type === 'moderation') return hasModelCapability(model, 'moderation', 'safety', 'content_filter');
  return false;
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
