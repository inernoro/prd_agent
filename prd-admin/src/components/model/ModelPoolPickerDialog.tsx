/**
 * 通用模型选择器弹窗
 *
 * 功能：
 * - 双视角切换：[平台] 按平台分组浏览 / [大模型] 跨平台聚合并按标签过滤
 * - 底部展示已选择的模型列表
 * - 确认后一次性返回选择结果
 *
 * 标签来源（启发式，零持久化）：
 * - 后端 AvailableModel.tags 优先
 * - 否则走 `lib/modelPresetTags.ts` 的 `inferPresetTagKeys`（基于 modelName/providerId regex）
 */

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { PlatformLabel } from '@/components/design/PlatformLabel';
import type { Platform } from '@/types/admin';
import { PlatformAvailableModelsDialog, type AvailableModel } from '@/components/model/PlatformAvailableModelsDialog';
import { apiRequest } from '@/services/real/apiClient';
import { inferPresetTagKeys, type PresetTagKey } from '@/lib/modelPresetTags';
import type { LucideIcon } from 'lucide-react';
import {
  Zap,
  ScanEye,
  Link2,
  Sparkles,
  DatabaseZap,
  ArrowDown,
  ImagePlus,
  Film,
  Star,
  Box,
  RefreshCw,
  Search,
} from 'lucide-react';

/** 标签元信息（与 PlatformAvailableModelsDialog.presetTagMeta 同源） */
const TAG_META: Record<PresetTagKey, { title: string; icon: LucideIcon; tone: string; bg: string }> = {
  reasoning: { title: '推理', icon: Zap, tone: 'rgba(251,146,60,0.95)', bg: 'rgba(251,146,60,0.16)' },
  vision: { title: '视觉', icon: ScanEye, tone: 'rgba(96,165,250,0.95)', bg: 'rgba(96,165,250,0.16)' },
  websearch: { title: '联网', icon: Link2, tone: 'rgba(34,197,94,0.95)', bg: 'rgba(34,197,94,0.16)' },
  function_calling: { title: '工具', icon: Sparkles, tone: 'rgba(167,139,250,0.95)', bg: 'rgba(167,139,250,0.16)' },
  embedding: { title: '嵌入', icon: DatabaseZap, tone: 'rgba(34,211,238,0.95)', bg: 'rgba(34,211,238,0.16)' },
  rerank: { title: '重排', icon: ArrowDown, tone: 'rgba(245,158,11,0.95)', bg: 'rgba(245,158,11,0.16)' },
  image_generation: { title: '生图', icon: ImagePlus, tone: 'rgba(236,72,153,0.95)', bg: 'rgba(236,72,153,0.16)' },
  video_generation: { title: '视频', icon: Film, tone: 'rgba(168,85,247,0.95)', bg: 'rgba(168,85,247,0.16)' },
  free: { title: '免费', icon: Star, tone: 'rgba(34,197,94,0.95)', bg: 'rgba(34,197,94,0.16)' },
};

const ALL_TAG_KEYS: PresetTagKey[] = [
  'reasoning', 'vision', 'image_generation', 'video_generation',
  'function_calling', 'websearch', 'embedding', 'rerank', 'free',
];

/** 把后端原始 tag 字符串归一到 PresetTagKey */
function normalizeBackendTags(raw?: string[]): PresetTagKey[] {
  if (!raw || raw.length === 0) return [];
  const out: PresetTagKey[] = [];
  for (const t of raw) {
    const k = (t || '').trim().toLowerCase();
    if (k === 'web_search' || k === 'websearch') out.push('websearch');
    else if (k === 'function_calling') out.push('function_calling');
    else if (k === 'embedding') out.push('embedding');
    else if (k === 'vision') out.push('vision');
    else if (k === 'rerank') out.push('rerank');
    else if (k === 'reasoning') out.push('reasoning');
    else if (k === 'free') out.push('free');
    else if (k === 'video_generation' || k === 'video-gen' || k === 'video') out.push('video_generation');
    else if (k === 'image_generation' || k === 't2i') out.push('image_generation');
  }
  return Array.from(new Set(out));
}

