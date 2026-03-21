import { useCallback, useEffect, useState } from 'react';
import {
  X, Heart, Eye, ChevronLeft, ChevronRight, FileText, Wand2,
  ImageIcon, Loader2,
} from 'lucide-react';
import { glassPanel } from '@/lib/glassStyles';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import { Tabs } from '@/components/ui/Tabs';
import {
  getSubmissionDetail,
  likeSubmission,
  unlikeSubmission,
  type SubmissionDetail,
  type RelatedAsset,
} from '@/services/real/submissions';

interface SubmissionDetailModalProps {
  submissionId: string | null;
  onClose: () => void;
  /** 通知父组件点赞状态变化 */
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

  // 加载详情
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

  // 键盘
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

  // 当前大图 URL：优先选中的资产，否则用封面
  const mainImageUrl = selectedAsset?.url || sub?.coverUrl || '';

  const avatarUrl = sub ? resolveAvatarUrl({ avatarFileName: sub.ownerAvatarFileName }) : '';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.88)' }}
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
        className="relative w-[94vw] max-w-[1280px] rounded-2xl overflow-hidden flex flex-col"
        style={{
          ...glassPanel,
          height: 'min(88vh, 780px)',
          maxHeight: 'calc(100vh - 48px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={32} className="animate-spin" style={{ color: 'var(--accent-primary)' }} />
          </div>
        ) : detail ? (
          <div className="flex h-full min-h-0">

            {/* ═══ 左侧缩略图列表 ═══ */}
            {assets.length > 1 && (
              <div
                className="shrink-0 overflow-y-auto py-3 px-2 flex flex-col gap-2"
                style={{
                  width: 88,
                  borderRight: '1px solid rgba(255,255,255,0.06)',
                  background: 'rgba(0,0,0,0.2)',
                }}
              >
                {assets.map((asset, i) => (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => setSelectedAssetIndex(i)}
                    className="shrink-0 rounded-lg overflow-hidden transition-all duration-200"
                    style={{
                      width: 72,
                      height: 72,
                      border: i === selectedAssetIndex
                        ? '2px solid var(--accent-primary, #818CF8)'
                        : '2px solid transparent',
                      opacity: i === selectedAssetIndex ? 1 : 0.6,
                      boxShadow: i === selectedAssetIndex ? '0 0 12px rgba(99,102,241,0.3)' : 'none',
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
            )}

            {/* ═══ 中间主图预览 ═══ */}
            <div className="flex-1 min-w-0 flex flex-col relative"
              style={{ background: 'rgba(0,0,0,0.3)' }}
            >
              {/* 大图 */}
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

              {/* 底部导航箭头（多图时） */}
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
                  {/* 计数器 */}
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
                width: 360,
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
                      className="w-9 h-9 rounded-full object-cover shrink-0"
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

              {/* 内容区域（tab 切换） */}
              <div className="flex-1 min-h-0 flex flex-col">
                {isLiterary ? (
                  /* ── 文学创作：tabs（正文 / 提示词） ── */
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
                    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
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
                  /* ── 视觉创作：显示提示词 + 模型信息 ── */
                  <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
                    {/* 当前图片的提示词 */}
                    <div className="mb-4">
                      <div className="text-xs font-medium mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                        <Wand2 size={12} />
                        提示词
                      </div>
                      <div
                        className="text-sm leading-relaxed rounded-xl p-3"
                        style={{
                          color: 'var(--text-secondary, rgba(255,255,255,0.7))',
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.04)',
                        }}
                      >
                        {selectedAsset?.prompt || sub?.prompt || '无提示词'}
                      </div>
                    </div>

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
