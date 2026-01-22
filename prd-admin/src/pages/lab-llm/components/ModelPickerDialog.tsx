import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import type { Platform } from '@/types/admin';
import type { ModelLabSelectedModel } from '@/services/contracts/modelLab';
// lucide icons are used inside shared dialog component
import { deleteModelLabGroup, listModelLabGroups, upsertModelLabGroup } from '@/services';
import type { ModelLabGroup } from '@/services/contracts/modelLabGroups';
import { PlatformAvailableModelsDialog, type AvailableModel } from '@/components/model/PlatformAvailableModelsDialog';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';

type TabKey = 'byPlatform' | 'byLabGroup';

function keyOf(m: Pick<ModelLabSelectedModel, 'platformId' | 'modelId'>) {
  return `${m.platformId}:${m.modelId}`.toLowerCase();
}

function dedupeByPlatformAndModelId(list: ModelLabSelectedModel[]): ModelLabSelectedModel[] {
  const map = new Map<string, ModelLabSelectedModel>();
  for (const item of list) {
    const pid = String(item.platformId ?? '').trim();
    const mid = String(item.modelId ?? '').trim();
    if (!pid || !mid) continue;
    const k = `${pid}:${mid}`.toLowerCase();
    if (!map.has(k)) map.set(k, item);
  }
  return Array.from(map.values());
}

function toSelectedModelFromAvailable(args: {
  platformId: string;
  modelName: string;
  displayName: string;
  group?: string;
}): ModelLabSelectedModel {
  // 统一业务语义：modelId == 平台侧模型 ID（等价于 modelName）。
  // 唯一性由 platformId + modelId 保证。
  return {
    modelId: args.modelName,
    platformId: args.platformId,
    name: args.modelName,
    modelName: args.modelName,
    group: args.group ?? null,
  };
}

function PlatformAvailableDialog({
  open,
  onOpenChange,
  platform,
  selected,
  setSelected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Platform | null;
  selected: ModelLabSelectedModel[];
  setSelected: (updater: (prev: ModelLabSelectedModel[]) => ModelLabSelectedModel[]) => void;
}) {
  useEffect(() => {
    if (!open) return;
    // no-op: state handled in shared dialog
  }, [open]);

  const bulkAddGroup = (ms: AvailableModel[]) => {
    if (!platform?.id) return;
    const adds = ms.map((m) =>
      toSelectedModelFromAvailable({
        platformId: platform.id,
        modelName: m.modelName,
        displayName: m.displayName || m.modelName,
        group: m.group,
      })
    );
    setSelected((prev) => dedupeByPlatformAndModelId([...prev, ...adds]));
  };

  const togglePoolModel = (m: AvailableModel) => {
    if (!platform?.id) return;
    const k = keyOf({ platformId: platform.id, modelId: m.modelName });
    const exists = selected.some((x) => keyOf(x) === k);
    if (exists) {
      setSelected((prev) => prev.filter((x) => keyOf(x) !== k));
      return;
    }

    const selectedItem = toSelectedModelFromAvailable({
      platformId: platform.id,
      modelName: m.modelName,
      displayName: m.displayName || m.modelName,
      group: m.group,
    });
    setSelected((prev) => dedupeByPlatformAndModelId([...prev, selectedItem]));
  };

  const selectedCount = (selected ?? []).filter((x) => x.platformId === platform?.id).length;

  return (
    <PlatformAvailableModelsDialog
      open={open}
      onOpenChange={onOpenChange}
      platform={platform}
      description="从平台可用模型列表中一键添加/移除（仅加入到本次实验的选择池）"
      selectedCount={selectedCount}
      selectedCountLabel="已加入"
      selectedBadgeText="已加入"
      isSelected={(m) => {
        if (!platform?.id) return false;
        const k = keyOf({ platformId: platform.id, modelId: m.modelName });
        return selected.some((x) => keyOf(x) === k);
      }}
      onToggle={(m) => togglePoolModel(m)}
      onBulkAddGroup={(_, ms) => bulkAddGroup(ms)}
    />
  );
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  selectedModels,
  platforms,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedModels: ModelLabSelectedModel[];
  platforms: Platform[];
  onConfirm: (models: ModelLabSelectedModel[]) => void;
}) {
  const [tab, setTab] = useState<TabKey>('byPlatform');

  // 下栏共享池：作为“最终会加入到实验”的模型集合（初始化为当前 selectedModels）
  const [pool, setPoolRaw] = useState<ModelLabSelectedModel[]>([]);

  const setPool = (updater: (prev: ModelLabSelectedModel[]) => ModelLabSelectedModel[]) => {
    setPoolRaw((prev) => dedupeByPlatformAndModelId(updater(prev)));
  };

  useEffect(() => {
    if (!open) return;
    // 每次打开都从外部当前选择初始化，避免上次未确认的临时选择污染
    setTab('byPlatform');
    setPoolRaw(dedupeByPlatformAndModelId(selectedModels ?? []));
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
    setGroupDraftModelsRaw((prev) => dedupeByPlatformAndModelId(updater(prev)));
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
    setGroupDraftModelsRaw(dedupeByPlatformAndModelId(g.models ?? []));
  }, [activeGroupId, labGroups]);

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
              if (!name) {
                toast.warning('请输入分组名称');
                return;
              }
              const created = await upsertModelLabGroup({ name, models: [] });
              if (!created.success) {
                toast.error(created.error?.message || '创建失败');
                return;
              }
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
                          setPool((prev) => dedupeByPlatformAndModelId([...prev, ...(g.models ?? [])]));
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
                          const ok = await systemDialog.confirm({
                            title: '确认删除',
                            message: `确认删除分组“${g.name}”？`,
                            tone: 'danger',
                            confirmText: '删除',
                            cancelText: '取消',
                          });
                          if (!ok) return;
                          const res = await deleteModelLabGroup(g.id);
                          if (!res.success) {
                            toast.error(res.error?.message || '删除失败');
                            return;
                          }
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
                  if (!name) {
                    toast.warning('请输入分组名称');
                    return;
                  }
                  const saved = await upsertModelLabGroup({ id: activeGroupId, name, models: groupDraftModels });
                  if (!saved.success) {
                    toast.error(saved.error?.message || '保存失败');
                    return;
                  }
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
                  onClick={() => setGroupDraftModels((prev) => dedupeByPlatformAndModelId([...prev, ...pool]))}
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
                    if (!groupAddPlatform) return void toast.warning('请先选择平台');
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