/** 跨平台聚合后的单条模型 */
interface AggregatedModelRow {
  platformId: string;
  platformName: string;
  platformType?: string;
  modelName: string;
  displayName: string;
  group?: string;
  tags: PresetTagKey[];
}

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

  // 视角切换：平台分组 vs 跨平台大模型聚合
  const [viewMode, setViewMode] = useState<'platform' | 'model'>('platform');
  const [aggregatedModels, setAggregatedModels] = useState<AggregatedModelRow[]>([]);
  const [aggregateLoading, setAggregateLoading] = useState(false);
  const [aggregateError, setAggregateError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<PresetTagKey | 'all'>('all');
  const [aggregateSearch, setAggregateSearch] = useState('');

  // 弹窗每次打开重置视角
  useEffect(() => {
    if (!open) return;
    setViewMode('platform');
    setAggregateError(null);
    setTagFilter('all');
    setAggregateSearch('');
  }, [open]);

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

  // 切到大模型 tab 且未加载时拉一次
  const fetchAllModels = async () => {
    setAggregateLoading(true);
    setAggregateError(null);
    try {
      const enabled = platformList.filter((p) => p.enabled);
      const results = await Promise.allSettled(
        enabled.map(async (p) => {
          const res = await apiRequest<AvailableModel[]>(
            `/api/mds/platforms/${p.id}/available-models`,
            { method: 'GET' }
          );
          if (!res.success) throw new Error(res.error?.message || `${p.name} 拉取失败`);
          return { platform: p, models: res.data || [] };
        })
      );
      const rows: AggregatedModelRow[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const { platform: p, models } = r.value;
          for (const m of models) {
            const backendTags = normalizeBackendTags(m.tags);
            const tags = backendTags.length > 0
              ? backendTags
              : inferPresetTagKeys(m.modelName, m.displayName, p.id, p.platformType);
            rows.push({
              platformId: p.id,
              platformName: p.name,
              platformType: p.platformType,
              modelName: m.modelName,
              displayName: m.displayName || m.modelName,
              group: m.group,
              tags,
            });
          }
        } else {
          errors.push(String(r.reason?.message || r.reason || '某平台拉取失败'));
        }
      }
      setAggregatedModels(rows);
      if (errors.length > 0 && rows.length === 0) {
        setAggregateError(errors.join('; '));
      }
    } catch (e) {
      setAggregateError(String((e as Error)?.message || e));
    } finally {
      setAggregateLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (viewMode !== 'model') return;
    if (aggregatedModels.length > 0 || aggregateLoading) return;
    fetchAllModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, open]);

  // 过滤后的聚合列表
  const filteredAggregated = useMemo(() => {
    let result = aggregatedModels;
    if (tagFilter !== 'all') {
      result = result.filter((r) => r.tags.includes(tagFilter));
    }
    const term = aggregateSearch.trim().toLowerCase();
    if (term) {
      result = result.filter(
        (r) =>
          r.modelName.toLowerCase().includes(term) ||
          r.displayName.toLowerCase().includes(term) ||
          r.platformName.toLowerCase().includes(term)
      );
    }
    return result;
  }, [aggregatedModels, tagFilter, aggregateSearch]);

  const toggleAggregatedModel = (row: AggregatedModelRow) => {
    const k = keyOf({ platformId: row.platformId, modelId: row.modelName });
    const exists = pool.some((x) => keyOf(x) === k);
    if (exists) {
      setPool((prev) => prev.filter((x) => keyOf(x) !== k));
      return;
    }
    setPool((prev) =>
      dedupeByPlatformAndModelId([
        ...prev,
        toSelectedModel({
          platformId: row.platformId,
          modelName: row.modelName,
          displayName: row.displayName,
          group: row.group,
        }),
      ])
    );
  };

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

  // 大模型聚合视角
  const middleByModel = (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* 搜索 + 刷新 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="搜索模型名 / 显示名 / 平台..."
            value={aggregateSearch}
            onChange={(e) => setAggregateSearch(e.target.value)}
            className="w-full h-7 pl-7 pr-2 text-xs rounded-[8px] outline-none"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
          />
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={fetchAllModels}
          disabled={aggregateLoading}
          title="重新拉取所有平台模型"
        >
          <RefreshCw size={12} className={aggregateLoading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {/* 标签 chip 过滤 */}
      <div className="flex items-center gap-1 flex-wrap">
        <TagChip
          label="全部"
          active={tagFilter === 'all'}
          onClick={() => setTagFilter('all')}
          count={aggregatedModels.length}
        />
        {ALL_TAG_KEYS.map((k) => {
          const meta = TAG_META[k];
          const Icon = meta.icon;
          const count = aggregatedModels.filter((r) => r.tags.includes(k)).length;
          if (count === 0 && tagFilter !== k) return null;
          return (
            <TagChip
              key={k}
              label={meta.title}
              icon={<Icon size={11} />}
              active={tagFilter === k}
              tone={meta.tone}
              bg={meta.bg}
              count={count}
              onClick={() => setTagFilter(k)}
            />
          );
        })}
      </div>

      {/* 模型列表 */}
      <div className="flex-1 min-h-0 overflow-auto space-y-1">
        {aggregateLoading ? (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            正在拉取所有平台的模型…
          </div>
        ) : aggregateError && filteredAggregated.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
            {aggregateError}
            <Button size="xs" variant="ghost" onClick={fetchAllModels} className="ml-2">
              重试
            </Button>
          </div>
        ) : filteredAggregated.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            {aggregatedModels.length === 0 ? '暂无可用模型，请先在"模型管理"配置平台' : '无匹配模型'}
          </div>
        ) : (
          filteredAggregated.map((row) => {
            const k = keyOf({ platformId: row.platformId, modelId: row.modelName });
            const isSelected = pool.some((x) => keyOf(x) === k);
            return (
              <button
                key={`${row.platformId}:${row.modelName}`}
                type="button"
                onClick={() => toggleAggregatedModel(row)}
                className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors"
                style={{
                  background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255,255,255,0.025)',
                  border: isSelected ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid transparent',
                }}
              >
                <Box size={12} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                <span
                  className="text-[12px] font-medium flex-1 min-w-0 truncate"
                  style={{ color: 'var(--text-primary)' }}
                  title={`${row.displayName} (${row.modelName})`}
                >
                  {row.displayName}
                </span>
                {/* 标签图标摘要（最多 4 个） */}
                {row.tags.length > 0 && (
                  <span className="flex items-center gap-0.5 shrink-0">
                    {row.tags.slice(0, 4).map((t) => {
                      const meta = TAG_META[t];
                      const Icon = meta.icon;
                      return (
                        <span key={t} title={meta.title} style={{ color: meta.tone }}>
                          <Icon size={10} />
                        </span>
                      );
                    })}
                  </span>
                )}
                <PlatformLabel name={row.platformName} size="sm" className="shrink-0" />
              </button>
            );
          })
        )}
      </div>
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
      {/* 视角切换：平台 / 大模型 */}
      <div className="flex items-center gap-1 mb-2 shrink-0">
        <ViewModeTab label="平台" active={viewMode === 'platform'} onClick={() => setViewMode('platform')} />
        <ViewModeTab label="大模型" active={viewMode === 'model'} onClick={() => setViewMode('model')} />
        <span className="ml-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {viewMode === 'platform' ? '按平台批量添加' : '跨平台聚合，按标签过滤'}
        </span>
      </div>

      {/* 中栏：根据视角切换 */}
      <div
        className="flex-1 min-h-0 rounded-[16px] p-3"
        style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.01)' }}
      >
        {viewMode === 'platform' ? middleByPlatform : middleByModel}
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

/* ── 内部小组件：视角 tab + 标签 chip ── */

function ViewModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 rounded-[8px] text-[12px] font-medium transition-all"
      style={{
        background: active ? 'rgba(59, 130, 246, 0.18)' : 'transparent',
        color: active ? 'rgba(59, 130, 246, 0.95)' : 'var(--text-muted)',
        border: active ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid var(--border-subtle)',
      }}
    >
      {label}
    </button>
  );
}

function TagChip({
  label,
  icon,
  active,
  onClick,
  tone,
  bg,
  count,
}: {
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  onClick: () => void;
  tone?: string;
  bg?: string;
  count?: number;
}) {
  const accent = tone || 'rgba(59, 130, 246, 0.95)';
  const accentBg = bg || 'rgba(59, 130, 246, 0.18)';
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[8px] text-[11px] font-medium transition-all whitespace-nowrap"
      style={{
        background: active ? accentBg : 'transparent',
        color: active ? accent : 'var(--text-muted)',
        border: active ? `1px solid ${accent}` : '1px solid transparent',
      }}
    >
      {icon}
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className="opacity-60">·{count}</span>
      )}
    </button>
  );
}
