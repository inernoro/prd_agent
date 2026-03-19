import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Eye, Trash2, FileText, Zap, BarChart3, Loader2 } from 'lucide-react';
import { listDefectShares, revokeDefectShare, createBatchShare, getShareScores } from '@/services';
import { api } from '@/services/api';
import { useSseStream } from '@/lib/useSseStream';
import { SseStreamPanel } from '@/components/sse';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { glassPanel } from '@/lib/glassStyles';
import { DefectFixReportPanel } from './DefectFixReportPanel';
import type { DefectShareLink, DefectAiScoreItem } from '@/services/contracts/defectAgent';

interface SharesListPanelProps {
  open: boolean;
  onClose: () => void;
  /** 自动打开某个 share 的报告 (从通知跳转) */
  autoOpenShareId?: string;
}

export function SharesListPanel({ open, onClose, autoOpenShareId }: SharesListPanelProps) {
  const [shares, setShares] = useState<DefectShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportShareId, setReportShareId] = useState<string | null>(null);
  const [reportShareTitle, setReportShareTitle] = useState<string | undefined>(undefined);
  const [batchLoading, setBatchLoading] = useState(false);

  // AI 评分流式状态
  const [scoreShareId, setScoreShareId] = useState<string | null>(null);
  const [scores, setScores] = useState<DefectAiScoreItem[]>([]);

  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listDefectShares();
      if (res.success && res.data) setShares(res.data.items);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  // SSE 流式 hook
  const sse = useSseStream<DefectAiScoreItem>({
    url: scoreShareId ? api.defectAgent.shares.scoresStream(scoreShareId) : '',
    itemEvent: 'score',
    onItem: (item) => setScores((prev) => [...prev, item]),
    onDone: () => loadShares(),
    onError: (msg) => toast.error(msg),
  });

  useEffect(() => {
    if (open) loadShares();
  }, [open, loadShares]);

  // Auto-open report panel from notification
  useEffect(() => {
    if (autoOpenShareId && shares.length > 0) {
      const share = shares.find((s) => s.id === autoOpenShareId);
      if (share) {
        setReportShareId(share.id);
        setReportShareTitle(share.title ?? undefined);
      }
    }
  }, [autoOpenShareId, shares]);

  const handleRevoke = async (share: DefectShareLink) => {
    const confirmed = await systemDialog.confirm('确定要撤销此分享链接吗？撤销后外部 Agent 将无法访问。');
    if (!confirmed) return;

    try {
      const res = await revokeDefectShare({ id: share.id });
      if (res.success) {
        toast.success('已撤销');
        loadShares();
      } else {
        toast.error(res.error?.message || '撤销失败');
      }
    } catch { toast.error('撤销失败'); }
  };

  /** 复制分享链接 — 生成 LLM 友好的 prompt 到剪贴板 */
  const handleCopy = (share: DefectShareLink) => {
    const baseUrl = window.location.origin;
    const viewUrl = `${baseUrl}/api/defect-agent/share/view/${share.token}`;

    const prompt = [
      `## 缺陷修复任务`,
      ``,
      `我有 ${share.defectIds?.length || '若干'} 个软件缺陷需要你帮忙分析和修复。`,
      ``,
      `### 认证信息`,
      ``,
      `所有请求都需要携带以下两个 Header：`,
      `\`\`\``,
      `X-AI-Access-Key: $AI_ACCESS_KEY`,
      `X-AI-Impersonate: admin`,
      `\`\`\``,
      `> AI_ACCESS_KEY 从环境变量中读取，请确保已设置。`,
      ``,
      `### 操作步骤`,
      ``,
      `1. **获取缺陷数据**：`,
      `   \`\`\``,
      `   GET ${viewUrl}`,
      `   \`\`\``,
      `   响应中包含缺陷列表、附件截图 URL、以及后续操作的 API 端点说明。`,
      ``,
      `2. **分析缺陷**：阅读每个缺陷的描述和截图，生成修复计划。`,
      ``,
      `3. **提交分析报告**（可选）：`,
      `   \`\`\``,
      `   POST ${viewUrl}/report`,
      `   Content-Type: application/json`,
      `   `,
      `   { "agentName": "你的名称", "items": [{ "defectId": "...", "confidenceScore": 85, "analysis": "分析内容", "fixSuggestion": "修复建议" }] }`,
      `   \`\`\``,
      ``,
      `4. **执行修复**：根据分析结果修改代码。`,
      ``,
      `5. **标记修复完成**：修复完成后调用以下接口通知缺陷提交者：`,
      `   \`\`\``,
      `   POST ${viewUrl}/fix-status`,
      `   Content-Type: application/json`,
      `   `,
      `   { "items": [{ "defectId": "...", "resolution": "修复说明" }] }`,
      `   \`\`\``,
      ``,
      `请先调用步骤 1 的 API 获取具体缺陷数据，然后告诉我你的修复计划。`,
    ].join('\n');

    navigator.clipboard.writeText(prompt).catch(() => {});
    toast.success('已复制 AI 提示词到剪贴板');
  };

  /** 启动 SSE 流式评分 */
  const startScoringStream = useCallback((shareId: string) => {
    setScoreShareId(shareId);
    setScores([]);
    // 直接传入 URL 覆盖，避免闭包捕获旧 url
    sse.start({ url: api.defectAgent.shares.scoresStream(shareId) });
  }, [sse]);

  /** 一键分享所有缺陷 + 自动打开 SSE 评分 */
  const handleBatchShare = async () => {
    setBatchLoading(true);
    try {
      const res = await createBatchShare({ expiresInDays: 7 });
      if (res.success && res.data) {
        loadShares();
        startScoringStream(res.data.shareLink.id);
      } else {
        toast.error(res.error?.message || '创建失败');
      }
    } catch {
      toast.error('创建失败');
    } finally {
      setBatchLoading(false);
    }
  };

  /** 查看已有评分（已完成的用非流式，未完成的用 SSE） */
  const handleViewScores = async (share: DefectShareLink) => {
    setScoreShareId(share.id);
    setScores([]);

    if (share.aiScoreStatus === 'completed') {
      try {
        const res = await getShareScores({ shareId: share.id });
        if (res.success && res.data) {
          setScores(res.data.scores);
        }
      } catch {
        toast.error('获取评分失败');
        setScoreShareId(null);
      }
    } else {
      startScoringStream(share.id);
    }
  };

  const closeScoring = () => {
    sse.abort();
    sse.reset();
    setScoreShareId(null);
    setScores([]);
  };

  const scopeLabel = (s: DefectShareLink) => {
    if (s.shareScope === 'single') return '单个缺陷';
    if (s.shareScope === 'project') return `项目: ${s.projectName || '未知'}`;
    return `已选 ${s.defectIds.length} 个`;
  };

  const aiScoreLabel = (s: DefectShareLink) => {
    if (s.aiScoreStatus === 'scoring') return '评分中...';
    if (s.aiScoreStatus === 'completed') return `${s.aiScoreCount ?? 0} 项评分`;
    if (s.aiScoreStatus === 'failed') return '评分失败';
    return null;
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => !v && onClose()}
        title="分享管理"
        maxWidth={640}
        content={
          <div className="mt-2 space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {/* 一键分享按钮 */}
            <Button
              variant="primary"
              size="sm"
              onClick={handleBatchShare}
              disabled={batchLoading}
              className="w-full"
            >
              {batchLoading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {batchLoading ? '创建中...' : '一键分享所有缺陷（AI 评分）'}
            </Button>

            {loading && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</p>}
            {!loading && shares.length === 0 && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无分享记录</p>
            )}
            {shares.map((share) => {
              const isExpired = share.isExpired || new Date(share.expiresAt) < new Date();
              const dimmed = isExpired || share.isRevoked;
              const scoreText = aiScoreLabel(share);

              return (
                <div
                  key={share.id}
                  className="rounded-xl p-3 flex items-center gap-3"
                  style={{ ...glassPanel, opacity: dimmed ? 0.5 : 1 }}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {share.title || '未命名分享'}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{scopeLabel(share)}</span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {new Date(share.createdAt).toLocaleDateString()}
                      </span>
                      <span className="text-xs flex items-center gap-0.5" style={{ color: 'var(--text-muted)' }}>
                        <Eye size={10} /> {share.viewCount}
                      </span>
                      {(share.reportCount ?? 0) > 0 && (
                        <span className="text-xs flex items-center gap-0.5" style={{ color: 'rgba(120,220,180,0.9)' }}>
                          <FileText size={10} /> {share.reportCount} 报告
                        </span>
                      )}
                      {scoreText && (
                        <span
                          className="text-xs flex items-center gap-0.5"
                          style={{
                            color: share.aiScoreStatus === 'completed'
                              ? 'rgba(120,180,255,0.9)'
                              : share.aiScoreStatus === 'scoring'
                              ? 'rgba(255,200,100,0.9)'
                              : 'rgba(255,100,100,0.8)',
                          }}
                        >
                          <BarChart3 size={10} /> {scoreText}
                        </span>
                      )}
                      {isExpired && (
                        <span className="text-xs" style={{ color: 'rgba(255,100,100,0.8)' }}>已过期</span>
                      )}
                      {share.isRevoked && (
                        <span className="text-xs" style={{ color: 'rgba(255,100,100,0.8)' }}>已撤销</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {(share.aiScoreStatus === 'completed' || share.aiScoreStatus === 'none') && (
                      <Button variant="secondary" size="xs" onClick={() => handleViewScores(share)}>
                        {share.aiScoreStatus === 'completed' ? '评分' : 'AI 评分'}
                      </Button>
                    )}
                    {(share.reportCount ?? 0) > 0 && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => { setReportShareId(share.id); setReportShareTitle(share.title ?? undefined); }}
                      >
                        查看报告
                      </Button>
                    )}
                    {!dimmed && (
                      <>
                        <Button variant="ghost" size="xs" onClick={() => handleCopy(share)} title="复制 AI 提示词">
                          <Copy size={12} />
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => handleRevoke(share)} className="text-red-400">
                          <Trash2 size={12} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        }
      />

      {reportShareId && (
        <DefectFixReportPanel
          open={!!reportShareId}
          onClose={() => { setReportShareId(null); setReportShareTitle(undefined); }}
          shareId={reportShareId}
          shareTitle={reportShareTitle}
        />
      )}

      {/* AI 评分实时面板 */}
      {scoreShareId && (
        <Dialog
          open={!!scoreShareId}
          onOpenChange={(v) => { if (!v) closeScoring(); }}
          title="AI 缺陷评分"
          maxWidth={720}
          content={
            <div className="mt-2 max-h-[65vh] overflow-y-auto pr-1">
              <SseStreamPanel
                phase={scores.length > 0 && !sse.isStreaming ? 'done' : sse.phase}
                phaseMessage={scores.length > 0 && !sse.isStreaming ? `评分完成，共 ${scores.length} 个` : sse.phaseMessage}
                typing={sse.typing}
                isDone={sse.isDone || (scores.length > 0 && !sse.isStreaming)}
                hasData={scores.length > 0}
                phaseExtra={sse.isStreaming && scores.length > 0 ? `已完成 ${scores.length} 个` : undefined}
                typingLabel="AI 分析过程"
              >
                <div className="space-y-2">
                  {scores.map((s, i) => (
                    <ScoreCard key={s.defectId} score={s} index={i} />
                  ))}
                </div>
              </SseStreamPanel>
            </div>
          }
        />
      )}
    </>
  );
}

/** 单个评分卡片 */
function ScoreCard({ score: s, index }: { score: DefectAiScoreItem; index: number }) {
  const overallColor = scoreColor(s.overallScore);

  return (
    <div
      className="rounded-xl p-3 transition-all duration-300"
      style={{
        ...glassPanel,
        animationDelay: `${index * 60}ms`,
        borderLeft: `2px solid ${overallColor}`,
      }}
    >
      {/* 顶行：编号 + 标题 + 综合分 */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
              {s.defectNo}
            </span>
            <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {s.defectTitle}
            </span>
          </div>
        </div>
        {/* 综合分圆环 */}
        <div
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold"
          style={{
            background: `${overallColor}18`,
            border: `1.5px solid ${overallColor}50`,
            color: overallColor,
          }}
        >
          {s.overallScore}
        </div>
      </div>

      {/* 分数条 */}
      <div className="flex items-center gap-3 mt-2.5">
        <ScoreBar label="严重度" value={s.severityScore} />
        <ScoreBar label="难度" value={s.difficultyScore} />
        <ScoreBar label="影响" value={s.impactScore} />
      </div>

      {/* 理由 */}
      {s.reason && (
        <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {s.reason}
        </p>
      )}
    </div>
  );
}

/** 分数条形指示器 */
function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = scoreColor(value);
  const pct = Math.max(value * 10, 5);

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span className="text-[10px] font-medium tabular-nums" style={{ color }}>{value}</span>
      </div>
      <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function scoreColor(value: number): string {
  if (value >= 8) return 'rgba(248,113,113,0.9)';
  if (value >= 5) return 'rgba(251,191,36,0.9)';
  return 'rgba(52,211,153,0.9)';
}
