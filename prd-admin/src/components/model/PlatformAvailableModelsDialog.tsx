import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { apiRequest } from '@/services/real/apiClient';
import type { Platform } from '@/types/admin';
import { resolveCherryGroupKey } from '@/lib/cherryModelGrouping';
import { inferPresetTagKeys, matchAvailableModelsTab, type PresetTagKey } from '@/lib/modelPresetTags';
import { getAvatarUrlByGroup, getAvatarUrlByModelName } from '@/assets/model-avatars';
import { ArrowDown, DatabaseZap, ImagePlus, Link2, Minus, Plus, RefreshCw, ScanEye, Search, Sparkles, Star, Wand2, Zap } from 'lucide-react';
import { systemDialog } from '@/lib/systemDialog';

export type AvailableModel = {
  /** 平台侧模型 ID（业务语义 modelId；后端字段名为 ModelName，前端历史命名为 modelName） */
  modelName: string;
  displayName: string;
  group?: string;
  tags?: string[];
};

function splitKeywords(input: string): string[] {
  return (input ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function matchAllKeywords(fullText: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const hay = (fullText ?? '').toLowerCase();
  return keywords.every((k) => hay.includes(k));
}

const isSvgAssetUrl = (url?: string | null) => !!url && /\.svg(\?|#|$)/i.test(url);
const isRasterAssetUrl = (url?: string | null) => !!url && /\.(png|jpe?g|webp|gif|bmp|ico)(\?|#|$)/i.test(url);

function presetTagMeta(tag: PresetTagKey): { title: string; icon: React.ReactNode; tone: string } {
  switch (tag) {
    case 'reasoning':
      return { title: '推理', icon: <Zap size={14} />, tone: 'rgba(251,146,60,0.95)' };
    case 'vision':
      return { title: '视觉', icon: <ScanEye size={14} />, tone: 'rgba(96,165,250,0.95)' };
    case 'websearch':
      return { title: '联网', icon: <Link2 size={14} />, tone: 'rgba(34,197,94,0.95)' };
    case 'function_calling':
      return { title: '工具', icon: <Sparkles size={14} />, tone: 'rgba(167,139,250,0.95)' };
    case 'embedding':
      return { title: '嵌入', icon: <DatabaseZap size={14} />, tone: 'rgba(34,211,238,0.95)' };
    case 'rerank':
      return { title: '重排', icon: <ArrowDown size={14} />, tone: 'rgba(245,158,11,0.95)' };
    case 'image_generation':
      return { title: '生图', icon: <ImagePlus size={14} />, tone: 'rgba(236,72,153,0.95)' };
    case 'free':
      return { title: '免费', icon: <Star size={14} />, tone: 'rgba(34,197,94,0.95)' };
  }
}

function PresetTagIcons({
  modelName,
  displayName,
  providerId,
  platformType,
  tagsHint,
}: {
  modelName: string;
  displayName?: string;
  providerId?: string;
  platformType?: string;
  tagsHint?: string[];
}) {
  const tags =
    tagsHint && tagsHint.length > 0
      ? (tagsHint
          .map((t) => {
            const k = (t || '').trim().toLowerCase();
            if (k === 'web_search' || k === 'websearch') return 'websearch';
            if (k === 'function_calling') return 'function_calling';
            if (k === 'embedding') return 'embedding';
            if (k === 'vision') return 'vision';
            if (k === 'rerank') return 'rerank';
            if (k === 'reasoning') return 'reasoning';
            if (k === 'free') return 'free';
            return null;
          })
          .filter(Boolean) as PresetTagKey[])
      : inferPresetTagKeys(modelName, displayName, providerId, platformType);
  if (tags.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 shrink-0" aria-label="预设标签">
      {tags.map((t) => {
        const meta = presetTagMeta(t);
        return (
          <span
            key={t}
            title={meta.title}
            className="inline-flex items-center justify-center h-[22px] w-[22px] rounded-[9px]"
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.04)',
              color: meta.tone,
            }}
          >
            {meta.icon}
          </span>
        );
      })}
    </div>
  );
}

function groupAvailableModels(list: AvailableModel[], providerId: string) {
  // 不做显式排序；顺序取决于远端返回顺序 + 首次出现 group 的插入顺序
  const groups = new Map<string, AvailableModel[]>();
  for (const m of list) {
    const key = (m.group || resolveCherryGroupKey(m.modelName, providerId) || 'other').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  return Array.from(groups.entries());
}

export function PlatformAvailableModelsDialog({
  open,
  onOpenChange,
  platform,
  description,
  selectedCount,
  selectedCountLabel = '已添加',
  selectedBadgeText = '已添加',
  isSelected,
  onToggle,
  onBulkAddGroup,
  onAfterWriteBack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Platform | null;
  description: string;
  selectedCount: number;
  selectedCountLabel?: string;
  selectedBadgeText?: string;
  isSelected: (m: AvailableModel) => boolean;
  onToggle: (m: AvailableModel) => void | Promise<void>;
  onBulkAddGroup: (groupName: string, ms: AvailableModel[]) => void | Promise<void>;
  onAfterWriteBack?: () => void | Promise<void>;
}) {
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableSearch, setAvailableSearch] = useState('');
  const [availableTab, setAvailableTab] = useState<'all' | 'reasoning' | 'vision' | 'web' | 'free' | 'embedding' | 'rerank' | 'tools'>('all');
  const [openAvailableGroups, setOpenAvailableGroups] = useState<Record<string, boolean>>({});

  const filteredAvailableModels = useMemo(() => {
    let list = availableModels;
    const pid = (platform?.providerId || platform?.platformType || '').trim();
    if (availableTab !== 'all') {
      const matchByHint = (m: AvailableModel) => {
        const hs = (m.tags || []).map((x) => (x || '').trim().toLowerCase());
        if (hs.length === 0) return null;
        if (availableTab === 'tools') return hs.includes('function_calling');
        if (availableTab === 'embedding') return hs.includes('embedding');
        if (availableTab === 'rerank') return hs.includes('rerank');
        if (availableTab === 'vision') return hs.includes('vision');
        if (availableTab === 'web') return hs.includes('web_search') || hs.includes('websearch');
        if (availableTab === 'free') return hs.includes('free');
        if (availableTab === 'reasoning') {
          // 推理 Tab 的语义是“可对话/推理的主入口”，因此在 tagsHint 存在时也要兜底：
          // - embedding/rerank/image_generation 这类不应出现在推理 Tab
          // - 其它默认可归为推理（即便 tagsHint 未显式包含 reasoning）
          if (hs.includes('embedding') || hs.includes('rerank') || hs.includes('image_generation')) return false;
          return true;
        }
        return null;
      };

      list = list.filter((m) => {
        const hinted = matchByHint(m);
        if (hinted !== null) return hinted;
        return matchAvailableModelsTab({
          tab: availableTab,
          modelName: m.modelName,
          displayName: m.displayName,
          providerId: pid,
          platformType: platform?.platformType,
        });
      });
    }
    const ks = splitKeywords(availableSearch);
    if (ks.length === 0) return list;
    const pName = platform?.name || '';
    return list.filter((m) => matchAllKeywords(`${m.displayName || ''} ${m.modelName || ''} ${pName}`, ks));
  }, [availableModels, availableSearch, availableTab, platform?.name, platform?.providerId, platform?.platformType]);

  const groupedAvailable = useMemo(() => {
    const pid = (platform?.providerId || platform?.platformType || '').trim();
    return groupAvailableModels(filteredAvailableModels, pid);
  }, [filteredAvailableModels, platform?.providerId, platform?.platformType]);

  useEffect(() => {
    if (!open) return;
    setAvailableSearch('');
    setAvailableTab('all');
    setAvailableModels([]);
    setAvailableError(null);
    setOpenAvailableGroups({});
  }, [open]);

  // 默认展开第一个分组（允许用户自行折叠/展开）
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

  const reclassifyWithMainModel = async () => {
    if (!platform?.id) return;
    const ok = await systemDialog.confirm({
      title: '确认执行',
      message: '将使用“主模型”对该平台可用模型重新分类，并写回已配置模型的分组/标签。是否继续？',
      confirmText: '继续',
      cancelText: '取消',
    });
    if (!ok) return;

    setAvailableLoading(true);
    setAvailableError(null);
    try {
      const idem = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const r = await apiRequest<{
        updatedCount: number;
        availableCount: number;
        configuredCount: number;
      }>(`/api/v1/admin/platforms/${platform.id}/reclassify-models`, {
        method: 'POST',
        body: {},
        headers: { 'Idempotency-Key': idem },
      });
      if (!r.success) {
        setAvailableError(r.error?.message || '主模型分类失败');
        return;
      }
      const d = r.data as { updatedCount?: number; configuredCount?: number; availableCount?: number } | null;
      void systemDialog.alert(`主模型分类完成：更新 ${d?.updatedCount ?? 0} 个（已配置 ${d?.configuredCount ?? 0} / 可用 ${d?.availableCount ?? 0}）`);
      if (onAfterWriteBack) await onAfterWriteBack();
      await fetchAvailableModels({ refresh: true });
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
      description={description}
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
            <Button
              variant="secondary"
              size="sm"
              onClick={reclassifyWithMainModel}
              disabled={!platform?.id || availableLoading}
              aria-label="主模型分类"
              title="主模型分类（写回分组与标签）"
            >
              <Wand2 size={16} />
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
              可用 {filteredAvailableModels.length} 个 · {selectedCountLabel} {selectedCount} 个
            </div>
          </div>

          <div className="rounded-[16px] overflow-hidden flex flex-col flex-1 min-h-0" style={{ border: '1px solid var(--border-subtle)' }}>
            {availableLoading ? (
              <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            ) : availableError ? (
              <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>{availableError}</div>
            ) : groupedAvailable.length === 0 ? (
              <div className="py-14 text-center" style={{ color: 'var(--text-muted)' }}>暂无可用模型</div>
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
                      <summary
                        className="px-4 py-3 flex items-center justify-between cursor-pointer select-none"
                        style={{ background: 'rgba(255,255,255,0.03)' }}
                      >
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{g}</div>
                        <div className="flex items-center gap-2">
                          <Badge variant="subtle">{ms.length}</Badge>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center h-[26px] w-[26px] rounded-[10px] hover:bg-white/6"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                            title="批量添加该组"
                            onClick={(e) => {
                              e.preventDefault(); // 避免触发 summary toggle
                              e.stopPropagation();
                              void onBulkAddGroup(g, ms);
                            }}
                          >
                            <Plus size={16} />
                          </button>
                        </div>
                      </summary>
                      <div className="divide-y divide-white/30">
                        {ms.map((m) => {
                          const exist = isSelected(m);
                          // 统一展示：默认只显示平台侧模型 ID（modelName）
                          const label = String(m.modelName ?? '').trim();
                          const avatarUrl =
                            (g || '').toLowerCase() === 'other' ? getAvatarUrlByModelName(m.modelName || label) : getAvatarUrlByGroup(g);
                          return (
                            <div
                              key={`${g}:${m.modelName}`}
                              className="px-4 py-3 flex items-center justify-between transition-colors"
                              style={{ background: exist ? 'rgba(34,197,94,0.08)' : 'transparent' }}
                            >
                              <div className="min-w-0 flex items-center gap-3">
                                <div
                                  className="h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-extrabold"
                                  style={{
                                    background: !avatarUrl || isSvgAssetUrl(avatarUrl) ? 'rgba(59,130,246,0.14)' : 'rgba(255, 255, 255, 0)',
                                    color: 'rgba(59,130,246,0.95)',
                                    border: '1px solid var(--border-subtle)',
                                  }}
                                >
                                  {avatarUrl ? (
                                    isRasterAssetUrl(avatarUrl) ? (
                                      <div className="h-6 w-6 rounded-full overflow-hidden bg-transparent">
                                        <img src={avatarUrl} alt={g} className="h-full w-full object-contain" style={{ opacity: 1 }} />
                                      </div>
                                    ) : (
                                      <img
                                        src={avatarUrl}
                                        alt={g}
                                        className="h-5 w-5 object-contain"
                                        style={{ opacity: 1, filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.35))' }}
                                      />
                                    )
                                  ) : (
                                    g.slice(0, 1).toUpperCase()
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                      {label}
                                    </div>
                                    {exist ? <Badge variant="success">{selectedBadgeText}</Badge> : null}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <PresetTagIcons
                                  modelName={m.modelName}
                                  displayName={m.displayName}
                                  providerId={(platform?.providerId || platform?.platformType || '').trim()}
                                  platformType={platform?.platformType}
                                  tagsHint={m.tags}
                                />
                                <Button
                                  variant={exist ? 'secondary' : 'ghost'}
                                  size="sm"
                                  onClick={() => void onToggle(m)}
                                  disabled={availableLoading}
                                  aria-label={exist ? '移除' : '添加'}
                                >
                                  {exist ? <Minus size={16} /> : <Plus size={16} />}
                                </Button>
                              </div>
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


