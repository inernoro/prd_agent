import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Clock3, Eye, History, RefreshCw, RotateCcw, Send, WandSparkles, X } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getDocumentContent, listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  createHostedSiteEditRun,
  listHostedSiteRevisions,
  previewHostedSiteRevision,
  publishHostedSiteRevision,
  rollbackHostedSiteRevision,
  streamHostedSiteEditRun,
  type HostedSite,
  type HostedSiteRevision,
} from '@/services/real/webPages';
import { SRCDOC_PREVIEW_SANDBOX } from './previewHtml';
import { previewableEditHtml, revisionLabel } from './siteEditPreview';

interface Props {
  site: HostedSite;
  onPublished: (site: HostedSite) => void;
}

interface PhaseEvent {
  progress?: number;
  message?: string;
}

function formatRevisionTime(value?: string | null) {
  if (!value) return '尚未发布';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}

export default function SiteEditPanel({ site, onPublished }: Props) {
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState('告诉我你想改什么，系统会先生成草稿，不会直接覆盖线上页面。');
  const [progress, setProgress] = useState(0);
  const [thinking, setThinking] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [draftRevisionId, setDraftRevisionId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<HostedSiteRevision[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(true);
  const streamRef = useRef('');
  const lastPaintAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    const result = await listHostedSiteRevisions(site.id);
    if (result.success) setRevisions(result.data);
    else toast.error('版本记录读取失败', result.error?.message || '请稍后重试');
    setLoadingHistory(false);
  }, [site.id]);

  useEffect(() => {
    void loadHistory();
    return () => abortRef.current?.abort();
  }, [loadHistory]);

  useEffect(() => {
    let active = true;
    void listRecentDocumentEntries(12).then((result) => {
      if (!active) return;
      if (result.success) setRecentKnowledge(result.data.items);
      setLoadingKnowledge(false);
    });
    return () => { active = false; };
  }, []);

  const toggleKnowledge = (entryId: string) => {
    setSelectedKnowledgeIds((current) => {
      if (current.includes(entryId)) return current.filter((id) => id !== entryId);
      if (current.length >= 3) {
        toast.info('首版一次最多引用 3 篇知识');
        return current;
      }
      return [...current, entryId];
    });
  };

  const openRevision = async (revisionId: string) => {
    const result = await previewHostedSiteRevision(site.id, revisionId);
    if (!result.success) {
      toast.error('版本预览失败', result.error?.message || '请稍后重试');
      return;
    }
    setPreviewHtml(result.data.html);
    setDraftRevisionId(result.data.revision.status === 'draft' ? revisionId : null);
    setPhase(revisionLabel(result.data.revision));
    setProgress(result.data.revision.status === 'draft' ? 95 : 100);
  };

  const generate = async () => {
    const text = instruction.trim();
    if (!text || generating) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setGenerating(true);
    setDraftRevisionId(null);
    setThinking('');
    setPreviewHtml('');
    setProgress(1);
    setPhase('正在创建修改任务');
    streamRef.current = '';

    const knowledgeResults = await Promise.all(selectedKnowledgeIds.map(async (entryId) => {
      const entry = recentKnowledge.find((item) => item.id === entryId);
      const result = await getDocumentContent(entryId);
      return { entry, result };
    }));
    const unreadable = knowledgeResults.find(({ result }) => !result.success || !result.data.hasContent);
    if (unreadable) {
      setGenerating(false);
      setPhase('引用知识读取失败，请取消该条知识后重试');
      toast.error('引用知识读取失败', unreadable.result.error?.message || '所选知识没有可读取的正文');
      return;
    }
    const knowledgeReferences = knowledgeResults.map(({ entry, result }) => ({
      entryId: result.data!.entryId,
      storeId: entry?.storeId,
      storeName: entry?.storeName,
      title: entry?.title || result.data!.title,
      content: (result.data!.content || '').slice(0, 20_000),
    }));
    const created = await createHostedSiteEditRun(site.id, text, knowledgeReferences);
    if (!created.success) {
      setGenerating(false);
      setPhase(created.error?.message || '修改任务创建失败');
      toast.error('无法开始修改', created.error?.message || '请稍后重试');
      return;
    }

    try {
      await streamHostedSiteEditRun({
        siteId: site.id,
        runId: created.data.runId,
        signal: abort.signal,
        onEvent: (event) => {
          if (!event.data) return;
          let data: Record<string, unknown>;
          try { data = JSON.parse(event.data) as Record<string, unknown>; }
          catch { return; }

          if (event.event === 'phase') {
            const item = data as PhaseEvent;
            if (typeof item.message === 'string') setPhase(item.message);
            if (typeof item.progress === 'number') setProgress(item.progress);
            return;
          }
          if (event.event === 'thinking' && typeof data.text === 'string') {
            setThinking((prev) => `${prev}${data.text}`.slice(-500));
            return;
          }
          if (event.event === 'delta' && typeof data.text === 'string') {
            streamRef.current += data.text;
            const now = Date.now();
            if (now - lastPaintAtRef.current >= 250) {
              const html = previewableEditHtml(streamRef.current);
              if (html) setPreviewHtml(html);
              lastPaintAtRef.current = now;
            }
            return;
          }
          if (event.event === 'done' && typeof data.revisionId === 'string') {
            setDraftRevisionId(data.revisionId);
            setProgress(100);
            setPhase('草稿已生成，请预览确认后再发布');
            void openRevision(data.revisionId);
            void loadHistory();
            return;
          }
          if (event.event === 'error') {
            const message = typeof data.message === 'string' ? data.message : '页面修改失败';
            setPhase(message);
            toast.error('页面修改失败', message);
          }
        },
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : '修改进度连接中断';
        setPhase(message);
        toast.error('修改进度中断', '刷新版本记录可以找回已经完成的草稿');
      }
    } finally {
      setGenerating(false);
    }
  };

  const publish = async (revisionId: string) => {
    setMutatingId(revisionId);
    const result = await publishHostedSiteRevision(site.id, revisionId);
    setMutatingId(null);
    if (!result.success) {
      toast.error('发布失败', result.error?.message || '请刷新后重试');
      return;
    }
    onPublished(result.data.site);
    setDraftRevisionId(null);
    setPhase('新版本已经发布');
    toast.success('新版本已经发布');
    await loadHistory();
  };

  const rollback = async (revisionId: string) => {
    setMutatingId(revisionId);
    const result = await rollbackHostedSiteRevision(site.id, revisionId);
    setMutatingId(null);
    if (!result.success) {
      toast.error('回退失败', result.error?.message || '请刷新后重试');
      return;
    }
    onPublished(result.data.site);
    setPreviewHtml('');
    setDraftRevisionId(null);
    setPhase('旧内容已作为一个新版本重新发布');
    toast.success('已经回退并发布为新版本');
    await loadHistory();
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-token-primary">
      <div className="shrink-0 border-b border-token-subtle p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <WandSparkles size={16} />
          帮我修改
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
          当前先由 MAP 模型生成草稿。线上页面只有在你点击“发布新版本”后才会变化。
        </p>
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          disabled={generating}
          maxLength={4000}
          rows={4}
          placeholder="例如：把首屏标题改得更直接，主按钮换成“立即体验”，保留其余内容不变。"
          className="mt-3 w-full resize-none rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-xs text-token-primary outline-none focus:border-blue-500 disabled:opacity-60"
        />
        <div className="mt-3 rounded-lg border border-token-subtle bg-token-nested p-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex items-center gap-1.5 font-medium"><BookOpen size={13} />引用知识库</span>
            <span className="text-token-muted">{selectedKnowledgeIds.length}/3</span>
          </div>
          {loadingKnowledge ? (
            <p className="mt-2 text-[10px] text-token-muted">正在读取最近知识</p>
          ) : recentKnowledge.length === 0 ? (
            <p className="mt-2 text-[10px] text-token-muted">最近没有可引用的知识。</p>
          ) : (
            <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
              {recentKnowledge.map((item) => {
                const selected = selectedKnowledgeIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={generating}
                    onClick={() => toggleKnowledge(item.id)}
                    title={`${item.storeName} / ${item.title}`}
                    className={`flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors disabled:opacity-50 ${selected ? 'border-blue-500 bg-blue-500/10 text-blue-500' : 'border-token-subtle text-token-secondary hover-bg-soft'}`}
                  >
                    <span className="truncate">{item.title}</span>
                    {selected && <X size={10} className="shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating || instruction.trim().length === 0}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {generating ? <MapSpinner size={14} /> : <Send size={14} />}
          {generating ? '正在生成草稿' : '生成修改草稿'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="border-b border-token-subtle p-4">
          <div className="flex items-center justify-between gap-2 text-[11px] text-token-muted">
            <span>{phase}</span>
            <span className="tabular-nums">{progress}%</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-token-card">
            <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          {thinking && generating && (
            <div className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-token-muted">{thinking}</div>
          )}

          {previewHtml ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-token-subtle">
              <div className="flex items-center justify-between bg-token-nested px-2.5 py-1.5 text-[11px] text-token-muted">
                <span className="flex items-center gap-1"><Eye size={12} />草稿预览</span>
                {draftRevisionId && (
                  <button
                    type="button"
                    disabled={mutatingId === draftRevisionId}
                    onClick={() => void publish(draftRevisionId)}
                    className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {mutatingId === draftRevisionId ? <MapSpinner size={12} /> : <Check size={12} />}
                    发布新版本
                  </button>
                )}
              </div>
              <iframe
                srcDoc={previewHtml}
                sandbox={`${SRCDOC_PREVIEW_SANDBOX} allow-modals`}
                title="修改草稿预览"
                className="h-64 w-full bg-white"
              />
            </div>
          ) : generating ? (
            <div className="mt-3 h-64 overflow-hidden rounded-lg border border-token-subtle bg-token-nested">
              <MapSectionLoader text="页面结构出现后会立即显示在这里" />
            </div>
          ) : null}
        </div>

        <div className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2 text-xs font-medium">
            <span className="flex items-center gap-2"><History size={14} />版本记录</span>
            <button
              type="button"
              title="刷新版本记录"
              disabled={loadingHistory}
              onClick={() => void loadHistory()}
              className="rounded-md p-1.5 text-token-secondary hover-bg-soft disabled:opacity-50"
            >
              <RefreshCw size={12} className={loadingHistory ? 'animate-spin' : ''} />
            </button>
          </div>
          {loadingHistory ? (
            <MapSectionLoader text="正在读取版本记录" />
          ) : revisions.length === 0 ? (
            <p className="text-[11px] text-token-muted">尚无版本记录。</p>
          ) : (
            <div className="space-y-2">
              {revisions.map((item) => (
                <div key={item.id} className="rounded-lg border border-token-subtle bg-token-nested p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium">{revisionLabel(item)}</div>
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-token-muted">
                        <Clock3 size={10} />{formatRevisionTime(item.publishedAt || item.createdAt)}
                      </div>
                      {item.instruction && <p className="mt-1 line-clamp-2 text-[10px] text-token-muted">{item.instruction}</p>}
                      {item.knowledgeEntryIds.length > 0 && (
                        <p className="mt-1 text-[10px] text-token-muted">引用了 {item.knowledgeEntryIds.length} 篇知识</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        title="预览这个版本"
                        onClick={() => void openRevision(item.id)}
                        className="rounded-md p-1.5 text-token-secondary hover-bg-soft"
                      >
                        <Eye size={13} />
                      </button>
                      {item.status === 'published' && !item.isCurrent && (
                        <button
                          type="button"
                          title="把这个版本重新发布为最新版"
                          disabled={mutatingId === item.id}
                          onClick={() => void rollback(item.id)}
                          className="rounded-md p-1.5 text-token-secondary hover-bg-soft disabled:opacity-50"
                        >
                          {mutatingId === item.id ? <MapSpinner size={13} /> : <RotateCcw size={13} />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
