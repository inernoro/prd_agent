import { useCallback, useEffect, useState } from 'react';
import {
  X, Heart, Eye, ChevronLeft, ChevronRight, FileText, Wand2,
  ImageIcon, Loader2, Palette, Brush, Layers, Sparkles, Maximize,
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

  useEffect(() => {
    if (!submissionId) { setDetail(null); return; }
    setLoading(true);
    setSelectedAssetIndex(0);
    setRightTab('article');
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

              {/* 内容区域 */}
              <div className="flex-1 min-h-0 flex flex-col">
                {isLiterary ? (
                  <>
                    <div className="shrink-0 px-5 pt-3 pb-1">
                      <Tabs
                        items={[
                          { key: 'article', label: '正文', icon: <FileText size={12} /> },
                          { key: 'prompts', label: '提示词', icon: <Wand2 size={12} /> },
                        ]}
                        activeKey={rightTab}
                        onChange={setRightTab}
                      />
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3" style={{ scrollbarWidth: 'none' }}>
                      {rightTab === 'article' && (
                        <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                          {detail.articleContent || '暂无文章内容'}
                        </div>
                      )}
                      {rightTab === 'prompts' && (
                        <div className="space-y-3">
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
                                <img
                                  src={asset.url}
                                  alt=""
                                  className="w-10 h-10 rounded-md object-cover shrink-0"
                                />
                                <div className="min-w-0 flex-1">
                                  {asset.originalMarkerText && (
                                    <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                                      {asset.originalMarkerText}
                                    </div>
                                  )}
                                  <div className="text-xs line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                                    {asset.prompt || '无提示词'}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  /* ── 视觉创作：提示词 + 生成参数 + 同项目 ── */
                  <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4" style={{ scrollbarWidth: 'none' }}>
                    {/* 当前图片的提示词 */}
                    <div className="mb-4">
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
                        {selectedAsset?.prompt || sub?.prompt || '无提示词'}
                      </div>
                    </div>

                    {/* 生成参数标签 */}
                    {genInfo && (
                      <div className="mb-4">
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
                          {genInfo.hasReferenceImage && (
                            <InfoBadge
                              icon={<Layers size={11} />}
                              label={`图生图${genInfo.referenceImageCount && genInfo.referenceImageCount > 1 ? ` (${genInfo.referenceImageCount}张)` : ''}`}
                              accent
                            />
                          )}
                          {genInfo.hasInpainting && (
                            <InfoBadge icon={<Brush size={11} />} label="涂抹重绘" accent />
                          )}
                          {genInfo.systemPromptName && (
                            <InfoBadge icon={<FileText size={11} />} label={`提示词: ${genInfo.systemPromptName}`} />
                          )}
                          {genInfo.stylePrompt && (
                            <InfoBadge icon={<Palette size={11} />} label="风格统一" />
                          )}
                        </div>
                        {genInfo.stylePrompt && (
                          <div
                            className="mt-2 text-xs leading-relaxed rounded-lg p-2.5"
                            style={{
                              color: 'var(--text-muted)',
                              background: 'rgba(255,255,255,0.02)',
                              border: '1px solid rgba(255,255,255,0.03)',
                            }}
                          >
                            <span style={{ color: 'var(--text-secondary)' }}>风格: </span>
                            {genInfo.stylePrompt}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 同 workspace 其他图片 */}
                    {assets.length > 1 && (
                      <div>
                        <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
                          同项目作品 ({assets.length})
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {assets.map((asset, i) => (
                            <button
                              key={asset.id}
                              type="button"
                              onClick={() => setSelectedAssetIndex(i)}
                              className="rounded-lg overflow-hidden transition-all duration-200 aspect-square"
                              style={{
                                border: i === selectedAssetIndex
                                  ? '2px solid var(--accent-primary, #818CF8)'
                                  : '2px solid transparent',
                                opacity: i === selectedAssetIndex ? 1 : 0.7,
                              }}
                            >
                              <img src={asset.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
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
