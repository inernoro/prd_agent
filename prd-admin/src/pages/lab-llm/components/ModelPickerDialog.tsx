import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import type { Model, Platform } from '@/types/admin';
import type { ModelLabSelectedModel } from '@/services/contracts/modelLab';
import { apiRequest } from '@/services/real/apiClient';
import { Minus, Plus, RefreshCw, Search } from 'lucide-react';
import { deleteModelLabGroup, listModelLabGroups, upsertModelLabGroup } from '@/services';
import type { ModelLabGroup } from '@/services/contracts/modelLabGroups';

type TabKey = 'byPlatform' | 'byLabGroup';

type AvailableModel = {
  modelName: string;
  displayName: string;
  group?: string;
};

function keyOf(m: Pick<ModelLabSelectedModel, 'platformId' | 'modelName'>) {
  return `${m.platformId}:${m.modelName}`.toLowerCase();
}

function dedupePreferConfigured(
  list: ModelLabSelectedModel[],
  configuredModelIds: Set<string>
): ModelLabSelectedModel[] {
  const map = new Map<string, ModelLabSelectedModel>();
  for (const item of list) {
    const k = keyOf(item);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, item);
      continue;
    }
    const prevIsConfigured = configuredModelIds.has(prev.modelId);
    const curIsConfigured = configuredModelIds.has(item.modelId);
    // 同一平台同一 modelName：优先保留“已配置模型”（modelId 是 llmmodels 的 id），否则保持已有
    if (!prevIsConfigured && curIsConfigured) map.set(k, item);
  }
  return Array.from(map.values());
}

function toSelectedModelFromAvailable(args: {
  platformId: string;
  modelName: string;
  displayName: string;
  group?: string;
  configuredModel?: Model | null;
}): ModelLabSelectedModel {
  const configured = args.configuredModel;
  if (configured) {
    return {
      modelId: configured.id,
      platformId: configured.platformId || args.platformId,
      name: configured.name || configured.modelName || args.displayName,
      modelName: configured.modelName || args.modelName,
      group: configured.group ?? args.group ?? null,
    };
  }
  // 未在 llmmodels 配置过的模型：用 modelName 作为“模型 id”（后端会按 platform 回退直接调用）
  return {
    modelId: args.modelName,
    platformId: args.platformId,
    name: args.displayName || args.modelName,
    modelName: args.modelName,
    group: args.group ?? null,
  };
}

function modelCategory(m: AvailableModel) {
  const s = (m.modelName || '').toLowerCase();
  if (/(embed|embedding)/.test(s)) return 'embedding' as const;
  if (/(rerank|re-rank)/.test(s)) return 'rerank' as const;
  if (/(vision|vl|image)/.test(s)) return 'vision' as const;
  if (/(search|web|online|联网)/.test(s)) return 'web' as const;
  if (/(free|gratis|免费)/.test(s)) return 'free' as const;
  if (/(tool|tools|function)/.test(s)) return 'tools' as const;
  return 'reasoning' as const;
}

