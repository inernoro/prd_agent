import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Eye, Trash2, FileText, Zap, BarChart3 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { listDefectShares, revokeDefectShare, createBatchShare, getShareScores } from '@/services';
import { api } from '@/services/api';
import { useSseStream } from '@/lib/useSseStream';
import { SseStreamPanel } from '@/components/sse';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
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
    const { user, token } = useAuthStore.getState();
    const username = user?.username ?? 'admin';

    const prompt = [
      `## 缺陷修复任务`,
      ``,
      `我有 ${share.defectIds?.length || '若干'} 个软件缺陷需要你帮忙分析和修复。`,
      ``,
      `### 认证信息（二选一）`,
      ``,
      `所有 API 请求都需要认证，请选择以下任一方式：`,
      ``,
      `**方式 A — AI Access Key**（推荐，不会过期）：`,
      `\`\`\``,
      `X-AI-Access-Key: $AI_ACCESS_KEY`,
      `X-AI-Impersonate: ${username}`,
      `\`\`\``,
      `> 其中 \`AI_ACCESS_KEY\` 从环境变量读取。Header 名称是 \`X-AI-Access-Key\`（注意大小写和连字符）。`,
      ``,
      `**方式 B — Bearer Token**（当前用户令牌，可能会过期）：`,
      `\`\`\``,
      `Authorization: Bearer ${token}`,
      `\`\`\``,
      ``,
      `---`,
      ``,
      `### 工作流程（必须按顺序执行）`,
      ``,
      `#### 阶段 1：获取缺陷数据`,
      ``,
      `\`\`\``,
      `GET ${viewUrl}`,
      `\`\`\``,
      ``,
      `响应中每个缺陷包含以下数据（按分析优先级排列）：`,
      `- **screenshots**：截图数组，每项有 \`url\`（图片链接）和 \`description\`（AI Vision 解析描述）。**描述是最重要的信息来源**，请仔细阅读`,
      `- **logs**：请求日志 / 错误日志数组，包含精确的错误信息和调用堆栈`,
      `- **messages**：缺陷对话历史，可能有补充说明`,
      `- **rawContent / structuredData**：用户文字描述，作为辅助参考`,
      `- **aiScores**：AI 评分（严重度/难度/影响）`,
      ``,
      `#### 阶段 2：制定修复计划`,
      ``,
      `**在动手修改任何代码之前，必须先列出完整的修复清单**：`,
      `- 仔细阅读每个缺陷的截图描述和日志信息`,
      `- 逐条列出每个缺陷的修复方案`,
      `- 标记哪些修复是安全的（无副作用），哪些可能有破坏性或有争议`,
      `- **有争议或破坏性的修改必须先和人类确认**，不要自行决定`,
      ``,
      `#### 阶段 3：发表评论（修复过程中）`,
      ``,
      `在修复过程中，请通过评论接口和缺陷提交者保持沟通：`,
      ``,
      `\`\`\``,
      `POST ${viewUrl}/comments`,
      `Content-Type: application/json`,
      ``,
      `{`,
      `  "agentName": "你的名称",`,
      `  "items": [`,
      `    {`,
      `      "defectId": "缺陷ID",`,
      `      "content": "评论内容（支持 Markdown）"`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
      ``,
      `评论场景：`,
      `- 开始修复前：发表修复计划`,
      `- 遇到问题时：说明阻碍和需要人类确认的事项`,
      `- 修复完成后：**说明验收方式**（如何验证修复是否生效、测试步骤）`,
      ``,
      `#### 阶段 4：提交分析报告（可选）`,
      ``,
      `\`\`\``,
      `POST ${viewUrl}/report`,
      `Content-Type: application/json`,
      ``,
      `{`,
      `  "agentName": "你的名称",`,
      `  "items": [`,
      `    {`,
      `      "defectId": "...",`,
      `      "confidenceScore": 85,`,
      `      "analysis": "根因分析",`,
      `      "fixSuggestion": "修复方案"`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
      ``,
      `#### 阶段 5：执行修复`,
      ``,
      `根据计划修改代码。`,
      ``,
      `#### 阶段 6：标记修复完成`,
      ``,
      `修复完成后，**先在评论中说明验收方式**，然后调用此接口：`,
      ``,
      `\`\`\``,
      `POST ${viewUrl}/fix-status`,
      `Content-Type: application/json`,
      ``,
      `{`,
      `  "items": [`,
      `    {`,
      `      "defectId": "...",`,
      `      "agentName": "你的名称",`,
      `      "resolution": "修复说明（含验收方式）"`,
      `    }`,
      `  ]`,
      `}`,
      `\`\`\``,
      ``,
      `> 此接口会自动将缺陷标记为「AI 自动解决」并通知缺陷提交者。`,
      ``,
      `---`,
      ``,
      `### 重要规则`,
      ``,
      `1. **先列清单再动手**：修复前必须列出所有缺陷的修复方案清单`,
      `2. **有争议的找人确认**：破坏性修改、架构变更、删除代码等操作必须先和人类确认`,
      `3. **全程发评论**：通过评论接口沟通进度，不要默默工作`,
      `4. **说明验收方式**：标记完成时必须告诉提交者如何验证修复效果`,
      ``,
      `请先调用阶段 1 的 API 获取缺陷数据，然后列出你的修复计划。`,
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
              {batchLoading ? <MapSpinner size={14} /> : <Zap size={14} />}
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

      {/* AI 评分实时面板 — 表格布局 */}
      {scoreShareId && (
        <Dialog
          open={!!scoreShareId}
          onOpenChange={(v) => { if (!v) closeScoring(); }}
          title="AI 缺陷评分"
          maxWidth={900}
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
                <ScoreTable scores={scores} />
              </SseStreamPanel>
            </div>
          }
        />
      )}
    </>
  );
}

