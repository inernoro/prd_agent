import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Eye, Trash2, FileText, BarChart3, Image, FileDown } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { listDefectShares, revokeDefectShare, getShareScores, getDefectMessages } from '@/services';
import { api } from '@/services/api';
import { useSseStream } from '@/lib/useSseStream';
import { SseStreamPanel } from '@/components/sse';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { glassPanel } from '@/lib/glassStyles';
import { DefectFixReportPanel } from './DefectFixReportPanel';
import { useDefectStore } from '@/stores/defectStore';
import { useAuthStore } from '@/stores/authStore';
import { DefectStatus, DefectAttachmentType } from '@/services/contracts/defectAgent';
import type { DefectShareLink, DefectAiScoreItem, DefectReport, DefectAttachment } from '@/services/contracts/defectAgent';

interface SharesListPanelProps {
  open: boolean;
  onClose: () => void;
  /** 自动打开某个 share 的报告 (从通知跳转) */
  autoOpenShareId?: string;
  /** 当前列表页可见的缺陷 ID 列表 */
  visibleDefectIds?: string[];
}

export function SharesListPanel({ open, onClose, autoOpenShareId, visibleDefectIds }: SharesListPanelProps) {
  const [shares, setShares] = useState<DefectShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportShareId, setReportShareId] = useState<string | null>(null);
  const [reportShareTitle, setReportShareTitle] = useState<string | undefined>(undefined);
  const [copyLoading, setCopyLoading] = useState(false);

  // AI 评分流式状态（仅用于查看已有评分）
  const [scoreShareId, setScoreShareId] = useState<string | null>(null);
  const [scores, setScores] = useState<DefectAiScoreItem[]>([]);

  const sse = useSseStream<DefectAiScoreItem>({
    url: scoreShareId ? api.defectAgent.shares.scoresStream(scoreShareId) : '',
    itemEvent: 'score',
    onItem: (item) => setScores((prev) => [...prev, item]),
    onDone: () => loadShares(),
    onError: (msg) => toast.error(msg),
  });

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
      if (res.success) { toast.success('已撤销'); loadShares(); }
      else toast.error(res.error?.message || '撤销失败');
    } catch { toast.error('撤销失败'); }
  };

  /** 复制单个分享的 AI 提示词（保留原有能力） */
  const handleCopySharePrompt = (share: DefectShareLink) => {
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
      `**方式 A — AI Access Key**（推荐，不会过期）：`,
      `\`\`\``,
      `X-AI-Access-Key: $AI_ACCESS_KEY`,
      `X-AI-Impersonate: ${username}`,
      `\`\`\``,
      ``,
      `**方式 B — Bearer Token**（可能过期）：`,
      `\`\`\``,
      `Authorization: Bearer ${token}`,
      `\`\`\``,
      ``,
      `---`,
      ``,
      `### 获取缺陷数据`,
      ``,
      `\`\`\``,
      `GET ${viewUrl}`,
      `\`\`\``,
      ``,
      `请先获取数据，然后列出修复计划。`,
    ].join('\n');

    navigator.clipboard.writeText(prompt).catch(() => {});
    toast.success('已复制 AI 提示词到剪贴板');
  };

  /** 批量复制缺陷数据到剪贴板 */
  const handleCopyDefects = async (includeImageUrls: boolean) => {
    const defects = useDefectStore.getState().defects;
    const userId = useAuthStore.getState().user?.userId;
    const filter = useDefectStore.getState().filter;

    // 与 DefectList 一致的客户端过滤
    const archivedStatuses = [DefectStatus.Closed, DefectStatus.Rejected];
    let filtered = defects;
    if (userId && filter === 'submitted') filtered = defects.filter((d) => d.reporterId === userId);
    else if (userId && filter === 'assigned') filtered = defects.filter((d) => d.assigneeId === userId);
    filtered = filtered.filter((d) => !archivedStatuses.includes(d.status as typeof DefectStatus.Closed));

    // 如果有 visibleDefectIds，优先使用
    if (visibleDefectIds?.length) {
      const idSet = new Set(visibleDefectIds);
      filtered = filtered.filter((d) => idSet.has(d.id));
    }

    if (filtered.length === 0) {
      toast.error('没有可复制的缺陷');
      return;
    }

    setCopyLoading(true);

    try {
      // 并行获取所有缺陷的评论
      const messagesMap = new Map<string, string[]>();
      const results = await Promise.allSettled(
        filtered.map(async (d) => {
          const res = await getDefectMessages({ id: d.id });
          if (res.success && res.data) {
            const humanMsgs = res.data.messages
              .filter((m) => m.source === 'human' || m.role === 'user')
              .map((m) => m.content);
            if (humanMsgs.length > 0) messagesMap.set(d.id, humanMsgs);
          }
        })
      );

      // 忽略失败的请求，继续组装
      const failCount = results.filter((r) => r.status === 'rejected').length;
      if (failCount > 0) console.warn(`${failCount} 个缺陷的评论获取失败`);

      const text = buildClipboardText(filtered, messagesMap, includeImageUrls);
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${filtered.length} 个缺陷${includeImageUrls ? '（含图片链接）' : '（纯文本）'}`);
    } catch {
      toast.error('复制失败');
    } finally {
      setCopyLoading(false);
    }
  };

  const handleViewScores = async (share: DefectShareLink) => {
    setScoreShareId(share.id);
    setScores([]);
    if (share.aiScoreStatus === 'completed') {
      try {
        const res = await getShareScores({ shareId: share.id });
        if (res.success && res.data) setScores(res.data.scores);
      } catch {
        toast.error('获取评分失败');
        setScoreShareId(null);
      }
    } else {
      sse.start({ url: api.defectAgent.shares.scoresStream(share.id) });
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

  const defectCount = visibleDefectIds?.length ?? 0;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => !v && onClose()}
        title="分享管理"
        maxWidth={640}
        content={
          <div className="mt-2 space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {/* 复制缺陷数据按钮 */}
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleCopyDefects(true)}
                disabled={copyLoading || defectCount === 0}
                className="flex-1"
              >
                {copyLoading ? <MapSpinner size={14} /> : <Image size={14} />}
                复制缺陷数据（含图片链接）{defectCount > 0 ? ` · ${defectCount}` : ''}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCopyDefects(false)}
                disabled={copyLoading || defectCount === 0}
                className="flex-1"
              >
                {copyLoading ? <MapSpinner size={14} /> : <FileDown size={14} />}
                复制缺陷数据（纯文本）{defectCount > 0 ? ` · ${defectCount}` : ''}
              </Button>
            </div>

            {/* 已有分享记录 */}
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
                    {share.aiScoreStatus === 'completed' && (
                      <Button variant="secondary" size="xs" onClick={() => handleViewScores(share)}>
                        评分
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
                        <Button variant="ghost" size="xs" onClick={() => handleCopySharePrompt(share)} title="复制 AI 提示词">
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

      {/* AI 评分面板（查看已有评分） */}
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

/** 组装剪贴板文本 */
function buildClipboardText(
  defects: DefectReport[],
  messagesMap: Map<string, string[]>,
  includeImageUrls: boolean,
): string {
  const lines: string[] = [
    `## 缺陷清单（共 ${defects.length} 个）`,
    '',
  ];

  for (const d of defects) {
    lines.push(`### ${d.defectNo}${d.title ? ` — ${d.title}` : ''}`);
    lines.push('');

    // 用户原话
    if (d.rawContent) {
      lines.push('**用户描述：**');
      lines.push(d.rawContent);
      lines.push('');
    }

    // 截图 VLM 描述
    const screenshots = (d.attachments ?? []).filter(
      (a: DefectAttachment) => a.type === DefectAttachmentType.Screenshot || a.mimeType?.startsWith('image/'),
    );
    const withDesc = screenshots.filter((a: DefectAttachment) => a.description);
    if (withDesc.length > 0) {
      lines.push('**截图分析：**');
      for (const a of withDesc) {
        if (includeImageUrls && a.url) {
          lines.push(`- ![${a.fileName}](${a.url})`);
        }
        lines.push(`- ${a.description}`);
      }
      lines.push('');
    } else if (includeImageUrls && screenshots.length > 0) {
      lines.push('**截图：**');
      for (const a of screenshots) {
        lines.push(`- ![${a.fileName}](${a.url})`);
      }
      lines.push('');
    }

    // 日志附件
    const logs = (d.attachments ?? []).filter(
      (a: DefectAttachment) => a.type === DefectAttachmentType.LogRequest || a.type === DefectAttachmentType.LogError,
    );
    if (logs.length > 0) {
      lines.push('**日志：**');
      for (const a of logs) {
        if (includeImageUrls && a.url) {
          lines.push(`- [${a.fileName}](${a.url})${a.description ? ` — ${a.description}` : ''}`);
        } else if (a.description) {
          lines.push(`- ${a.fileName}: ${a.description}`);
        }
      }
      lines.push('');
    }

    // 评论
    const msgs = messagesMap.get(d.id);
    if (msgs && msgs.length > 0) {
      lines.push('**评论：**');
      for (const m of msgs) {
        lines.push(`- ${m}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** 评分表格（查看已有评分用） */
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
          {scores.map((s, i) => (
            <ScoreRow
              key={s.defectId}
              score={s}
              rank={i + 1}
              isExpanded={expandedId === s.defectId}
              onToggle={() => setExpandedId(expandedId === s.defectId ? null : s.defectId)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
        <td className="px-3 py-2.5 font-mono text-xs tabular-nums" style={{ color: 'var(--text-muted)', borderBottom: `1px solid ${rowBorder}` }}>{rank}</td>
        <td className="px-3 py-2.5" style={{ borderBottom: `1px solid ${rowBorder}` }}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{s.defectNo}</span>
            <span className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{s.defectTitle}</span>
          </div>
        </td>
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}><ScoreBadge value={s.severityScore} /></td>
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}><ScoreBadge value={s.difficultyScore} /></td>
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}><ScoreBadge value={s.impactScore} /></td>
        <td className="px-2 py-2.5 text-center" style={{ borderBottom: `1px solid ${rowBorder}` }}><ScoreBadge value={s.overallScore} bold /></td>
      </tr>
      {isExpanded && s.reason && (
        <tr>
          <td colSpan={6} className="px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: `1px solid ${rowBorder}` }}>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{s.reason}</p>
          </td>
        </tr>
      )}
    </>
  );
}

function ScoreBadge({ value, bold }: { value: number; bold?: boolean }) {
  const color = value >= 8 ? 'rgba(248,113,113,0.9)' : value >= 5 ? 'rgba(251,191,36,0.9)' : 'rgba(52,211,153,0.9)';
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