function autoGroupKey(rawName: string) {
  const s = (rawName || '').trim().toLowerCase();
  const parts = s.replace(/\//g, '-').split('-').filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  if (parts.length >= 1) return parts[0];
  return 'other';
}

function groupAvailableModels(list: AvailableModel[]) {
  const buckets: Record<string, AvailableModel[]> = {};
  for (const m of list) {
    const key = (m.group || autoGroupKey(m.modelName) || 'other').toLowerCase();
    (buckets[key] ||= []).push(m);
  }

  // 模型数量不足 3 的分组统一并入 other
  const merged: Record<string, AvailableModel[]> = {};
  const other: AvailableModel[] = [];
  for (const [k, ms] of Object.entries(buckets)) {
    if (k !== 'other' && ms.length < 3) other.push(...ms);
    else merged[k] = ms;
  }
  if (buckets.other) other.push(...buckets.other);
  if (other.length > 0) merged.other = other;

  // 同组内按“名字”排序（优先 displayName，其次 modelName）
  for (const ms of Object.values(merged)) {
    ms.sort((a, b) => {
      const an = ((a.displayName || a.modelName) || '').trim();
      const bn = ((b.displayName || b.modelName) || '').trim();
      return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  return Object.entries(merged).sort((a, b) => {
    const ao = a[0] === 'other';
    const bo = b[0] === 'other';
    if (ao !== bo) return ao ? 1 : -1;
    return b[1].length - a[1].length;
  });
}

function PlatformAvailableDialog({
  open,
  onOpenChange,
  platform,
  allModels,
  selected,
  setSelected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Platform | null;
  allModels: Model[];
  selected: ModelLabSelectedModel[];
  setSelected: (updater: (prev: ModelLabSelectedModel[]) => ModelLabSelectedModel[]) => void;
}) {
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableSearch, setAvailableSearch] = useState('');
  const [availableTab, setAvailableTab] = useState<'all' | 'reasoning' | 'vision' | 'web' | 'free' | 'embedding' | 'rerank' | 'tools'>('all');
  const [openAvailableGroups, setOpenAvailableGroups] = useState<Record<string, boolean>>({});

  const configuredModelIds = useMemo(() => new Set(allModels.map((m) => m.id)), [allModels]);

  const selectedKeySet = useMemo(() => new Set(selected.map((m) => keyOf(m))), [selected]);

  const filteredAvailableModels = useMemo(() => {
    let list = availableModels;
    if (availableTab !== 'all') list = list.filter((m) => modelCategory(m) === availableTab);
    const s = availableSearch.trim().toLowerCase();
    if (!s) return list;
    return list.filter((m) => (m.modelName || '').toLowerCase().includes(s) || (m.displayName || '').toLowerCase().includes(s));
  }, [availableModels, availableSearch, availableTab]);

  const groupedAvailable = useMemo(() => groupAvailableModels(filteredAvailableModels), [filteredAvailableModels]);

  useEffect(() => {
    if (!open) return;
    setAvailableSearch('');
    setAvailableTab('all');
    setAvailableModels([]);
    setAvailableError(null);
    setOpenAvailableGroups({});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!platform?.id) return;
    const first = groupedAvailable[0]?.[0];
    if (!first) return;
    setOpenAvailableGroups((prev) => {
      if (Object.keys(prev).length === 0) return { [first]: true };
      if (prev[first] === undefined) return { ...prev, [first]: true };
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedAvailable.length, open, platform?.id]);

  const fetchAvailableModels = async (opts?: { refresh?: boolean }) => {
    if (!platform?.id) return;
    setAvailableLoading(true);
    setAvailableError(null);
    try {
      const isRefresh = !!opts?.refresh;
      const r = await apiRequest<AvailableModel[]>(
        isRefresh ? `/api/v1/platforms/${platform.id}/refresh-models` : `/api/v1/platforms/${platform.id}/available-models`,
        isRefresh ? { method: 'POST', body: {} } : { method: 'GET' }
      );
      if (!r.success) {
        setAvailableError(r.error?.message || '获取模型列表失败');
        setAvailableModels([]);
        return;
      }
      setAvailableModels(r.data || []);
    } finally {
      setAvailableLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!platform?.id) return;
    fetchAvailableModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform?.id]);

  const configuredByModelName = useMemo(() => {
    if (!platform?.id) return new Map<string, Model>();
    const map = new Map<string, Model>();
    for (const m of allModels) {
      if (!m.enabled) continue;
      if (m.platformId !== platform.id) continue;
      if (!map.has(m.modelName)) map.set(m.modelName, m);
    }
    return map;
  }, [allModels, platform?.id]);

  const bulkAddGroup = (ms: AvailableModel[]) => {
    if (!platform?.id) return;
    const adds = ms.map((m) =>
      toSelectedModelFromAvailable({
        platformId: platform.id,
        modelName: m.modelName,
        displayName: m.displayName || m.modelName,
        group: m.group,
        configuredModel: configuredByModelName.get(m.modelName) ?? null,
      })
    );
    setSelected((prev) => [...prev, ...adds]);
  };

  const togglePoolModel = (m: AvailableModel) => {
    if (!platform?.id) return;
    const k = keyOf({ platformId: platform.id, modelName: m.modelName });
    const exists = selectedKeySet.has(k);
    if (exists) {
      setSelected((prev) => prev.filter((x) => keyOf(x) !== k));
      return;
    }

    const selected = toSelectedModelFromAvailable({
      platformId: platform.id,
      modelName: m.modelName,
      displayName: m.displayName || m.modelName,
      group: m.group,
      configuredModel: configuredByModelName.get(m.modelName) ?? null,
    });
    setSelected((prev) => dedupePreferConfigured([...prev, selected], configuredModelIds));
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => onOpenChange(o)}
      title={`${platform?.name ?? ''}模型`}
      description="从平台可用模型列表中一键添加/移除（仅加入到本次实验的选择池）"
      maxWidth={600}
      contentStyle={{ height: 'min(80vh, 720px)' }}
      content={
        <div className="h-full min-h-0 flex flex-col space-y-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={availableSearch}
                onChange={(e) => setAvailableSearch(e.target.value)}
                type="search"
                name="available-model-search"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                className="h-10 w-full rounded-[14px] pl-9 pr-4 text-sm outline-none"
                style={inputStyle}
                placeholder="搜索模型 ID 或名称"
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await fetchAvailableModels({ refresh: true });
              }}
              disabled={!platform?.id || availableLoading}
              aria-label="刷新"
            >
              <RefreshCw size={16} className={availableLoading ? 'animate-spin' : ''} />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {(
              [
                ['all', '全部'],
                ['reasoning', '推理'],
                ['vision', '视觉'],
                ['web', '联网'],
                ['free', '免费'],
                ['embedding', '嵌入'],
                ['rerank', '重排'],
                ['tools', '工具'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setAvailableTab(k)}
                className="px-1 pb-2 text-sm transition-colors"
                style={{
                  color: availableTab === k ? 'rgba(34,197,94,0.95)' : 'var(--text-secondary)',
                  borderBottom: availableTab === k ? '2px solid rgba(34,197,94,0.95)' : '2px solid transparent',
                }}
              >
                {label}
              </button>
            ))}
            <div className="flex-1" />
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              可用 {filteredAvailableModels.length} 个 · 已加入 {selected.filter((x) => x.platformId === platform?.id).length} 个
            </div>
          </div>

          <div className="rounded-[16px] overflow-hidden flex flex-col flex-1 min-h-0" style={{ border: '1px solid var(--border-subtle)' }}>
            {availableLoading ? (
              <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>
                加载中...
              </div>
            ) : availableError ? (
              <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>
                {availableError}
              </div>
            ) : groupedAvailable.length === 0 ? (
              <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>
                暂无可用模型
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-auto">
                <div className="space-y-2 p-2">
                  {groupedAvailable.map(([g, ms]) => (
                    <details
                      key={g}
                      className="rounded-[14px] overflow-hidden"
                      style={{ border: '1px solid var(--border-subtle)' }}
                      open={!!openAvailableGroups[g]}
                      onToggle={(e) => {
                        const nextOpen = (e.currentTarget as HTMLDetailsElement).open;
                        setOpenAvailableGroups((prev) => ({ ...prev, [g]: nextOpen }));
                      }}
                    >
                      <summary className="px-4 py-3 flex items-center justify-between cursor-pointer select-none" style={{ background: 'rgba(255,255,255,0.03)' }}>
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {g}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {ms.length} 个
                          </div>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center h-[26px] w-[26px] rounded-[10px] hover:bg-white/6"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                            title="批量加入该组"
                            onClick={(e) => {
                              e.preventDefault(); // 避免触发 summary toggle
                              e.stopPropagation();
                              bulkAddGroup(ms);
                            }}
                          >
                            <Plus size={16} />
                          </button>
                        </div>
                      </summary>
                      <div className="divide-y divide-white/30">
                        {ms.map((m) => {
                          const k = keyOf({ platformId: platform?.id ?? '', modelName: m.modelName });
                          const exist = selectedKeySet.has(k);
                          const label = (m.displayName || m.modelName).trim();
                          return (
                            <div
                              key={`${g}:${m.modelName}`}
                              className="px-4 py-3 flex items-center justify-between transition-colors"
                              style={{ background: exist ? 'rgba(34,197,94,0.08)' : 'transparent' }}
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                  {label}
                                </div>
                                <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                                  {m.modelName}
                                </div>
                              </div>
                              <Button
                                variant={exist ? 'secondary' : 'ghost'}
                                size="sm"
                                onClick={() => togglePoolModel(m)}
                                disabled={availableLoading}
                                aria-label={exist ? '移除' : '添加'}
                              >
                                {exist ? <Minus size={16} /> : <Plus size={16} />}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      }
    />
  );
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  allModels,
  selectedModels,
  platforms,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allModels: Model[];
  selectedModels: ModelLabSelectedModel[];
  platforms: Platform[];
  onConfirm: (models: ModelLabSelectedModel[]) => void;
}) {
  const configuredModelIds = useMemo(() => new Set(allModels.map((m) => m.id)), [allModels]);

  const [tab, setTab] = useState<TabKey>('byPlatform');

  // 下栏共享池：作为“最终会加入到实验”的模型集合（初始化为当前 selectedModels）
  const [pool, setPoolRaw] = useState<ModelLabSelectedModel[]>([]);

  const setPool = (updater: (prev: ModelLabSelectedModel[]) => ModelLabSelectedModel[]) => {
    setPoolRaw((prev) => dedupePreferConfigured(updater(prev), configuredModelIds));
  };

  useEffect(() => {
    if (!open) return;
    // 每次打开都从外部当前选择初始化，避免上次未确认的临时选择污染
    setTab('byPlatform');
    setPoolRaw(dedupePreferConfigured(selectedModels ?? [], configuredModelIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const [availableOpen, setAvailableOpen] = useState(false);
  const [availablePlatform, setAvailablePlatform] = useState<Platform | null>(null);
  const [availableTarget, setAvailableTarget] = useState<'pool' | 'group'>('pool');

  // 实验室分组
  const [labGroups, setLabGroups] = useState<ModelLabGroup[]>([]);
  const [labGroupsLoading, setLabGroupsLoading] = useState(false);
  const [labGroupSearch, setLabGroupSearch] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  const [groupDraftName, setGroupDraftName] = useState('');
  const [groupDraftModels, setGroupDraftModelsRaw] = useState<ModelLabSelectedModel[]>([]);
  const [groupAddPlatformId, setGroupAddPlatformId] = useState<string>('');

  const setGroupDraftModels = (updater: (prev: ModelLabSelectedModel[]) => ModelLabSelectedModel[]) => {
    setGroupDraftModelsRaw((prev) => dedupePreferConfigured(updater(prev), configuredModelIds));
  };

  const loadLabGroups = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLabGroupsLoading(true);
    try {
      const res = await listModelLabGroups({ search: labGroupSearch.trim() || undefined, limit: 200 });
      if (res.success) setLabGroups(res.data.items ?? []);
    } finally {
      if (!opts?.silent) setLabGroupsLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // 打开弹窗时预热分组列表（避免切 tab 再等）
    loadLabGroups({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (tab !== 'byLabGroup') return;
    loadLabGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    const g = labGroups.find((x) => x.id === activeGroupId) ?? null;
    if (!g) return;
    setGroupDraftName(g.name || '');
    setGroupDraftModelsRaw(dedupePreferConfigured(g.models ?? [], configuredModelIds));
  }, [activeGroupId, configuredModelIds, labGroups]);

  const platformList = useMemo(() => {
    const list = [...(platforms ?? [])];
    // 启用平台优先
    list.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return list;
  }, [platforms]);

  const groupAddPlatform = useMemo(() => {
    const id = groupAddPlatformId || '';
    return platforms.find((p) => p.id === id) ?? null;
  }, [groupAddPlatformId, platforms]);

  const middleByPlatform = (
    <div className="flex-1 min-h-0 overflow-auto">
      {platformList.length === 0 ? (
        <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          暂无平台，请先在“模型管理”中添加平台
        </div>
      ) : (
        <div className="space-y-2">
          {platformList.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-[14px] px-3 py-2"
              style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {p.name}
                  {!p.enabled ? (
                    <span className="ml-2 text-xs font-normal" style={{ color: 'rgba(239,68,68,0.95)' }}>
                      未启用
                    </span>
                  ) : null}
                </div>
                <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                  {p.platformType} · {p.id}
                </div>
              </div>
              <Button
                size="xs"
                variant="secondary"
                className="shrink-0"
                onClick={() => {
                  setAvailableTarget('pool');
                  setAvailablePlatform(p);
                  setAvailableOpen(true);
                }}
                disabled={!p.enabled}
                title="打开该平台可用模型列表"
              >
                批量添加
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const middleByLabGroup = (
    <div className="h-full min-h-0 grid gap-3" style={{ gridTemplateColumns: '340px 1fr' }}>
      {/* 左：分组列表 */}
      <div className="min-h-0 flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            实验室分组
          </div>
          <Button size="xs" variant="secondary" className="shrink-0" onClick={() => loadLabGroups()} disabled={labGroupsLoading}>
            刷新
          </Button>
        </div>

        <div className="mt-2 flex gap-2">
          <input
            value={labGroupSearch}
            onChange={(e) => setLabGroupSearch(e.target.value)}
            className="h-9 flex-1 rounded-[12px] px-3 text-sm outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            placeholder="搜索分组..."
          />
          <Button
            size="xs"
            variant="secondary"
            className="shrink-0"
            onClick={() => loadLabGroups()}
            disabled={labGroupsLoading}
          >
            搜索
          </Button>
        </div>

        <div className="mt-2 flex gap-2">
          <input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            className="h-9 flex-1 rounded-[12px] px-3 text-sm outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            placeholder="新建分组名称"
          />
          <Button
            size="xs"
            variant="primary"
            className="shrink-0"
            onClick={async () => {
              const name = newGroupName.trim();
              if (!name) return alert('请输入分组名称');
              const created = await upsertModelLabGroup({ name, models: [] });
              if (!created.success) return alert(created.error?.message || '创建失败');
              setNewGroupName('');
              await loadLabGroups({ silent: true });
              setActiveGroupId(created.data.id);
            }}
          >
            新建
          </Button>
        </div>

        <div className="mt-3 flex-1 min-h-0 overflow-auto pr-1">
          {labGroups.length === 0 ? (
            <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              暂无分组
            </div>
          ) : (
            <div className="space-y-2">
              {labGroups.map((g) => {
                const isActive = g.id === activeGroupId;
                const count = g.models?.length ?? 0;
                return (
                  <div
                    key={g.id}
                    className="rounded-[14px] p-2"
                    style={{
                      border: isActive ? '1px solid var(--border-default)' : '1px solid var(--border-subtle)',
                      background: isActive ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => setActiveGroupId(g.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                            {g.name}
                          </div>
                          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                            {count} 个
                          </div>
                        </div>
                      </div>
                    </button>

                    <div className="mt-2 flex gap-2">
                      <Button
                        size="xs"
                        variant="secondary"
                        className="shrink-0"
                        disabled={count === 0}
                        onClick={() => {
                          setPool((prev) => dedupePreferConfigured([...prev, ...(g.models ?? [])], configuredModelIds));
                        }}
                        title="将该分组模型追加到下方选择池"
                      >
                        追加到下栏
                      </Button>
                      <Button
                        size="xs"
                        variant="danger"
                        className="shrink-0"
                        onClick={async () => {
                          const ok = window.confirm(`确认删除分组“${g.name}”？`);
                          if (!ok) return;
                          const res = await deleteModelLabGroup(g.id);
                          if (!res.success) return alert(res.error?.message || '删除失败');
                          if (activeGroupId === g.id) setActiveGroupId('');
                          await loadLabGroups({ silent: true });
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 右：分组详情/维护 */}
      <div className="min-h-0 flex flex-col">
        {!activeGroupId ? (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            请选择左侧一个分组进行维护
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                分组详情
              </div>
              <Button
                size="xs"
                variant="primary"
                className="shrink-0"
                onClick={async () => {
                  const name = groupDraftName.trim();
                  if (!name) return alert('请输入分组名称');
                  const saved = await upsertModelLabGroup({ id: activeGroupId, name, models: groupDraftModels });
                  if (!saved.success) return alert(saved.error?.message || '保存失败');
                  await loadLabGroups({ silent: true });
                }}
              >
                保存
              </Button>
            </div>

            <div className="mt-2">
              <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                分组名称
              </div>
              <input
                value={groupDraftName}
                onChange={(e) => setGroupDraftName(e.target.value)}
                className="h-10 w-full rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="分组名称"
              />
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                分组模型 {groupDraftModels.length} 个
              </div>
              <div className="flex gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => setGroupDraftModels((prev) => dedupePreferConfigured([...prev, ...pool], configuredModelIds))}
                  disabled={pool.length === 0}
                  title="将下方选择池中的模型追加到该分组"
                >
                  从下栏追加
                </Button>
                <select
                  value={groupAddPlatformId}
                  onChange={(e) => setGroupAddPlatformId(e.target.value)}
                  className="h-[30px] rounded-[10px] px-2 text-[12px]"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  title="选择平台"
                >
                  <option value="">选择平台</option>
                  {platformList.filter((p) => p.enabled).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="xs"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => {
                    if (!groupAddPlatform) return alert('请先选择平台');
                    setAvailableTarget('group');
                    setAvailablePlatform(groupAddPlatform);
                    setAvailableOpen(true);
                  }}
                  disabled={!groupAddPlatform}
                >
                  从平台添加
                </Button>
              </div>
            </div>

            <div className="mt-2 flex-1 min-h-0 overflow-auto pr-1">
              {groupDraftModels.length === 0 ? (
                <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  该分组暂无模型
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {groupDraftModels.map((m) => (
                    <button
                      key={keyOf(m)}
                      type="button"
                      className="px-3 py-1 rounded-[999px] text-xs"
                      style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' }}
                      onClick={() => {
                        const k = keyOf(m);
                        setGroupDraftModels((prev) => prev.filter((x) => keyOf(x) !== k));
                      }}
                      title="点击移除"
                    >
                      {m.name || m.modelName}
                      <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                        ×
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const bottomPool = (
    <div className="rounded-[16px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          已选择 {pool.length} 个
        </div>
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="secondary"
            className="shrink-0"
            onClick={() => setPool(() => [])}
            disabled={pool.length === 0}
          >
            清空
          </Button>
          <Button
            size="xs"
            variant="primary"
            className="shrink-0"
            onClick={() => {
              onConfirm(pool);
              onOpenChange(false);
            }}
            disabled={pool.length === 0}
          >
            加入到本次实验
          </Button>
        </div>
      </div>

      {pool.length === 0 ? (
        <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          还没有选择模型。请在上方通过“按平台添加”或“按实验室分组添加”把模型加入到这里。
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {pool.map((m) => (
            <button
              key={keyOf(m)}
              type="button"
              className="px-3 py-1 rounded-[999px] text-xs"
              style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)' }}
              onClick={() => {
                const k = keyOf(m);
                setPool((prev) => prev.filter((x) => keyOf(x) !== k));
              }}
              title="点击移除"
            >
              {m.name || m.modelName}
              <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                ×
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const content = (
    <div className="h-full min-h-0 flex flex-col">
      {/* 上栏：tab 切换 */}
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant={tab === 'byPlatform' ? 'primary' : 'secondary'}
          onClick={() => setTab('byPlatform')}
        >
          按平台添加
        </Button>
        <Button
          size="xs"
          variant={tab === 'byLabGroup' ? 'primary' : 'secondary'}
          onClick={() => setTab('byLabGroup')}
        >
          按现有分组添加
        </Button>
      </div>

      {/* 中栏 */}
      <div className="mt-4 flex-1 min-h-0 rounded-[16px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.01)' }}>
        {tab === 'byPlatform' ? middleByPlatform : middleByLabGroup}
      </div>

      {/* 下栏：共享池 */}
      <div className="mt-4">{bottomPool}</div>

      <PlatformAvailableDialog
        open={availableOpen}
        onOpenChange={(o) => setAvailableOpen(o)}
        platform={availablePlatform}
        allModels={allModels}
        selected={availableTarget === 'pool' ? pool : groupDraftModels}
        setSelected={availableTarget === 'pool' ? setPool : setGroupDraftModels}
      />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加模型"
      description="通过平台或实验室分组把模型加入下方选择池，确认后一次性加入到本次实验"
      maxWidth={960}
      content={content}
    />
  );
}


