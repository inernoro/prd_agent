/**
 * 通用模型选择器弹窗
 *
 * 功能：
 * - 按平台批量添加模型到选择池
 * - 底部展示已选择的模型列表
 * - 确认后一次性返回选择结果
 *
 * 使用场景：
 * - 模型池管理：添加模型到模型池
 * - 实验室：添加模型到实验
 * - 其他需要批量选择模型的场景
 */

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { PlatformLabel } from '@/components/design/PlatformLabel';
import type { Platform } from '@/types/admin';
import { PlatformAvailableModelsDialog, type AvailableModel } from '@/components/model/PlatformAvailableModelsDialog';

/** 选中的模型项 */
export interface SelectedModelItem {
  platformId: string;
  modelId: string;
  modelName?: string;
  name?: string;
  group?: string | null;
}

function keyOf(m: Pick<SelectedModelItem, 'platformId' | 'modelId'>) {
  return `${m.platformId}:${m.modelId}`.toLowerCase();
}

function dedupeByPlatformAndModelId<T extends SelectedModelItem>(list: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of list) {
    const pid = String(item.platformId ?? '').trim();
    const mid = String(item.modelId ?? '').trim();
    if (!pid || !mid) continue;
    const k = `${pid}:${mid}`.toLowerCase();
    if (!map.has(k)) map.set(k, item);
  }
  return Array.from(map.values());
}

function toSelectedModel(args: {
  platformId: string;
  modelName: string;
  displayName?: string;
  group?: string;
}): SelectedModelItem {
  return {
    modelId: args.modelName,
    platformId: args.platformId,
    name: args.displayName || args.modelName,
    modelName: args.modelName,
    group: args.group ?? null,
  };
}

export interface ModelPoolPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前已选择的模型列表（用于初始化） */
  selectedModels: SelectedModelItem[];
  /** 可用平台列表 */
  platforms: Platform[];
  /** 确认选择回调 */
  onConfirm: (models: SelectedModelItem[]) => void;
  /** 确认按钮文案，默认"确认添加" */
  confirmText?: string;
  /** 弹窗标题，默认"添加模型" */
  title?: string;
  /** 弹窗描述 */
  description?: string;
}

export function ModelPoolPickerDialog({
  open,
  onOpenChange,
  selectedModels,
  platforms,
  onConfirm,
  confirmText = '确认添加',
  title = '添加模型',
  description = '通过平台把模型加入下方选择池，确认后一次性添加',
}: ModelPoolPickerDialogProps) {
  // 下栏共享池：作为"最终会添加"的模型集合
  const [pool, setPoolRaw] = useState<SelectedModelItem[]>([]);

  const setPool = (updater: (prev: SelectedModelItem[]) => SelectedModelItem[]) => {
    setPoolRaw((prev) => dedupeByPlatformAndModelId(updater(prev)));
  };

  useEffect(() => {
    if (!open) return;
    // 每次打开都从外部当前选择初始化
    setPoolRaw(dedupeByPlatformAndModelId(selectedModels ?? []));
  }, [open, selectedModels]);

  const [availableOpen, setAvailableOpen] = useState(false);
  const [availablePlatform, setAvailablePlatform] = useState<Platform | null>(null);

  const platformList = useMemo(() => {
    const list = [...(platforms ?? [])];
    // 启用平台优先
    list.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return list;
  }, [platforms]);

  const platformNameById = useMemo(() => {
    const map = new Map<string, string>();
    (platforms ?? []).forEach((p) => {
      if (p?.id) map.set(p.id, p.name || p.id);
    });
    return map;
  }, [platforms]);

  const bulkAddGroup = (ms: AvailableModel[]) => {
    if (!availablePlatform?.id) return;
    const adds = ms.map((m) =>
      toSelectedModel({
        platformId: availablePlatform.id,
        modelName: m.modelName,
        displayName: m.displayName || m.modelName,
        group: m.group,
      })
    );
    setPool((prev) => dedupeByPlatformAndModelId([...prev, ...adds]));
  };

  const togglePoolModel = (m: AvailableModel) => {
    if (!availablePlatform?.id) return;
    const k = keyOf({ platformId: availablePlatform.id, modelId: m.modelName });
    const exists = pool.some((x) => keyOf(x) === k);
    if (exists) {
      setPool((prev) => prev.filter((x) => keyOf(x) !== k));
      return;
    }

    const selectedItem = toSelectedModel({
      platformId: availablePlatform.id,
      modelName: m.modelName,
      displayName: m.displayName || m.modelName,
      group: m.group,
    });
    setPool((prev) => dedupeByPlatformAndModelId([...prev, selectedItem]));
  };

  const selectedCount = availablePlatform
    ? pool.filter((x) => x.platformId === availablePlatform.id).length
    : 0;

  // 按平台添加区域
  const middleByPlatform = (
    <div className="flex-1 min-h-0 overflow-auto">
      {platformList.length === 0 ? (
        <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          暂无平台，请先在"模型管理"中添加平台
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

  // 底部选择池
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
            {confirmText}
          </Button>
        </div>
      </div>

      {pool.length === 0 ? (
        <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          还没有选择模型。请在上方点击"批量添加"从平台中选择模型。
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
              <span className="inline-flex items-center gap-2">
                <PlatformLabel
                  name={platformNameById.get(m.platformId) ?? m.platformId}
                  size="sm"
                  className="shrink-0"
                />
                <span className="truncate">{m.name || m.modelName || m.modelId}</span>
              </span>
              <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                x
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const content = (
    <div className="h-full min-h-0 flex flex-col">
      {/* 中栏：按平台添加 */}
      <div className="flex-1 min-h-0 rounded-[16px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.01)' }}>
        {middleByPlatform}
      </div>

      {/* 下栏：共享池 */}
      <div className="mt-4">{bottomPool}</div>

      <PlatformAvailableModelsDialog
        open={availableOpen}
        onOpenChange={setAvailableOpen}
        platform={availablePlatform}
        description="从平台可用模型列表中一键添加/移除"
        selectedCount={selectedCount}
        selectedCountLabel="已加入"
        selectedBadgeText="已加入"
        isSelected={(m) => {
          if (!availablePlatform?.id) return false;
          const k = keyOf({ platformId: availablePlatform.id, modelId: m.modelName });
          return pool.some((x) => keyOf(x) === k);
        }}
        onToggle={togglePoolModel}
        onBulkAddGroup={(_, ms) => bulkAddGroup(ms)}
      />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      maxWidth={720}
      content={content}
    />
  );
}