/** 评分表格 */
function ScoreTable({ scores }: { scores: DefectAiScoreItem[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (scores.length === 0) return null;

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
      <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
            <th className="text-left text-[11px] font-medium px-3 py-2.5" style={{ color: 'var(--text-muted)', width: 48 }}>#</th>
            <th className="text-left text-[11px] font-medium px-3 py-2.5" style={{ color: 'var(--text-muted)' }}>缺陷</th>
            <th className="text-center text-[11px] font-medium px-2 py-2.5" style={{ color: 'var(--text-muted)', width: 64 }}>严重度</th>
            <th className="text-center text-[11px] font-medium px-2 py-2.5" style={{ color: 'var(--text-muted)', width: 56 }}>难度</th>
            <th className="text-center text-[11px] font-medium px-2 py-2.5" style={{ color: 'var(--text-muted)', width: 56 }}>影响</th>
            <th className="text-center text-[11px] font-medium px-2 py-2.5" style={{ color: 'var(--text-muted)', width: 56 }}>综合</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => {
            const isExpanded = expandedId === s.defectId;
            return (
              <ScoreRow
                key={s.defectId}
                score={s}
                rank={i + 1}
                isExpanded={isExpanded}
                onToggle={() => setExpandedId(isExpanded ? null : s.defectId)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 单行评分 */
function ScoreRow({ score: s, rank, isExpanded, onToggle }: {
  score: DefectAiScoreItem;
  rank: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const rowBorder = 'rgba(255,255,255,0.04)';
  const hoverBg = 'rgba(255,255,255,0.02)';

  return (
    <>
      <tr
        className="group cursor-pointer transition-colors"
        style={{ borderBottom: `1px solid ${rowBorder}` }}
        onClick={onToggle}
        onMouseEnter={(e) => { e.currentTarget.style.background = hoverBg; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
      >
        {/* 排名 */}
        <td className="px-3 py-2.5 font-mono text-xs tabular-nums" style={{ color: 'var(--text-muted)', borderBottom: `1px solid ${rowBorder}` }}>
          {rank}
        </td>
        {/* 编号 + 标题 */}
        <td className="px-3 py-2.5" style={{ borderBottom: `1px solid ${rowBorder}` }}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
              {s.defectNo}
            </span>
            <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
              {s.defectTitle}
            </span>
          </div>
        </td>
        {/* 严重度 */}
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}>
          <ScoreBadge value={s.severityScore} />
        </td>
        {/* 难度 */}
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}>
          <ScoreBadge value={s.difficultyScore} />
        </td>
        {/* 影响 */}
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}>
          <ScoreBadge value={s.impactScore} />
        </td>
        {/* 综合分 */}
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}>
          <ScoreBadge value={s.overallScore} bold />
        </td>
      </tr>
      {/* 展开行：理由 */}
      {isExpanded && s.reason && (
        <tr>
          <td colSpan={6} className="px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: `1px solid ${rowBorder}` }}>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {s.reason}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/** 分数徽章 — 带背景色的数字 */
function ScoreBadge({ value, bold }: { value: number; bold?: boolean }) {
  const color = scoreColor(value);
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md tabular-nums text-xs ${bold ? 'font-semibold min-w-[32px] h-[26px]' : 'min-w-[28px] h-[22px]'}`}
      style={{
        background: `${color}18`,
        color,
        ...(bold ? { border: `1px solid ${color}40` } : {}),
      }}
    >
      {value}
    </span>
  );
}

function scoreColor(value: number): string {
  if (value >= 8) return 'rgba(248,113,113,0.9)';
  if (value >= 5) return 'rgba(251,191,36,0.9)';
  return 'rgba(52,211,153,0.9)';
}
