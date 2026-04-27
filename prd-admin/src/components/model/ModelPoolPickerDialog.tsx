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
import { type AvailableModel } from '@/components/model/PlatformAvailableModelsDialog';
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

  // ── master-detail 状态 ──
  // 左栏选中：'all' = 跨平台聚合；其他 = 单平台 id
  const [selectedSource, setSelectedSource] = useState<'all' | string>('all');
  // 平台模型缓存（同一次 dialog 打开期间不重复拉取；切换/再次打开会延续，刷新按钮强制清空）
  const [modelsCache, setModelsCache] = useState<Record<string, AvailableModel[]>>({});
  // 正在拉取的平台 id 集合（独立 loading，避免一个失败影响另一个）
  const [loadingPlatforms, setLoadingPlatforms] = useState<Set<string>>(new Set());
  // 单平台拉取错误（独立 error）
  const [errorByPlatform, setErrorByPlatform] = useState<Record<string, string | undefined>>({});

  // 右栏过滤
  const [tagFilter, setTagFilter] = useState<PresetTagKey | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');

  // 弹窗每次打开重置过滤、默认选中"全部"
  useEffect(() => {
    if (!open) return;
    setSelectedSource('all');
    setTagFilter('all');
    setSearchTerm('');
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

  // ── 单平台懒加载（缓存命中即刻返回，不命中才发请求） ──
  const ensurePlatformLoaded = async (platformId: string) => {
    if (modelsCache[platformId] || loadingPlatforms.has(platformId)) return;
    setLoadingPlatforms((prev) => {
      const next = new Set(prev);
      next.add(platformId);
      return next;
    });
    try {
      const res = await apiRequest<AvailableModel[]>(
        `/api/mds/platforms/${platformId}/available-models`,
        { method: 'GET' }
      );
      if (!res.success) {
        throw new Error(res.error?.message || '拉取失败');
      }
      setModelsCache((prev) => ({ ...prev, [platformId]: res.data || [] }));
      setErrorByPlatform((prev) => ({ ...prev, [platformId]: undefined }));
    } catch (e) {
      setErrorByPlatform((prev) => ({
        ...prev,
        [platformId]: String((e as Error)?.message || e),
      }));
    } finally {
      setLoadingPlatforms((prev) => {
        const next = new Set(prev);
        next.delete(platformId);
        return next;
      });
    }
  };

  // 切换左栏选中：单平台 → 拉一个；全部 → 并发拉所有 enabled 平台（缓存内的会跳过）
  useEffect(() => {
    if (!open) return;
    if (selectedSource === 'all') {
      platformList.filter((p) => p.enabled).forEach((p) => ensurePlatformLoaded(p.id));
    } else {
      ensurePlatformLoaded(selectedSource);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedSource]);

  // 当前左栏选中所对应的可视模型集合（从缓存推导，自动套标签）
  const visibleRows = useMemo<AggregatedModelRow[]>(() => {
    const rows: AggregatedModelRow[] = [];
    const platformsToShow =
      selectedSource === 'all'
        ? platformList.filter((p) => p.enabled)
        : platformList.filter((p) => p.id === selectedSource);
    for (const p of platformsToShow) {
      const models = modelsCache[p.id] || [];
      for (const m of models) {
        const backendTags = normalizeBackendTags(m.tags);
        const tags =
          backendTags.length > 0
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
    }
    return rows;
  }, [selectedSource, modelsCache, platformList]);

  // 标签 / 搜索过滤
  const filteredRows = useMemo(() => {
    let result = visibleRows;
    if (tagFilter !== 'all') {
      result = result.filter((r) => r.tags.includes(tagFilter));
    }
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      result = result.filter(
        (r) =>
          r.modelName.toLowerCase().includes(term) ||
          r.displayName.toLowerCase().includes(term) ||
          r.platformName.toLowerCase().includes(term)
      );
    }
    return result;
  }, [visibleRows, tagFilter, searchTerm]);

  // 切池行选中态
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

  // 刷新当前选中的平台缓存（"全部"=清空全部缓存重新拉，单平台=只清那一个）
  const refreshSelected = () => {
    if (selectedSource === 'all') {
      setModelsCache({});
      setErrorByPlatform({});
      platformList.filter((p) => p.enabled).forEach((p) => ensurePlatformLoaded(p.id));
    } else {
      setModelsCache((prev) => {
        const next = { ...prev };
        delete next[selectedSource];
        return next;
      });
      setErrorByPlatform((prev) => ({ ...prev, [selectedSource]: undefined }));
      ensurePlatformLoaded(selectedSource);
    }
  };

  // 一键全选当前过滤结果
  const selectAllFiltered = () => {
    const adds = filteredRows.map((r) =>
      toSelectedModel({
        platformId: r.platformId,
        modelName: r.modelName,
        displayName: r.displayName,
        group: r.group,
      })
    );
    setPool((prev) => dedupeByPlatformAndModelId([...prev, ...adds]));
  };


  // ── master-detail 中栏 ──
  const allEnabledLoading = platformList.some((p) => p.enabled && loadingPlatforms.has(p.id));
  const totalCachedCount = platformList
    .filter((p) => p.enabled)
    .reduce((sum, p) => sum + (modelsCache[p.id]?.length || 0), 0);

  const middleMasterDetail = (
    <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: '180px 1fr' }}>
      {/* 左栏：平台列表 + "全部" */}
      <div
        className="min-h-0 overflow-auto rounded-[12px] p-1.5 space-y-0.5"
        style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.01)' }}
      >
        <PlatformSourceItem
          label="全部"
          count={totalCachedCount}
          loading={allEnabledLoading && totalCachedCount === 0}
          active={selectedSource === 'all'}
          onClick={() => setSelectedSource('all')}
        />
        <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
        {platformList.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            暂无平台
          </div>
        ) : (
          platformList.map((p) => (
            <PlatformSourceItem
              key={p.id}
              label={p.name}
              count={modelsCache[p.id]?.length}
              loading={loadingPlatforms.has(p.id)}
              error={errorByPlatform[p.id]}
              disabled={!p.enabled}
              active={selectedSource === p.id}
              onClick={() => setSelectedSource(p.id)}
            />
          ))
        )}
      </div>

      {/* 右栏：搜索 + 标签 chip + 模型行 */}
      <div className="min-h-0 flex flex-col gap-2">
        {/* 搜索 + 刷新 + 全选 */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="搜索模型名 / 显示名 / 平台..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full h-7 pl-7 pr-2 text-xs rounded-[8px] outline-none"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
            />
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={refreshSelected}
            disabled={allEnabledLoading}
            title={selectedSource === 'all' ? '清空缓存重新拉取所有平台' : '重新拉取该平台模型'}
          >
            <RefreshCw size={12} className={allEnabledLoading ? 'animate-spin' : ''} />
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={selectAllFiltered}
            disabled={filteredRows.length === 0}
            title="把当前过滤结果一次性加入下方"
          >
            全选 {filteredRows.length > 0 ? `·${filteredRows.length}` : ''}
          </Button>
        </div>

        {/* 标签 chip 过滤 */}
        <div className="flex items-center gap-1 flex-wrap">
          <TagChip
            label="全部"
            active={tagFilter === 'all'}
            onClick={() => setTagFilter('all')}
            count={visibleRows.length}
          />
          {ALL_TAG_KEYS.map((k) => {
            const meta = TAG_META[k];
            const Icon = meta.icon;
            const count = visibleRows.filter((r) => r.tags.includes(k)).length;
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
          {(() => {
            const isLoadingThis =
              selectedSource === 'all'
                ? allEnabledLoading && visibleRows.length === 0
                : loadingPlatforms.has(selectedSource);
            const errorMsg =
              selectedSource === 'all'
                ? null
                : errorByPlatform[selectedSource];

            if (isLoadingThis) {
              return (
                <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  {selectedSource === 'all' ? '正在拉取所有平台的模型…' : '正在拉取模型…'}
                </div>
              );
            }
            if (errorMsg && visibleRows.length === 0) {
              return (
                <div className="py-10 text-center text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
                  {errorMsg}
                  <Button size="xs" variant="ghost" onClick={refreshSelected} className="ml-2">
                    重试
                  </Button>
                </div>
              );
            }
            if (filteredRows.length === 0) {
              return (
                <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  {visibleRows.length === 0 ? '暂无可用模型' : '无匹配模型'}
                </div>
              );
            }
            return filteredRows.map((row) => {
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
                  {selectedSource === 'all' && (
                    <PlatformLabel name={row.platformName} size="sm" className="shrink-0" />
                  )}
                </button>
              );
            });
          })()}
        </div>
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
      {/* 中栏：master-detail（左平台 + 右模型） */}
      {middleMasterDetail}

      {/* 下栏：共享池 */}
      <div className="mt-4 shrink-0">{bottomPool}</div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      maxWidth={920}
      content={content}
    />
  );
}

/* ── 内部小组件：左栏平台条目 + 标签 chip ── */

function PlatformSourceItem({
  label,
  count,
  loading,
  error,
  disabled,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  loading?: boolean;
  error?: string;
  disabled?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-[8px] text-[12px] transition-colors"
      style={{
        background: active ? 'rgba(59, 130, 246, 0.14)' : 'transparent',
        color: active ? 'rgba(59, 130, 246, 0.95)' : disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        border: active ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid transparent',
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      title={error || (disabled ? '该平台未启用' : undefined)}
    >
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
      {loading ? (
        <span className="shrink-0 text-[10px] opacity-70">加载…</span>
      ) : error ? (
        <span className="shrink-0 text-[10px]" style={{ color: 'rgba(239,68,68,0.95)' }}>
          失败
        </span>
      ) : typeof count === 'number' ? (
        <span
          className="shrink-0 text-[10px] px-1 rounded"
          style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
        >
          {count}
        </span>
      ) : null}
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
