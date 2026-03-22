import { useCallback, useEffect, useState } from 'react';
import {
  X, Heart, Eye, ChevronLeft, ChevronRight, FileText, Wand2,
  ImageIcon, Loader2, Palette, Brush, Layers, Sparkles, Maximize,
  Droplets, ImagePlus,
} from 'lucide-react';
import { glassPanel } from '@/lib/glassStyles';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import { Tabs } from '@/components/ui/Tabs';
import {
  getSubmissionDetail,
  likeSubmission,
  unlikeSubmission,
  type SubmissionDetail,
} from '@/services/real/submissions';
import { MarketplaceWatermarkCard } from '@/components/config-management/MarketplaceWatermarkCard';
import type { MarketplaceCardContext } from '@/components/config-management/ConfigManagementDialogBase';
import { forkWatermark } from '@/services';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SubmissionDetailModalProps {
  submissionId: string | null;
  onClose: () => void;
  onLikeChanged?: (id: string, likedByMe: boolean, count: number) => void;
}

export function SubmissionDetailModal({ submissionId, onClose, onLikeChanged }: SubmissionDetailModalProps) {
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedAssetIndex, setSelectedAssetIndex] = useState(0);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [liking, setLiking] = useState(false);
  const [rightTab, setRightTab] = useState('article');
  const [wmForkingId, setWmForkingId] = useState<string | null>(null);
  const watermarkForkCtx: MarketplaceCardContext = {
    saving: false,
    forkingId: wmForkingId,
    onFork: async (id, forkFn) => {
      setWmForkingId(id);
      try { await forkFn(); } finally { setWmForkingId(null); }
    },
  };

  useEffect(() => {
    if (!submissionId) { setDetail(null); return; }
    setLoading(true);
    setSelectedAssetIndex(0);
    setRightTab('prompts'); // 默认打开提示词 tab（最常看）
    getSubmissionDetail(submissionId).then((res) => {
      if (res.success) {
        setDetail(res.data);
        setLiked(res.data.submission.likedByMe);
        setLikeCount(res.data.submission.likeCount);
      }
    }).finally(() => setLoading(false));
  }, [submissionId]);

  useEffect(() => {
    if (!submissionId) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setSelectedAssetIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight' && detail)
        setSelectedAssetIndex((i) => Math.min(detail.relatedAssets.length - 1, i + 1));
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [submissionId, onClose, detail]);

  const handleLike = useCallback(async () => {
    if (liking || !submissionId) return;
    setLiking(true);
    const newLiked = !liked;
    setLiked(newLiked);
    setLikeCount((c) => c + (newLiked ? 1 : -1));
    try {
      const res = newLiked ? await likeSubmission(submissionId) : await unlikeSubmission(submissionId);
      if (res.success) {
        setLiked(res.data.likedByMe);
        setLikeCount(res.data.count);
        onLikeChanged?.(submissionId, res.data.likedByMe, res.data.count);
      }
    } catch {
      setLiked(!newLiked);
      setLikeCount((c) => c + (newLiked ? -1 : 1));
    } finally {
      setLiking(false);
    }
  }, [liking, liked, submissionId, onLikeChanged]);

  if (!submissionId) return null;

  const sub = detail?.submission;
  const assets = detail?.relatedAssets ?? [];
  const selectedAsset = assets[selectedAssetIndex] ?? null;
  const isLiterary = sub?.contentType === 'literary';
  const genInfo = detail?.generationInfo;
  const mainImageUrl = selectedAsset?.url || sub?.coverUrl || '';
  const avatarUrl = sub ? resolveAvatarUrl({ avatarFileName: sub.ownerAvatarFileName }) : '';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.88)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 h-10 w-10 rounded-full flex items-center justify-center transition-colors duration-200 hover:bg-white/15"
        style={glassPanel}
      >
        <X size={20} style={{ color: 'white' }} />
      </button>

      {/* 主内容 */}
      <div
        className="relative w-[96vw] max-w-[1400px] rounded-2xl overflow-hidden flex flex-col"
        style={{
          ...glassPanel,
          height: 'min(90vh, 820px)',
          maxHeight: 'calc(100vh - 32px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={32} className="animate-spin" style={{ color: 'var(--accent-primary)' }} />
          </div>
        ) : detail ? (
          <div className="flex h-full min-h-0">

            {/* ═══ 左侧缩略图列表 — 更宽 + 上下阴影渐隐 ═══ */}
            {assets.length > 1 && (
              <div
                className="shrink-0 relative"
                style={{
                  width: 120,
                  borderRight: '1px solid rgba(255,255,255,0.06)',
                  background: 'rgba(0,0,0,0.25)',
                }}
              >
                {/* 顶部阴影渐隐 */}
                <div
                  className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
                  style={{
                    height: 40,
                    background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)',
                  }}
                />
                {/* 底部阴影渐隐 */}
                <div
                  className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none"
                  style={{
                    height: 40,
                    background: 'linear-gradient(to top, rgba(0,0,0,0.6), transparent)',
                  }}
                />
                <div
                  className="h-full overflow-y-auto py-4 px-3 flex flex-col gap-2.5"
                  style={{ scrollbarWidth: 'none' }}
                >
                  {assets.map((asset, i) => (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => setSelectedAssetIndex(i)}
                      className="shrink-0 rounded-xl overflow-hidden transition-all duration-200"
                      style={{
                        width: 94,
                        height: 94,
                        border: i === selectedAssetIndex
                          ? '2.5px solid var(--accent-primary, #818CF8)'
                          : '2px solid rgba(255,255,255,0.08)',
                        opacity: i === selectedAssetIndex ? 1 : 0.55,
                        boxShadow: i === selectedAssetIndex ? '0 0 16px rgba(99,102,241,0.35)' : 'none',
                        transform: i === selectedAssetIndex ? 'scale(1.04)' : 'scale(1)',
                      }}
                    >
                      <img
                        src={asset.url}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ═══ 中间主图预览 ═══ */}
            <div className="flex-1 min-w-0 flex flex-col relative"
              style={{ background: 'rgba(0,0,0,0.3)' }}
            >
              <div className="flex-1 min-h-0 flex items-center justify-center p-6">
                {mainImageUrl ? (
                  <img
                    src={mainImageUrl}
                    alt={sub?.title || ''}
                    className="max-w-full max-h-full object-contain rounded-lg"
                    style={{
                      boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
                      transition: 'opacity 0.3s',
                    }}
                  />
                ) : (
                  <div
                    className="w-64 h-64 rounded-xl flex items-center justify-center"
                    style={{ background: 'rgba(255,255,255,0.03)' }}
                  >
                    <ImageIcon size={48} style={{ color: 'rgba(255,255,255,0.1)' }} />
                  </div>
                )}
              </div>

              {/* 导航箭头 */}
              {assets.length > 1 && (
                <>
                  <button
                    className="absolute left-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full flex items-center justify-center transition-colors duration-200 hover:bg-white/15"
                    style={glassPanel}
                    onClick={() => setSelectedAssetIndex((i) => Math.max(0, i - 1))}
                    disabled={selectedAssetIndex === 0}
                  >
                    <ChevronLeft size={20} style={{ color: 'white', opacity: selectedAssetIndex === 0 ? 0.3 : 1 }} />
                  </button>
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full flex items-center justify-center transition-colors duration-200 hover:bg-white/15"
                    style={glassPanel}
                    onClick={() => setSelectedAssetIndex((i) => Math.min(assets.length - 1, i + 1))}
                    disabled={selectedAssetIndex === assets.length - 1}
                  >
                    <ChevronRight size={20} style={{ color: 'white', opacity: selectedAssetIndex === assets.length - 1 ? 0.3 : 1 }} />
                  </button>
                  <div
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-medium"
                    style={{ ...glassPanel, color: 'white' }}
                  >
                    {selectedAssetIndex + 1} / {assets.length}
                  </div>
                </>
              )}
            </div>

            {/* ═══ 右侧信息面板 ═══ */}
            <div
              className="shrink-0 flex flex-col overflow-hidden"
              style={{
                width: 380,
                borderLeft: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {/* 作者信息 + 统计 */}
              <div className="shrink-0 px-5 pt-5 pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={avatarUrl}
                      alt={sub?.ownerUserName || ''}
                      className="w-10 h-10 rounded-full object-cover shrink-0 ring-1 ring-white/10"
                      onError={(e) => { (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK; }}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary, #fff)' }}>
                        {sub?.ownerUserName}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted, rgba(255,255,255,0.4))' }}>
                        {sub?.createdAt ? new Date(sub.createdAt).toLocaleDateString('zh-CN') : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <Eye size={13} />
                      {sub?.viewCount ?? 0}
                    </span>
                    <button
                      type="button"
                      onClick={handleLike}
                      disabled={liking}
                      className="flex items-center gap-1 transition-colors duration-150"
                      style={{ color: liked ? '#F43F5E' : 'var(--text-muted)' }}
                    >
                      <Heart size={15} fill={liked ? '#F43F5E' : 'none'} />
                      <span className="text-xs">{likeCount}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* 内容区域：右上角 = 输入物 tabs + 右下角 = 输出物 */}
              <div className="flex-1 min-h-0 flex flex-col">
                {/* ── 右上角：输入配方 Tabs（正文 | 提示词 | 参考图 | 水印） ── */}
                <div className="shrink-0 px-5 pt-3 pb-1">
                  <Tabs
                    items={[
                      ...(isLiterary ? [{ key: 'article', label: '正文', icon: <FileText size={12} /> }] : []),
                      { key: 'prompts', label: '提示词', icon: <Wand2 size={12} /> },
                      { key: 'refImage', label: '参考图', icon: <ImagePlus size={12} /> },
                      { key: 'watermark', label: '水印', icon: <Droplets size={12} /> },
                    ]}
                    activeKey={rightTab}
                    onChange={setRightTab}
                  />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3" style={{ scrollbarWidth: 'none' }}>
                  {/* ── 正文 Tab（仅文学创作） ── */}
                  {rightTab === 'article' && isLiterary && (
                    <div className="text-sm leading-relaxed arena-markdown" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {detail.articleContent || '暂无文章内容'}
                      </ReactMarkdown>
                    </div>
                  )}

                  {/* ── 提示词 Tab ── */}
                  {rightTab === 'prompts' && (
                    <div className="space-y-4">
                      {/* 当前图片的提示词 */}
                      <div>
                        <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                          <Wand2 size={12} />
                          提示词
                        </div>
                        <div
                          className="text-sm leading-relaxed rounded-xl p-3.5"
                          style={{
                            color: 'var(--text-secondary, rgba(255,255,255,0.7))',
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid rgba(255,255,255,0.04)',
                          }}
                        >
                          {selectedAsset?.prompt || genInfo?.promptText || sub?.prompt || '无提示词'}
                        </div>
                      </div>

                      {/* 风格提示词 */}
                      {genInfo?.stylePrompt && (
                        <div>
                          <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                            <Palette size={12} />
                            风格提示词
                          </div>
                          <div
                            className="text-sm leading-relaxed rounded-xl p-3.5"
                            style={{
                              color: 'var(--text-secondary, rgba(255,255,255,0.7))',
                              background: 'rgba(99,102,241,0.06)',
                              border: '1px solid rgba(99,102,241,0.15)',
                            }}
                          >
                            {genInfo.stylePrompt}
                          </div>
                        </div>
                      )}

                      {/* 系统提示词 */}
                      {genInfo?.systemPromptName && (
                        <div>
                          <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                            <FileText size={12} />
                            系统提示词
                          </div>
                          <div
                            className="rounded-xl p-3.5"
                            style={{
                              background: 'rgba(255,255,255,0.03)',
                              border: '1px solid rgba(255,255,255,0.04)',
                            }}
                          >
                            <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                              {genInfo.systemPromptName}
                            </div>
                            {genInfo.systemPromptContent && (
                              <div className="text-xs leading-relaxed line-clamp-6" style={{ color: 'var(--text-muted)' }}>
                                {genInfo.systemPromptContent}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 生成参数标签 */}
                      {genInfo && (genInfo.modelName || genInfo.size) && (
                        <div>
                          <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                            <Sparkles size={12} />
                            生成参数
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {genInfo.modelName && (
                              <InfoBadge icon={<Palette size={11} />} label={genInfo.modelName} />
                            )}
                            {genInfo.size && (
                              <InfoBadge icon={<Maximize size={11} />} label={genInfo.size} />
                            )}
                          </div>
                        </div>
                      )}

                      {/* 文学创作：每张图的提示词列表 */}
                      {isLiterary && assets.length > 0 && (
                        <div>
                          <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
                            各配图提示词
                          </div>
                          <div className="space-y-2">
                            {assets.map((asset, i) => (
                              <div
                                key={asset.id}
                                className="rounded-xl p-3 cursor-pointer transition-all duration-200"
                                style={{
                                  background: i === selectedAssetIndex ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.03)',
                                  border: i === selectedAssetIndex ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(255,255,255,0.04)',
                                }}
                                onClick={() => setSelectedAssetIndex(i)}
                              >
                                <div className="flex items-start gap-2">
                                  <img src={asset.url} alt="" className="w-10 h-10 rounded-md object-cover shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    {asset.originalMarkerText && (
                                      <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{asset.originalMarkerText}</div>
                                    )}
                                    <div className="text-xs line-clamp-2" style={{ color: 'var(--text-muted)' }}>{asset.prompt || '无提示词'}</div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── 参考图 Tab ── */}
                  {rightTab === 'refImage' && (
                    <div className="space-y-4">
                      {genInfo?.hasReferenceImage ? (
                        <>
                          <div className="flex flex-wrap gap-2 mb-3">
                            <InfoBadge
                              icon={<Layers size={11} />}
                              label={`图生图${genInfo.referenceImageCount && genInfo.referenceImageCount > 1 ? ` (${genInfo.referenceImageCount}张)` : ''}`}
                              accent
                            />
                            {genInfo.hasInpainting && (
                              <InfoBadge icon={<Brush size={11} />} label="涂抹重绘" accent />
                            )}
                            {genInfo.referenceImageConfigName && (
                              <InfoBadge icon={<FileText size={11} />} label={genInfo.referenceImageConfigName} />
                            )}
                          </div>

                          {/* 单图初始化 */}
                          {genInfo.initImageUrl && (
                            <div>
                              <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>初始参考图</div>
                              <img
                                src={genInfo.initImageUrl}
                                alt="参考图"
                                className="w-full rounded-xl object-contain"
                                style={{ maxHeight: 200, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
                              />
                            </div>
                          )}

                          {/* 多图引用 */}
                          {genInfo.imageRefs && genInfo.imageRefs.length > 0 && (
                            <div>
                              <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>参考图列表</div>
                              <div className="grid grid-cols-2 gap-2">
                                {genInfo.imageRefs.map((ref, i) => (
                                  <div key={ref.refId || i} className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                                    {ref.url && (
                                      <img src={ref.url} alt={ref.label || ''} className="w-full aspect-square object-cover" />
                                    )}
                                    {(ref.label || ref.role) && (
                                      <div className="px-2 py-1.5 text-[11px]" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.02)' }}>
                                        {ref.label || ref.role}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-8 gap-2" style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}>
                          <ImagePlus size={32} style={{ opacity: 0.3 }} />
                          <span className="text-xs">未使用参考图</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── 水印 Tab ── */}
                  {rightTab === 'watermark' && (
                    <div>
                      {genInfo?.watermarkConfigId ? (
                        <MarketplaceWatermarkCard
                          config={{
                            id: genInfo.watermarkConfigId,
                            name: genInfo.watermarkName || '水印配置',
                            text: genInfo.watermarkText || '',
                            fontKey: genInfo.watermarkFontKey || 'default',
                            fontSizePx: genInfo.watermarkFontSizePx ?? 0,
                            opacity: genInfo.watermarkOpacity,
                            anchor: genInfo.watermarkAnchor,
                            offsetX: genInfo.watermarkOffsetX,
                            offsetY: genInfo.watermarkOffsetY,
                            positionMode: genInfo.watermarkPositionMode,
                            iconEnabled: genInfo.watermarkIconEnabled,
                            borderEnabled: genInfo.watermarkBorderEnabled,
                            backgroundEnabled: genInfo.watermarkBackgroundEnabled,
                            roundedBackgroundEnabled: genInfo.watermarkRoundedBackgroundEnabled,
                            previewUrl: genInfo.watermarkPreviewUrl,
                            forkCount: 0,
                            createdAt: sub?.createdAt || '',
                            ownerUserId: sub?.ownerUserId || '',
                            ownerUserName: sub?.ownerUserName || '',
                            ownerUserAvatar: avatarUrl,
                          }}
                          ctx={watermarkForkCtx}
                          onFork={async () => {
                            const res = await forkWatermark({ id: genInfo.watermarkConfigId! });
                            return res.success;
                          }}
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center py-8 gap-2" style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}>
                          <Droplets size={32} style={{ opacity: 0.3 }} />
                          <span className="text-xs">未使用水印</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ── 右下角：输出物（同项目作品扇形列表） ── */}
                {assets.length > 1 && (
                  <div className="shrink-0 px-5 pb-4 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
                      同项目作品 ({assets.length})
                    </div>
                    <div className="flex gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                      {assets.map((asset, i) => (
                        <button
                          key={asset.id}
                          type="button"
                          onClick={() => setSelectedAssetIndex(i)}
                          className="shrink-0 rounded-lg overflow-hidden transition-all duration-200"
                          style={{
                            width: 48,
                            height: 48,
                            border: i === selectedAssetIndex
                              ? '2px solid var(--accent-primary, #818CF8)'
                              : '2px solid transparent',
                            opacity: i === selectedAssetIndex ? 1 : 0.6,
                            transform: i === selectedAssetIndex ? 'translateY(-2px)' : 'none',
                          }}
                        >
                          <img src={asset.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>加载失败</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** 参数小标签 */
function InfoBadge({ icon, label, accent }: { icon: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium"
      style={{
        background: accent ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.04)',
        border: accent ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(255,255,255,0.06)',
        color: accent ? 'var(--accent-primary, #818CF8)' : 'var(--text-secondary, rgba(255,255,255,0.6))',
      }}
    >
      {icon}
      {label}
    </span>
  );
}
