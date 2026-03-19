import { useState, useEffect, useCallback, useRef } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Eye, Trash2, FileText, Zap, BarChart3, Loader2 } from 'lucide-react';
import { listDefectShares, revokeDefectShare, createBatchShare, getShareScores } from '@/services';
import { api } from '@/services/api';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
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
  const [scorePhase, setScorePhase] = useState('');
  const [scoreTyping, setScoreTyping] = useState('');
  const [scoreDone, setScoreDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listDefectShares();
      if (res.success && res.data) setShares(res.data.items);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

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

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

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
      `### 操作步骤`,
      ``,
      `1. **获取缺陷数据**：调用以下 API 获取缺陷详情（需要在 Header 中添加 \`Authorization: Bearer <your-access-key>\`）：`,
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
      `   Authorization: Bearer <your-access-key>`,
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
      `   Authorization: Bearer <your-access-key>`,
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
  const startScoringStream = useCallback(async (shareId: string) => {
    // 清理上一次
    abortRef.current?.abort();
    setScoreShareId(shareId);
    setScores([]);
    setScorePhase('连接中…');
    setScoreTyping('');
    setScoreDone(false);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(api.defectAgent.shares.scoresStream(shareId), {
        headers: {
          'Accept': 'text/event-stream',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        signal: ac.signal,
      });

      if (!res.ok) {
        toast.error('评分请求失败');
        setScoreShareId(null);
        return;
      }

      await readSseStream(res, (evt) => {
        if (!evt.data) return;
        try {
          const data = JSON.parse(evt.data);

          switch (evt.event) {
            case 'phase':
              setScorePhase(data.message || data.phase);
              break;
            case 'typing':
              setScoreTyping((prev) => prev + (data.text || ''));
              break;
            case 'score':
              setScores((prev) => [...prev, data as DefectAiScoreItem]);
              setScorePhase((prev) =>
                prev.startsWith('已评分') ? `已评分 ${prev.match(/\d+/)?.[0] ? Number(prev.match(/\d+/)![0]) + 1 : 1} 个` : '已评分 1 个'
              );
              break;
            case 'done':
              setScoreDone(true);
              setScorePhase(`评分完成，共 ${data.total} 个`);
              loadShares(); // 刷新列表
              break;
            case 'error':
              toast.error(data.message || 'AI 评分出错');
              setScorePhase('评分失败');
              setScoreDone(true);
              break;
          }
        } catch { /* ignore parse errors */ }
      }, ac.signal);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        toast.error('评分连接失败');
        setScoreShareId(null);
      }
    }
  }, [loadShares]);

  /** 一键分享所有缺陷 + 自动打开 SSE 评分 */
  const handleBatchShare = async () => {
    setBatchLoading(true);
    try {
      const res = await createBatchShare({ expiresInDays: 7 });
      if (res.success && res.data) {
        loadShares();
        // 自动打开评分面板并启动 SSE 流
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
    if (share.aiScoreStatus === 'completed') {
      // 已完成：直接获取
      setScoreShareId(share.id);
      setScores([]);
      setScorePhase('加载中…');
      setScoreDone(false);
      setScoreTyping('');
      try {
        const res = await getShareScores({ shareId: share.id });
        if (res.success && res.data) {
          setScores(res.data.scores);
          setScorePhase(`评分完成，共 ${res.data.scores.length} 个`);
          setScoreDone(true);
        }
      } catch {
        toast.error('获取评分失败');
        setScoreShareId(null);
      }
    } else {
      // 未完成或 none：启动 SSE 流
      startScoringStream(share.id);
    }
  };

  const closeScoring = () => {
    abortRef.current?.abort();
    setScoreShareId(null);
    setScores([]);
    setScorePhase('');
    setScoreTyping('');
    setScoreDone(false);
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
          maxWidth={760}
          content={
            <div className="mt-2 max-h-[65vh] overflow-y-auto">
              {/* 阶段状态栏 */}
              <div
                className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg"
                style={{
                  background: scoreDone ? 'rgba(120,220,180,0.08)' : 'rgba(120,180,255,0.08)',
                  border: `1px solid ${scoreDone ? 'rgba(120,220,180,0.2)' : 'rgba(120,180,255,0.2)'}`,
                }}
              >
                {!scoreDone && <Loader2 size={14} className="animate-spin" style={{ color: 'rgba(120,180,255,0.9)' }} />}
                <span className="text-xs font-medium" style={{ color: scoreDone ? 'rgba(120,220,180,0.9)' : 'rgba(120,180,255,0.9)' }}>
                  {scorePhase}
                </span>
                {scores.length > 0 && !scoreDone && (
                  <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
                    已完成 {scores.length} 个
                  </span>
                )}
              </div>

              {/* AI 思考过程（打字效果） */}
              {!scoreDone && scoreTyping && (
                <div
                  className="mb-3 px-3 py-2 rounded-lg text-xs font-mono overflow-x-auto"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    color: 'var(--text-muted)',
                    maxHeight: 80,
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {scoreTyping.slice(-300)}
                  <span className="animate-pulse">|</span>
                </div>
              )}

              {/* 评分表格 */}
              {scores.length > 0 ? (
                <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-secondary)' }}>
                      <th className="text-left py-2 px-2 text-xs font-medium">编号</th>
                      <th className="text-left py-2 px-2 text-xs font-medium">标题</th>
                      <th className="text-center py-2 px-1 text-xs font-medium">严重度</th>
                      <th className="text-center py-2 px-1 text-xs font-medium">难度</th>
                      <th className="text-center py-2 px-1 text-xs font-medium">影响</th>
                      <th className="text-center py-2 px-1 text-xs font-medium">综合</th>
                      <th className="text-left py-2 px-2 text-xs font-medium">理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scores.map((s, idx) => (
                      <tr
                        key={s.defectId}
                        className="border-t animate-in fade-in"
                        style={{
                          borderColor: 'rgba(255,255,255,0.06)',
                          animationDelay: `${idx * 50}ms`,
                        }}
                      >
                        <td className="py-2 px-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                          {s.defectNo}
                        </td>
                        <td className="py-2 px-2 text-xs max-w-[160px] truncate" style={{ color: 'var(--text-primary)' }}>
                          {s.defectTitle}
                        </td>
                        <td className="py-2 px-1 text-center">
                          <ScoreBadge value={s.severityScore} />
                        </td>
                        <td className="py-2 px-1 text-center">
                          <ScoreBadge value={s.difficultyScore} />
                        </td>
                        <td className="py-2 px-1 text-center">
                          <ScoreBadge value={s.impactScore} />
                        </td>
                        <td className="py-2 px-1 text-center">
                          <ScoreBadge value={s.overallScore} highlight />
                        </td>
                        <td className="py-2 px-2 text-xs max-w-[200px]" style={{ color: 'var(--text-secondary)' }}>
                          {s.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : !scoreDone ? (
                <div className="flex flex-col items-center gap-2 py-8" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 size={24} className="animate-spin" style={{ color: 'rgba(120,180,255,0.5)' }} />
                  <span className="text-xs">AI 正在分析缺陷数据…</span>
                </div>
              ) : (
                <p className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>暂无评分数据</p>
              )}
            </div>
          }
        />
      )}
    </>
  );
}

function ScoreBadge({ value, highlight }: { value: number; highlight?: boolean }) {
  const color =
    value >= 8 ? 'rgba(255,100,100,0.9)' :
    value >= 5 ? 'rgba(255,200,100,0.9)' :
    'rgba(120,220,180,0.9)';

  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded text-xs font-medium"
      style={{
        background: highlight ? `${color}20` : 'transparent',
        color,
        fontWeight: highlight ? 700 : 500,
      }}
    >
      {value}
    </span>
  );
}
