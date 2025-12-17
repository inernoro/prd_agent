import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import type { Model } from '@/types/admin';
import type { ModelLabSelectedModel } from '@/services/contracts/modelLab';

type AvailableGroup = { key: string; models: Model[] };

function groupKeyOfModel(m: Model) {
  const raw = (m.group || '').trim();
  if (raw) return raw.toLowerCase();
  const s = (m.modelName || '').trim().toLowerCase().replace(/\//g, '-');
  const parts = s.split('-').filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  if (parts.length >= 1) return parts[0];
  return 'other';
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  allModels,
  selectedModels,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allModels: Model[];
  selectedModels: ModelLabSelectedModel[];
  onAdd: (models: ModelLabSelectedModel[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const selectedIds = useMemo(() => new Set(selectedModels.map((x) => x.modelId)), [selectedModels]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = allModels.filter((m) => m.enabled);
    if (!s) return list;
    return list.filter((m) => (m.name || '').toLowerCase().includes(s) || (m.modelName || '').toLowerCase().includes(s));
  }, [allModels, search]);

  const grouped = useMemo(() => {
    const buckets: Record<string, Model[]> = {};
    for (const m of filtered) {
      const k = groupKeyOfModel(m);
      (buckets[k] ||= []).push(m);
    }
    for (const ms of Object.values(buckets)) {
      ms.sort((a, b) => ((a.name || a.modelName) || '').localeCompare((b.name || b.modelName) || '', undefined, { numeric: true, sensitivity: 'base' }));
    }
    return Object.entries(buckets)
      .map(([key, models]) => ({ key, models }))
      .sort((a, b) => {
        const ao = a.key === 'other';
        const bo = b.key === 'other';
        if (ao !== bo) return ao ? 1 : -1;
        return b.models.length - a.models.length;
      }) satisfies AvailableGroup[];
  }, [filtered]);

  const content = (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 flex-1 rounded-[14px] px-3 text-sm outline-none"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
          placeholder="搜索已配置模型（名称/ID）"
        />
        <Button
          variant="ghost"
          onClick={() => setSearch('')}
        >
          清空
        </Button>
      </div>

      <div className="mt-4 flex-1 min-h-0 overflow-auto pr-1">
        {grouped.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            暂无可用模型（请先在模型管理中添加并启用）
          </div>
        ) : (
          <div className="space-y-3">
            {grouped.map((g) => {
              const isOpen = openGroups[g.key] ?? (g.key !== 'other');
              const groupAll = g.models.map((m) => ({
                modelId: m.id,
                platformId: m.platformId || '',
                name: m.name || m.modelName,
                modelName: m.modelName,
                group: m.group ?? null,
              })) satisfies ModelLabSelectedModel[];

              const notYet = groupAll.filter((x) => !selectedIds.has(x.modelId));
              return (
                <div key={g.key} className="rounded-[16px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <button
                      className="text-left min-w-0"
                      onClick={() => setOpenGroups((p) => ({ ...p, [g.key]: !isOpen }))}
                      type="button"
                    >
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {g.key}
                        <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                          {g.models.length} 个
                        </span>
                      </div>
                    </button>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" disabled={notYet.length === 0} onClick={() => onAdd(notYet)}>
                        一键加入本组
                      </Button>
                    </div>
                  </div>

                  {isOpen ? (
                    <div className="mt-3 space-y-2">
                      {g.models.map((m) => {
                        const picked = selectedIds.has(m.id);
                        return (
                          <div
                            key={m.id}
                            className="flex items-center justify-between rounded-[14px] px-3 py-2"
                            style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                {m.name || m.modelName}
                              </div>
                              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                                {m.modelName} · {m.id}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant={picked ? 'secondary' : 'primary'}
                              onClick={() =>
                                onAdd([
                                  {
                                    modelId: m.id,
                                    platformId: m.platformId || '',
                                    name: m.name || m.modelName,
                                    modelName: m.modelName,
                                    group: m.group ?? null,
                                  },
                                ])
                              }
                              disabled={picked}
                            >
                              {picked ? '已加入' : '加入'}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="选择模型"
      description="从已配置且启用的模型中加入本次实验，也支持按组一键加入"
      maxWidth={960}
      content={content}
    />
  );
}


