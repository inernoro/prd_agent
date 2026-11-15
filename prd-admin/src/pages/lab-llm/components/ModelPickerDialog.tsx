import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { LogicalModelPickerDialog } from '@/components/model/LogicalModelPickerDialog';
import { ModelReferenceStatus } from '@/components/model/ModelReferenceStatus';
import type { LogicalModelOption, ModelLabPurpose } from '@/services/contracts/modelReferences';
import type { ModelLabSelectedModel } from '@/services/contracts/modelLab';
// lucide icons are used inside shared dialog component
import { deleteModelLabGroup, listModelLabGroups, upsertModelLabGroup, getModelLabModelOptions } from '@/services';
import type { ModelLabGroup } from '@/services/contracts/modelLabGroups';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';

type TabKey = 'byPlatform' | 'byLabGroup';

function keyOf(m: Pick<ModelLabSelectedModel, 'platformId' | 'modelId' | 'logicalModelId'>) {
  if (m.logicalModelId) return `logical:${m.logicalModelId}`;
  return `${m.platformId}:${m.modelId}`.toLowerCase();
}

function dedupeByPlatformAndModelId(list: ModelLabSelectedModel[]): ModelLabSelectedModel[] {
  const map = new Map<string, ModelLabSelectedModel>();
  for (const item of list) {
    const pid = String(item.platformId ?? '').trim();
    const mid = String(item.modelId ?? '').trim();
    if (!pid || !mid) continue;
    const k = keyOf(item);
    if (!map.has(k)) map.set(k, item);
  }
  return Array.from(map.values());
}

