import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectAgentStore } from '@/stores/defectAgentStore';
import type { DefectReview, DefectStatus } from '@/services/contracts/defectAgent';
import { ArrowLeft, Play, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

const STATUS_LABELS: Record<DefectStatus, string> = {
  Draft: '草稿',
  Submitted: '待审核',
  Reviewing: '审核中',
  Analyzed: '已分析',
  Rejected: '已驳回',
  Fixing: '修复中',
  PrCreated: 'PR 已创建',
  Merged: '已合并',
  Verified: '已验证',
  Closed: '已关闭',
};

function ReviewTimeline({ reviews }: { reviews: DefectReview[] }) {
  if (reviews.length === 0) return <p className="text-xs text-white/30">暂无审核记录</p>;

  return (
    <div className="space-y-3">
      {reviews.map((r) => (
        <div key={r.id} className="relative pl-4 border-l border-white/10">
          <div className="absolute left-[-5px] top-1 w-2.5 h-2.5 rounded-full bg-blue-400" />
          <div className="text-xs text-white/40">{new Date(r.createdAt).toLocaleString()}</div>
          <div className="text-xs text-white/60 mt-0.5">
            <span className="font-medium">{r.phase}</span> — {r.verdict}
          </div>
          {r.content && (
            <div className="text-xs text-white/50 mt-1 whitespace-pre-wrap line-clamp-4">{r.content}</div>
          )}
          {r.locatedFiles && r.locatedFiles.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {r.locatedFiles.map((f, i) => (
                <div key={i} className="text-[10px] text-white/40 font-mono">
                  {f.filePath}
                  {f.startLine && `:${f.startLine}`}
                  {f.endLine && `-${f.endLine}`}
                  <span className="ml-1 text-white/30">({Math.round(f.confidence * 100)}%)</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function DefectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    currentDefect: defect,
    currentReviews: reviews,
    currentFixes: fixes,
    detailLoading,
    fetchDefectDetail,
    submitDefect,
    triggerFix,
    verifyFix,
    closeDefect,
    reopenDefect,
  } = useDefectAgentStore();

  useEffect(() => {
    if (id) fetchDefectDetail(id);
  }, [id, fetchDefectDetail]);

  if (detailLoading || !defect) {
    return (
      <div className="h-full flex items-center justify-center text-white/40 text-sm">
        {detailLoading ? '加载中...' : '缺陷不存在'}
      </div>
    );
  }

  const handleAction = async (action: () => Promise<unknown>) => {
    await action();
    if (id) fetchDefectDetail(id);
  };

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/defect-agent')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-white/90">{defect.title}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-400/20 text-blue-300">
              {STATUS_LABELS[defect.status] || defect.status}
            </span>
            {defect.priority && (
              <span className="text-xs text-white/40">{defect.priority.replace('_', ' ')}</span>
            )}
          </div>
        </div>
        {/* Actions */}
        <div className="flex items-center gap-2">
          {defect.status === 'Draft' && (
            <Button size="sm" onClick={() => handleAction(() => submitDefect(defect.id))}>
              <Play className="w-3.5 h-3.5 mr-1" /> 提交审核
            </Button>
          )}
          {defect.status === 'Analyzed' && (
            <Button size="sm" onClick={() => handleAction(() => triggerFix(defect.id))}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> 触发修复
            </Button>
          )}
          {defect.status === 'Merged' && (
            <Button size="sm" onClick={() => handleAction(() => verifyFix(defect.id))}>
              <CheckCircle className="w-3.5 h-3.5 mr-1" /> 确认修复
            </Button>
          )}
          {defect.status === 'Rejected' && (
            <Button variant="ghost" size="sm" onClick={() => handleAction(() => reopenDefect(defect.id))}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> 重新提交
            </Button>
          )}
          {defect.status !== 'Closed' && (
            <Button variant="ghost" size="sm" onClick={() => handleAction(() => closeDefect(defect.id))}>
              <XCircle className="w-3.5 h-3.5 mr-1" /> 关闭
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1">
        {/* Left: Defect Info */}
        <div className="lg:col-span-2 space-y-4">
          <GlassCard className="p-4">
            <h3 className="text-sm font-medium text-white/70 mb-2">描述</h3>
            <p className="text-sm text-white/60 whitespace-pre-wrap">{defect.description || '无描述'}</p>
          </GlassCard>

          {defect.reproSteps.length > 0 && (
            <GlassCard className="p-4">
              <h3 className="text-sm font-medium text-white/70 mb-2">重现步骤</h3>
              <ol className="list-decimal list-inside space-y-1">
                {defect.reproSteps.map((step, i) => (
                  <li key={i} className="text-sm text-white/60">{step}</li>
                ))}
              </ol>
            </GlassCard>
          )}

          {(defect.expectedBehavior || defect.actualBehavior) && (
            <GlassCard className="p-4">
              <div className="grid grid-cols-2 gap-4">
                {defect.expectedBehavior && (
                  <div>
                    <h3 className="text-sm font-medium text-white/70 mb-1">期望行为</h3>
                    <p className="text-sm text-white/60">{defect.expectedBehavior}</p>
                  </div>
                )}
                {defect.actualBehavior && (
                  <div>
                    <h3 className="text-sm font-medium text-white/70 mb-1">实际行为</h3>
                    <p className="text-sm text-white/60">{defect.actualBehavior}</p>
                  </div>
                )}
              </div>
            </GlassCard>
          )}

          {defect.environment && (
            <GlassCard className="p-4">
              <h3 className="text-sm font-medium text-white/70 mb-2">环境信息</h3>
              <div className="grid grid-cols-2 gap-2 text-xs text-white/50">
                {defect.environment.browser && <div>浏览器: {defect.environment.browser}</div>}
                {defect.environment.os && <div>系统: {defect.environment.os}</div>}
                {defect.environment.appVersion && <div>版本: {defect.environment.appVersion}</div>}
                {defect.environment.screenResolution && <div>分辨率: {defect.environment.screenResolution}</div>}
              </div>
            </GlassCard>
          )}

          {/* Fixes */}
          {fixes.length > 0 && (
            <GlassCard className="p-4">
              <h3 className="text-sm font-medium text-white/70 mb-2">修复记录</h3>
              <div className="space-y-2">
                {fixes.map((f) => (
                  <div key={f.id} className="text-xs text-white/50 border border-white/5 p-2 rounded">
                    <div>分支: <span className="font-mono">{f.branchName || '-'}</span></div>
                    <div>状态: {f.status}</div>
                    {f.prUrl && <div>PR: <a href={f.prUrl} className="text-blue-400 underline" target="_blank" rel="noreferrer">{f.prUrl}</a></div>}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}
        </div>

        {/* Right: Timeline */}
        <div className="space-y-4">
          <GlassCard className="p-4">
            <h3 className="text-sm font-medium text-white/70 mb-3">AI 审核时间线</h3>
            <ReviewTimeline reviews={reviews} />
          </GlassCard>

          <GlassCard className="p-4">
            <h3 className="text-sm font-medium text-white/70 mb-2">详情</h3>
            <div className="space-y-1 text-xs text-white/40">
              <div>ID: <span className="font-mono">{defect.id}</span></div>
              <div>创建: {new Date(defect.createdAt).toLocaleString()}</div>
              <div>更新: {new Date(defect.updatedAt).toLocaleString()}</div>
              {defect.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap mt-1">
                  {defect.tags.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 bg-white/5 rounded text-[10px]">{t}</span>
                  ))}
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
