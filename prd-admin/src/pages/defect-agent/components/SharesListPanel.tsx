import { useState, useEffect, useCallback, useMemo } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Copy, Eye, Trash2, FileText, BarChart3, Image as ImageIcon, FileDown, FileImage, Search, X, ChevronRight, ChevronDown } from 'lucide-react';
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
import type { DefectShareLink, DefectAiScoreItem, DefectReport, DefectAttachment } from '@/services/contracts/defectAgent';

type ImageMode = 'base64' | 'url' | 'description';

interface SharesListPanelProps {
  open: boolean;
  onClose: () => void;
  /** 自动打开某个 share 的报告 (从通知跳转) */
  autoOpenShareId?: string;
  /** 当前列表页可见的缺陷 ID 列表 */
  visibleDefectIds?: string[];
}

export function SharesListPanel({ open, onClose, autoOpenShareId, visibleDefectIds }: SharesListPanelProps) {
  const allDefects = useDefectStore((s) => s.defects);

  // 历史分享记录
  const [shares, setShares] = useState<DefectShareLink[]>([]);
  const [loadingShares, setLoadingShares] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [reportShareId, setReportShareId] = useState<string | null>(null);
  const [reportShareTitle, setReportShareTitle] = useState<string | undefined>(undefined);

  // 选择 + 复制状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [copyLoading, setCopyLoading] = useState<ImageMode | null>(null);

  // AI 评分查看（保留兼容旧记录）
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
    setLoadingShares(true);
    try {
      const res = await listDefectShares();
      if (res.success && res.data) setShares(res.data.items);
    } catch { /* ignore */ }
    setLoadingShares(false);
  }, []);

  useEffect(() => {
    if (open) loadShares();
  }, [open, loadShares]);

  // 打开时默认勾选所有可见缺陷
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(visibleDefectIds ?? []));
      setSearchQuery('');
    }
  }, [open, visibleDefectIds]);

  useEffect(() => {
    if (autoOpenShareId && shares.length > 0) {
      const share = shares.find((s) => s.id === autoOpenShareId);
      if (share) {
        setReportShareId(share.id);
        setReportShareTitle(share.title ?? undefined);
      }
    }
  }, [autoOpenShareId, shares]);

  // 弹窗内可选缺陷：基于 visibleDefectIds + 搜索过滤
  const visibleSet = useMemo(() => new Set(visibleDefectIds ?? []), [visibleDefectIds]);
  const dialogDefects = useMemo(() => {
    let list = allDefects;
    if (visibleSet.size > 0) list = list.filter((d) => visibleSet.has(d.id));
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((d) =>
        d.defectNo?.toLowerCase().includes(q) ||
        d.title?.toLowerCase().includes(q) ||
        d.rawContent?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [allDefects, visibleSet, searchQuery]);

  const allSelectedInView = dialogDefects.length > 0 && dialogDefects.every((d) => selectedIds.has(d.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelectedInView) {
      // 反选当前视图内的所有
      setSelectedIds((prev) => {
        const next = new Set(prev);
        dialogDefects.forEach((d) => next.delete(d.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        dialogDefects.forEach((d) => next.add(d.id));
        return next;
      });
    }
  };

  const handleCopy = async (mode: ImageMode) => {
    const selected = allDefects.filter((d) => selectedIds.has(d.id));
    if (selected.length === 0) {
      toast.error('请先选择缺陷');
      return;
    }
    setCopyLoading(mode);
    try {
      // 1. 并行获取所有缺陷的评论
      const messagesMap = new Map<string, string[]>();
      await Promise.allSettled(
        selected.map(async (d) => {
          const res = await getDefectMessages({ id: d.id });
          if (res.success && res.data) {
            const humanMsgs = res.data.messages
              .filter((m) => m.source === 'human' || m.role === 'user')
              .map((m) => m.content);
            if (humanMsgs.length > 0) messagesMap.set(d.id, humanMsgs);
          }
        })
      );

      // 2. base64 模式：通过后端代理并行抓取所有图片（解决跨域 CORS）
      const imageDataMap = new Map<string, string>();
      let base64FailCount = 0;
      if (mode === 'base64') {
        const tasks: Promise<void>[] = [];
        selected.forEach((d) => {
          (d.attachments ?? []).forEach((a) => {
            if (a.mimeType?.startsWith('image/') && a.url) {
              tasks.push(
                fetchAttachmentAsBase64(d.id, a.id)
                  .then((data) => {
                    if (data) imageDataMap.set(a.id, data);
                    else base64FailCount++;
                  })
                  .catch(() => { base64FailCount++; })
              );
            }
          });
        });
        await Promise.allSettled(tasks);
      }

      // 3. 组装文本（含 AI 工作流提示词）
      const username = useAuthStore.getState().user?.username ?? 'admin';
      const baseUrl = window.location.origin;
      const text = buildClipboardText(selected, messagesMap, mode, imageDataMap, { username, baseUrl });
      await navigator.clipboard.writeText(text);

      const modeLabel = mode === 'base64' ? '原图' : mode === 'url' ? '图片地址' : '图片描述';
      if (mode === 'base64' && base64FailCount > 0) {
        toast.warning(`已复制 ${selected.length} 个缺陷（${modeLabel}），${base64FailCount} 张图片加载失败`);
      } else {
        toast.success(`已复制 ${selected.length} 个缺陷（${modeLabel}）`);
      }
    } catch {
      toast.error('复制失败');
    } finally {
      setCopyLoading(null);
    }
  };

  // ============ 历史分享相关 ============
  const handleRevoke = async (share: DefectShareLink) => {
    const confirmed = await systemDialog.confirm('确定要撤销此分享链接吗？撤销后外部 Agent 将无法访问。');
    if (!confirmed) return;
    try {
      const res = await revokeDefectShare({ id: share.id });
      if (res.success) { toast.success('已撤销'); loadShares(); }
      else toast.error(res.error?.message || '撤销失败');
    } catch { toast.error('撤销失败'); }
  };

  const handleCopySharePrompt = (share: DefectShareLink) => {
    const baseUrl = window.location.origin;
    const viewUrl = `${baseUrl}/api/defect-agent/share/view/${share.token}`;
    const { user, token } = useAuthStore.getState();
    const username = user?.username ?? 'admin';
    const prompt = [
      `## 缺陷修复任务`, ``,
      `我有 ${share.defectIds?.length || '若干'} 个缺陷需要分析和修复。`, ``,
      `### 认证`, ``,
      `\`\`\``, `X-AI-Access-Key: $AI_ACCESS_KEY`, `X-AI-Impersonate: ${username}`, `\`\`\``, ``,
      `或：\`Authorization: Bearer ${token}\``, ``,
      `### 获取数据`, ``,
      `\`\`\``, `GET ${viewUrl}`, `\`\`\``, ``,
      `请先获取数据，列出修复计划。`,
    ].join('\n');
    navigator.clipboard.writeText(prompt).catch(() => {});
    toast.success('已复制 AI 提示词到剪贴板');
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

  const selectedCount = selectedIds.size;
  const hasSelection = selectedCount > 0;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => !v && onClose()}
        title="分享缺陷"
        maxWidth={680}
        content={
          <div className="mt-2 flex flex-col" style={{ maxHeight: '70vh' }}>
            {/* 搜索 + 全选 */}
            <div className="space-y-2 mb-2 flex-shrink-0">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索编号、标题或内容..."
                  className="w-full h-8 pl-8 pr-8 rounded-lg text-[12px] outline-none"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'var(--text-primary)',
                  }}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 hover:opacity-80"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between text-xs">
                <label className="flex items-center gap-2 cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={allSelectedInView}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5"
                  />
                  <span>{allSelectedInView ? '取消全选' : '全选'}</span>
                </label>
                <span style={{ color: 'var(--text-muted)' }}>
                  已选 <span style={{ color: 'var(--text-primary)' }}>{selectedCount}</span> / {dialogDefects.length}
                </span>
              </div>
            </div>

            {/* 缺陷列表 */}
            <div className="flex-1 overflow-y-auto pr-1 space-y-1 min-h-[200px]">
              {dialogDefects.length === 0 && (
                <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>
                  {searchQuery ? '没有匹配的缺陷' : '暂无可选缺陷'}
                </p>
              )}
              {dialogDefects.map((d) => {
                const selected = selectedIds.has(d.id);
                const imgCount = (d.attachments ?? []).filter((a) => a.mimeType?.startsWith('image/')).length;
                return (
                  <label
                    key={d.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors"
                    style={{
                      background: selected ? 'rgba(120,180,255,0.08)' : 'transparent',
                    }}
                    onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                    onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleSelect(d.id)}
                      className="h-3.5 w-3.5 flex-shrink-0"
                    />
                    <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {d.defectNo}
                    </span>
                    <span className="text-xs truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                      {d.title || '无标题'}
                    </span>
                    {imgCount > 0 && (
                      <span className="text-[10px] flex items-center gap-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        <ImageIcon size={10} /> {imgCount}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            {/* 三个复制按钮 */}
            <div className="flex-shrink-0 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleCopy('base64')}
                  disabled={!hasSelection || copyLoading !== null}
                  title="将图片以 base64 内嵌，适合粘贴到 Claude/ChatGPT 等支持图片的对话"
                >
                  {copyLoading === 'base64' ? <MapSpinner size={12} /> : <FileImage size={12} />}
                  含原图
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleCopy('url')}
                  disabled={!hasSelection || copyLoading !== null}
                  title="使用图片 URL，适合 IM/邮件等"
                >
                  {copyLoading === 'url' ? <MapSpinner size={12} /> : <ImageIcon size={12} />}
                  含图链
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleCopy('description')}
                  disabled={!hasSelection || copyLoading !== null}
                  title="使用 AI 视觉分析的文字描述，适合纯文本环境"
                >
                  {copyLoading === 'description' ? <MapSpinner size={12} /> : <FileDown size={12} />}
                  含图述
                </Button>
              </div>
              <p className="text-[10px] mt-1.5 text-center" style={{ color: 'var(--text-muted)' }}>
                图片在文本中以 图1、图2 等代称引用
              </p>
            </div>

            {/* 历史分享记录（折叠） */}
            {(loadingShares || shares.length > 0) && (
              <div className="flex-shrink-0 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-1 text-xs hover:opacity-80"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {showHistory ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  历史分享链接 {shares.length > 0 ? `(${shares.length})` : ''}
                </button>
                {showHistory && (
                  <div className="mt-2 space-y-2 max-h-[180px] overflow-y-auto pr-1">
                    {loadingShares && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>加载中...</p>}
                    {!loadingShares && shares.length === 0 && (
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无历史分享</p>
                    )}
                    {shares.map((share) => {
                      const isExpired = share.isExpired || new Date(share.expiresAt) < new Date();
                      const dimmed = isExpired || share.isRevoked;
                      const scoreText = aiScoreLabel(share);
                      return (
                        <div
                          key={share.id}
                          className="rounded-lg p-2 flex items-center gap-2"
                          style={{ ...glassPanel, opacity: dimmed ? 0.5 : 1 }}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                              {share.title || '未命名分享'}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{scopeLabel(share)}</span>
                              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {new Date(share.createdAt).toLocaleDateString()}
                              </span>
                              <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'var(--text-muted)' }}>
                                <Eye size={9} /> {share.viewCount}
                              </span>
                              {(share.reportCount ?? 0) > 0 && (
                                <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'rgba(120,220,180,0.9)' }}>
                                  <FileText size={9} /> {share.reportCount}
                                </span>
                              )}
                              {scoreText && (
                                <span className="text-[10px] flex items-center gap-0.5" style={{ color: 'rgba(120,180,255,0.9)' }}>
                                  <BarChart3 size={9} /> {scoreText}
                                </span>
                              )}
                              {isExpired && <span className="text-[10px]" style={{ color: 'rgba(255,100,100,0.8)' }}>已过期</span>}
                              {share.isRevoked && <span className="text-[10px]" style={{ color: 'rgba(255,100,100,0.8)' }}>已撤销</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            {share.aiScoreStatus === 'completed' && (
                              <Button variant="ghost" size="xs" onClick={() => handleViewScores(share)} title="查看评分">
                                <BarChart3 size={11} />
                              </Button>
                            )}
                            {(share.reportCount ?? 0) > 0 && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => { setReportShareId(share.id); setReportShareTitle(share.title ?? undefined); }}
                                title="查看报告"
                              >
                                <FileText size={11} />
                              </Button>
                            )}
                            {!dimmed && (
                              <>
                                <Button variant="ghost" size="xs" onClick={() => handleCopySharePrompt(share)} title="复制 AI 提示词">
                                  <Copy size={11} />
                                </Button>
                                <Button variant="ghost" size="xs" onClick={() => handleRevoke(share)} className="text-red-400" title="撤销">
                                  <Trash2 size={11} />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
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

/** 通过后端代理抓取附件并转 base64 data url（解决 CORS） */
async function fetchAttachmentAsBase64(defectId: string, attachmentId: string): Promise<string | null> {
  try {
    const token = useAuthStore.getState().token;
    if (!token) return null;
    const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? '';
    const url = `${baseUrl}/api/defect-agent/defects/${encodeURIComponent(defectId)}/attachments/${encodeURIComponent(attachmentId)}/proxy`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** 组装剪贴板文本 */
function buildClipboardText(
  defects: DefectReport[],
  messagesMap: Map<string, string[]>,
  mode: ImageMode,
  imageDataMap: Map<string, string>,
  context: { username: string; baseUrl: string },
): string {
  const { username, baseUrl } = context;
  const lines: string[] = [
    `# 缺陷修复任务`,
    ``,
    `我有 ${defects.length} 个软件缺陷需要你帮忙分析和修复。所有数据已附在下方，无需调用 API 获取。`,
    ``,
    `---`,
    ``,
    `## 工作流程（必须按顺序执行）`,
    ``,
    `### 阶段 1：分析缺陷`,
    ``,
    `仔细阅读每个缺陷的截图描述、日志和用户描述。**分析优先级**：截图（描述）> 日志 > 评论 > 用户描述。`,
    ``,
    `### 阶段 2：制定修复计划`,
    ``,
    `**在动手修改任何代码之前，必须先列出完整的修复清单**：`,
    `- 逐条列出每个缺陷的修复方案`,
    `- 标记安全修复（无副作用）和有争议/破坏性修改`,
    `- **有争议或破坏性的修改必须先和人类确认**，不要自行决定`,
    ``,
    `### 阶段 3：发评论沟通进度（可选但推荐）`,
    ``,
    `修复过程中通过以下接口在缺陷对话中发表评论。评论会标记为 AI 来源并通知缺陷提交者：`,
    ``,
    '```http',
    `POST ${baseUrl}/api/defect-agent/defects/{defectId}/messages`,
    `Content-Type: application/json`,
    `X-AI-Access-Key: $AI_ACCESS_KEY`,
    `X-AI-Impersonate: ${username}`,
    ``,
    `{`,
    `  "content": "评论内容（支持 Markdown）",`,
    `  "agentName": "你的名称（如 Claude Code）"`,
    `}`,
    '```',
    ``,
    `**评论场景**：开始修复前发计划 / 遇到问题时说阻碍 / 修复完成后说明验收方式`,
    ``,
    `### 阶段 4：执行修复`,
    ``,
    `按计划修改代码。`,
    ``,
    `### 阶段 5：标记修复完成`,
    ``,
    `修复完成后，**先在评论中说明验收方式**，然后调用此接口标记为已解决：`,
    ``,
    '```http',
    `POST ${baseUrl}/api/defect-agent/defects/{defectId}/resolve`,
    `Content-Type: application/json`,
    `X-AI-Access-Key: $AI_ACCESS_KEY`,
    `X-AI-Impersonate: ${username}`,
    ``,
    `{`,
    `  "resolution": "修复说明（必须包含验收方式）"`,
    `}`,
    '```',
    ``,
    `---`,
    ``,
    `## 重要规则`,
    ``,
    `1. **先列清单再动手**：修复前必须列出所有缺陷的修复方案清单`,
    `2. **有争议的找人确认**：破坏性修改、架构变更、删除代码等操作必须先和人类确认`,
    `3. **全程发评论**：通过评论接口沟通进度，不要默默工作`,
    `4. **说明验收方式**：标记完成时必须告诉提交者如何验证修复效果`,
    ``,
    `> **认证说明**：\`AI_ACCESS_KEY\` 从环境变量读取（Header 名称区分大小写：\`X-AI-Access-Key\`）。\`X-AI-Impersonate\` 是要"代理操作"的用户名。`,
    ``,
    `---`,
    ``,
    `## 缺陷数据（共 ${defects.length} 个）`,
    '',
  ];

  for (const d of defects) {
    lines.push(`### ${d.defectNo}${d.title ? ` — ${d.title}` : ''}`);
    lines.push('');

    if (d.rawContent) {
      lines.push('**用户描述：**');
      lines.push(d.rawContent);
      lines.push('');
    }

    const msgs = messagesMap.get(d.id);
    if (msgs && msgs.length > 0) {
      lines.push('**评论：**');
      for (const m of msgs) lines.push(`- ${m}`);
      lines.push('');
    }

    // 截图（图1、图2）
    const screenshots = (d.attachments ?? []).filter(
      (a: DefectAttachment) => a.mimeType?.startsWith('image/'),
    );
    if (screenshots.length > 0) {
      lines.push(`**截图（共 ${screenshots.length} 张）：**`);
      lines.push('');
      screenshots.forEach((a, i) => {
        const label = `图${i + 1}`;
        switch (mode) {
          case 'base64': {
            const dataUrl = imageDataMap.get(a.id);
            if (dataUrl) {
              lines.push(`${label}：![${a.fileName}](${dataUrl})`);
            } else {
              lines.push(`${label}：[图片加载失败：${a.fileName}]`);
            }
            break;
          }
          case 'url':
            lines.push(`${label}：${a.url}`);
            break;
          case 'description':
            lines.push(`${label}：${a.description || '(无 AI 视觉分析描述)'}`);
            break;
        }
        lines.push('');
      });
    }

    // 日志附件
    const logs = (d.attachments ?? []).filter(
      (a: DefectAttachment) => a.type === 'log-request' || a.type === 'log-error',
    );
    if (logs.length > 0) {
      lines.push('**日志：**');
      for (const a of logs) {
        if (mode === 'url' && a.url) {
          lines.push(`- ${a.fileName}: ${a.url}`);
        } else if (a.description) {
          lines.push(`- ${a.fileName}: ${a.description}`);
        } else {
          lines.push(`- ${a.fileName}`);
        }
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