function fromLogicalOption(option: LogicalModelOption): ModelLabSelectedModel {
  return { logicalModelId: option.logicalModelId, platformId: 'logical-model', modelId: option.publicId, modelName: option.publicId, name: option.name, modelReferenceStatus: 'available', modelReferenceReason: null };
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  selectedModels,
  onConfirm,
  purpose = 'chat',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedModels: ModelLabSelectedModel[];
  purpose?: ModelLabPurpose;
  onConfirm: (models: ModelLabSelectedModel[]) => void;
}) {
  const [catalog, setCatalog] = useState<LogicalModelOption[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const loadOptions = useCallback(() => getModelLabModelOptions(purpose), [purpose]);
  useEffect(() => {
    if (!open) return;
    let active = true; setCatalog(null); setCatalogError(null);
    void loadOptions().then(result => {
      if (!active) return;
      if (result.success) setCatalog(result.data.items);
      else setCatalogError('当前用途的模型目录暂未读取成功，请重新打开重试。选择已保留。');
    }).catch(() => { if (active) setCatalogError('当前用途的模型目录暂未读取成功，请重新打开重试。选择已保留。'); });
    return () => { active = false; };
  }, [open, loadOptions]);
  const referenceState = (model: ModelLabSelectedModel): ModelLabSelectedModel => {
    if (!model.logicalModelId) return { ...model, modelReferenceStatus: 'legacy' };
    if (!catalog) return { ...model, modelReferenceStatus: 'unknown' };
    const option = catalog.find(item => item.logicalModelId === model.logicalModelId);
    return { ...model, modelReferenceStatus: option?.available ? 'available' : 'unavailable', modelReferenceReason: option?.reason || '当前用途没有可用的授权模型线路。' };
  };
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
  const [repairingModel, setRepairingModel] = useState<ModelLabSelectedModel | null>(null);
  const [availableTarget, setAvailableTarget] = useState<'pool' | 'group'>('pool');

  // 实验室分组
  const [labGroups, setLabGroups] = useState<ModelLabGroup[]>([]);
  const [labGroupsLoading, setLabGroupsLoading] = useState(false);
  const [labGroupSearch, setLabGroupSearch] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  const [groupDraftName, setGroupDraftName] = useState('');
  const [groupDraftModels, setGroupDraftModelsRaw] = useState<ModelLabSelectedModel[]>([]);

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

  const selectionIds = useMemo(() => repairingModel?.logicalModelId ? [repairingModel.logicalModelId] : [], [repairingModel?.logicalModelId]);
  const middleByPlatform = <div className="flex items-center justify-between gap-3 text-sm">
    <span style={{ color: 'var(--text-secondary)' }}>从本应用已授权的逻辑模型中选择。旧引用会保留，需明确修复后才能运行。</span>
    <Button size="sm" variant="primary" onClick={() => { setAvailableTarget('pool'); setRepairingModel(null); setAvailableOpen(true); }}>选择授权模型</Button>
  </div>;

  function repair(model: ModelLabSelectedModel, target: 'pool' | 'group') {
    setAvailableTarget(target); setRepairingModel(model); setAvailableOpen(true);
  }
  function applySelection(options: LogicalModelOption[]) {
    const setTarget = availableTarget === 'pool' ? setPool : setGroupDraftModels;
    const models = options.map(fromLogicalOption);
    setTarget(previous => repairingModel ? previous.map(model => keyOf(model) === keyOf(repairingModel) ? models[0] : model) : [...previous, ...models]);
  }

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
            className="h-9 flex-1 rounded-[12px] px-3 text-sm outline-none bg-token-nested border border-token-subtle"
            style={{ color: 'var(--text-primary)' }}
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
            className="h-9 flex-1 rounded-[12px] px-3 text-sm outline-none bg-token-nested border border-token-subtle"
            style={{ color: 'var(--text-primary)' }}
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
                      background: isActive ? 'var(--nested-block-bg)' : 'var(--nested-block-bg)',
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
                className="h-10 w-full rounded-[14px] px-3 text-sm outline-none bg-token-nested border border-token-subtle"
                style={{ color: 'var(--text-primary)' }}
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
                <Button size="xs" variant="secondary" onClick={() => { setAvailableTarget('group'); setRepairingModel(null); setAvailableOpen(true); }}>选择授权模型</Button>
              </div>
            </div>

            <div className="mt-2 flex-1 min-h-0 overflow-auto pr-1">
              {groupDraftModels.length === 0 ? (
                <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  该分组暂无模型
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {groupDraftModels.map(model => <div key={keyOf(model)} className="rounded-md p-2 bg-token-nested text-xs">
                    <span>{model.name || model.modelName}</span><span className="block font-mono" style={{ color: 'var(--text-secondary)' }}>{model.modelName || model.modelId}</span><ModelReferenceStatus reference={referenceState(model)} />
                    {referenceState(model).modelReferenceStatus !== 'available' ? <Button size="xs" variant="ghost" onClick={() => repair(model, 'group')}>修复引用</Button> : null}
                    <Button size="xs" variant="ghost" onClick={() => setGroupDraftModels(previous => previous.filter(item => keyOf(item) !== keyOf(model)))}>移除</Button>
                  </div>)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const bottomPool = (
    <div className="rounded-[16px] p-3 bg-token-nested" style={{ border: '1px solid var(--border-subtle)' }}>
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
              onConfirm(pool.map(referenceState));
              onOpenChange(false);
            }}
            disabled={pool.length === 0 || pool.some(model => referenceState(model).modelReferenceStatus !== 'available')}
          >
            加入到本次实验
          </Button>
        </div>
      </div>

      {pool.length === 0 ? (
        <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          还没有选择模型。请在上方通过“按授权模型添加”或“按实验室分组添加”把模型加入到这里。
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {pool.map(model => <div key={keyOf(model)} className="rounded-md p-2 bg-token-nested text-xs">
            <span>{model.name || model.modelName}</span><span className="block font-mono" style={{ color: 'var(--text-secondary)' }}>{model.modelName || model.modelId}</span><ModelReferenceStatus reference={referenceState(model)} />
            {referenceState(model).modelReferenceStatus !== 'available' ? <Button size="xs" variant="ghost" onClick={() => repair(model, 'pool')}>修复引用</Button> : null}
            <Button size="xs" variant="ghost" onClick={() => setPool(previous => previous.filter(item => keyOf(item) !== keyOf(model)))}>移除</Button>
          </div>)}
        </div>
      )}
    </div>
  );

  const content = (
    <div className="h-full min-h-0 flex flex-col">
      {catalogError ? <div role="alert" className="text-sm" style={{ color: 'var(--semantic-danger-text)' }}>{catalogError}</div> : null}
      {/* 上栏：tab 切换 */}
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant={tab === 'byPlatform' ? 'primary' : 'secondary'}
          onClick={() => setTab('byPlatform')}
        >
          按授权模型添加
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
      <div className="mt-4 flex-1 min-h-0 rounded-[16px] p-3 bg-token-nested" style={{ border: '1px solid var(--border-subtle)' }}>
        {tab === 'byPlatform' ? middleByPlatform : middleByLabGroup}
      </div>

      {/* 下栏：共享池 */}
      <div className="mt-4">{bottomPool}</div>

      <LogicalModelPickerDialog open={availableOpen} onOpenChange={setAvailableOpen} zIndex={200} loadOptions={loadOptions}
        selectedModelIds={selectionIds} single={!!repairingModel} onConfirm={applySelection}
        title={repairingModel ? '修复模型引用' : '选择授权模型'} />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加模型"
      description="通过授权模型或实验室分组把模型加入下方选择池，确认后一次性加入到本次实验"
      maxWidth={960}
      content={content}
    />
  );
}


