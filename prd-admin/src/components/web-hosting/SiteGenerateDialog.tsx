import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ExternalLink, Send, Server, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import {
  createDesignArtifactRun,
  getDesignArtifactRun,
  getDesignRuntimeCapabilities,
  streamDesignArtifactRun,
  type DesignRuntimeCapability,
} from '@/services/real/webPages';
import {
  AI_STREAM_PREVIEW_SANDBOX,
  previewableAiStreamHtml,
} from './siteEditPreview';

export interface SiteGenerateSource {
  entryId: string;
  storeId: string;
  title: string;
  storeName?: string;
}

interface Props {
  open: boolean;
  initialSource?: SiteGenerateSource | null;
  onClose: () => void;
  onCreated: (siteId: string) => void;
}

interface PhaseEvent {
  progress?: number;
  message?: string;
}

const ACTIVE_GENERATION_RUN_KEY = 'web-hosting-design-active-run-v1';

export default function SiteGenerateDialog({ open, initialSource, onClose, onCreated }: Props) {
  const [recentKnowledge, setRecentKnowledge] = useState<RecentDocumentEntry[]>([]);
  const [selectedKnowledgeIds, setSelectedKnowledgeIds] = useState<string[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [capabilities, setCapabilities] = useState<DesignRuntimeCapability[]>([]);
  const [selectedRuntime, setSelectedRuntime] = useState('map-gateway');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState('选择知识，再用两句话说明页面给谁看、希望达到什么效果。');
  const [progress, setProgress] = useState(0);
  const [thinking, setThinking] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [generating, setGenerating] = useState(false);
  const [completedSite, setCompletedSite] = useState<{ id: string; url?: string } | null>(null);
  const streamRef = useRef('');
  const lastPaintAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const onCreatedRef = useRef(onCreated);

  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  useEffect(() => {
    if (!open) return;
    setLoadingKnowledge(true);
    setTitle(initialSource?.title || '');
    setInstruction('');
    setPhase('选择知识，再用两句话说明页面给谁看、希望达到什么效果。');
    setProgress(0);
    setThinking('');
    setPreviewHtml('');
    setCompletedSite(null);
    setSelectedKnowledgeIds(initialSource ? [initialSource.entryId] : []);
    let active = true;
    void Promise.all([listRecentDocumentEntries(16), getDesignRuntimeCapabilities()]).then(([recent, runtimes]) => {
      if (!active) return;
      const items = recent.success ? recent.data.items : [];
      if (initialSource && !items.some((item) => item.id === initialSource.entryId)) {
        items.unshift({
          id: initialSource.entryId,
          storeId: initialSource.storeId,
          storeName: initialSource.storeName || '当前知识库',
          title: initialSource.title,
          contentType: 'text/markdown',
          tags: [],
          createdAt: '',
          updatedAt: '',
          isNew: false,
        });
      }
      setRecentKnowledge(items);
      if (runtimes.success) {
        setCapabilities(runtimes.data.runtimes);
        const preferred = runtimes.data.runtimes.find((item) => item.id === runtimes.data.defaultRuntime && item.enabled)
          ?? runtimes.data.runtimes.find((item) => item.enabled);
        if (preferred) setSelectedRuntime(preferred.id);
      }
      setLoadingKnowledge(false);
    });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [initialSource, open]);

  useEffect(() => {
    if (!open) return;
    const runId = sessionStorage.getItem(ACTIVE_GENERATION_RUN_KEY);
    if (!runId) return;

    let active = true;
    let timer: number | undefined;
    const recover = async () => {
      const result = await getDesignArtifactRun(runId);
      if (!active) return;
      if (!result.success) {
        sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
        return;
      }

      setPhase(result.data.phase);
      setProgress(result.data.progress);
      const status = result.data.status.toLowerCase();
      if (status === 'done' && result.data.artifactSiteId) {
        setGenerating(false);
        setCompletedSite({ id: result.data.artifactSiteId });
        sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
        onCreatedRef.current(result.data.artifactSiteId);
        return;
      }
      if (status === 'error' || status === 'cancelled') {
        setGenerating(false);
        sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
        return;
      }

      setGenerating(true);
      timer = window.setTimeout(recover, 1500);
    };
    void recover();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [open]);

  const enabledRuntime = capabilities.find((item) => item.id === selectedRuntime && item.enabled)
    ?? capabilities.find((item) => item.enabled);
  const visibleRuntime = capabilities.find((item) => item.id === selectedRuntime)
    ?? enabledRuntime
    ?? capabilities[0];
  const unavailableRuntimes = useMemo(
    () => capabilities.filter((item) => !item.enabled),
    [capabilities],
  );

  const toggleKnowledge = (entryId: string) => {
    if (generating) return;
    setSelectedKnowledgeIds((current) => {
      if (current.includes(entryId)) return current.filter((id) => id !== entryId);
      if (current.length >= 3) {
        toast.info('首版一次最多引用 3 篇知识');
        return current;
      }
      return [...current, entryId];
    });
  };

  const generate = async () => {
    const text = instruction.trim();
    if (!text || selectedKnowledgeIds.length === 0 || generating) return;
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    setGenerating(true);
    setCompletedSite(null);
    setThinking('');
    setPreviewHtml('');
    setProgress(1);
    setPhase('正在校验所选知识');
    streamRef.current = '';

    const selectedEntries = selectedKnowledgeIds
      .map((entryId) => recentKnowledge.find((item) => item.id === entryId))
      .filter((entry): entry is RecentDocumentEntry => !!entry);
    if (selectedEntries.length !== selectedKnowledgeIds.length || selectedEntries.some((entry) => !entry.storeId)) {
      setGenerating(false);
      setPhase('引用知识身份不完整，请重新选择');
      toast.error('无法校验引用知识', '请刷新知识列表后重新选择');
      return;
    }

    const knowledgeReferences = selectedEntries.map((entry) => ({
      entryId: entry.id,
      storeId: entry.storeId,
    }));
    const created = await createDesignArtifactRun({
      instruction: text,
      title: title.trim() || selectedEntries[0].title,
      runtime: enabledRuntime?.id,
      sourceSurface: initialSource ? 'knowledge-base' : 'web-hosting',
      knowledgeReferences,
    });
    if (!created.success) {
      setGenerating(false);
      setPhase(created.error?.message || '网页生成任务创建失败');
      toast.error('无法开始生成', created.error?.message || '请稍后重试');
      return;
    }
    sessionStorage.setItem(ACTIVE_GENERATION_RUN_KEY, created.data.runId);

    try {
      await streamDesignArtifactRun({
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
            setThinking((previous) => `${previous}${data.text}`.slice(-600));
            return;
          }
          if (event.event === 'delta' && typeof data.text === 'string') {
            streamRef.current += data.text;
            const now = Date.now();
            if (now - lastPaintAtRef.current >= 200) {
              const html = previewableAiStreamHtml(streamRef.current);
              if (html) setPreviewHtml(html);
              lastPaintAtRef.current = now;
            }
            return;
          }
          if (event.event === 'done' && typeof data.siteId === 'string') {
            const finalPreview = previewableAiStreamHtml(streamRef.current);
            if (finalPreview) setPreviewHtml(finalPreview);
            setCompletedSite({ id: data.siteId, url: typeof data.siteUrl === 'string' ? data.siteUrl : undefined });
            setProgress(100);
            setPhase('网页已生成并保存，可在网页托管中继续修改和发布分享');
            sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
            onCreated(data.siteId);
            return;
          }
          if (event.event === 'error') {
            const message = typeof data.message === 'string' ? data.message : '网页生成失败';
            setPhase(message);
            sessionStorage.removeItem(ACTIVE_GENERATION_RUN_KEY);
            toast.error('网页生成失败', message);
          }
        },
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : '网页生成进度连接中断';
        setPhase(message);
        toast.error('网页生成进度中断', '任务仍由服务器继续执行，稍后可在网页托管中查看产物');
      }
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="引用知识生成网页"
      description="知识内容负责事实，补充要求负责受众、目的和风格。生成结果会直接保存在网页托管。"
      maxWidth={1080}
      contentClassName="p-4 sm:p-6"
      contentStyle={{
        width: 'min(1080px, calc(100vw - 16px))',
        maxWidth: 'calc(100vw - 16px)',
        height: 'min(760px, calc(100vh - 24px))',
      }}
      content={(
        <div className="grid h-full min-h-0 min-w-0 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-h-0 min-w-0 overflow-y-auto rounded-xl border border-token-subtle bg-token-nested p-4">
            <label className="text-xs font-semibold text-token-primary" htmlFor="design-site-title">网页标题</label>
            <input
              id="design-site-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={generating}
              maxLength={200}
              placeholder="默认使用第一篇知识的标题"
              className="mt-2 w-full rounded-lg border border-token-subtle bg-token-card px-3 py-2 text-xs text-token-primary outline-none focus:border-blue-500 disabled:opacity-60"
            />

            <div className="mt-4 flex items-center justify-between text-xs font-semibold text-token-primary">
              <span className="flex items-center gap-1.5"><BookOpen size={14} />引用知识</span>
              <span className="font-normal text-token-muted">{selectedKnowledgeIds.length}/3</span>
            </div>
            {loadingKnowledge ? (
              <div className="mt-2"><MapSectionLoader text="正在读取最近知识" /></div>
            ) : recentKnowledge.length === 0 ? (
              <p className="mt-2 text-xs text-token-muted">最近没有可引用的知识，请先在知识库中创建内容。</p>
            ) : (
              <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {recentKnowledge.map((item) => {
                  const selected = selectedKnowledgeIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={generating}
                      onClick={() => toggleKnowledge(item.id)}
                      title={`${item.storeName} / ${item.title}`}
                      className={`flex min-w-0 max-w-full items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${selected ? 'border-blue-500 bg-blue-500/10 text-blue-500' : 'border-token-subtle text-token-secondary hover-bg-soft'}`}
                    >
                      <span className="min-w-0 truncate">{item.title}</span>
                      {selected && <X size={10} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}

            <label className="mt-4 block text-xs font-semibold text-token-primary" htmlFor="design-site-instruction">补充两句话</label>
            <textarea
              id="design-site-instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              disabled={generating}
              maxLength={4000}
              rows={5}
              placeholder="例如：做成给潜在客户看的产品介绍页。重点突出三个价值和落地案例，风格克制、可信。"
              className="mt-2 w-full resize-none rounded-lg border border-token-subtle bg-token-card px-3 py-2 text-xs text-token-primary outline-none focus:border-blue-500 disabled:opacity-60"
            />

            <div className="mt-4 rounded-lg border border-token-subtle bg-token-card p-3 text-[11px]">
              <div className="flex items-center gap-1.5 font-medium text-token-primary"><Server size={13} />执行器事实</div>
              {capabilities.filter((item) => item.enabled).length > 1 ? (
                <select
                  value={selectedRuntime}
                  onChange={(event) => setSelectedRuntime(event.target.value)}
                  disabled={generating}
                  aria-label="设计执行器"
                  className="mt-2 w-full rounded-md border border-token-subtle bg-token-nested px-2 py-1.5 text-[11px] text-token-primary"
                >
                  {capabilities.filter((item) => item.enabled).map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-token-secondary">当前使用：{visibleRuntime?.label || '正在检测'}</p>
              )}
              {visibleRuntime && (
                <p className="mt-1 leading-relaxed text-token-muted">
                  执行归属：{visibleRuntime.executionOwner === 'cds-remote-agent' ? 'CDS Remote Agent' : 'MAP'}；
                  隔离边界：{visibleRuntime.isolationMode === 'session-container' ? '会话级容器' : 'MAP 服务进程'}。
                </p>
              )}
              {unavailableRuntimes.length > 0 && (
                <p className="mt-1 leading-relaxed text-token-muted">
                  {unavailableRuntimes.map((item) => `${item.label}：${item.reason || '未启用'}`).join('；')}
                </p>
              )}
            </div>

            <Button
              className="mt-4 w-full justify-center"
              size="sm"
              variant="primary"
              disabled={generating || !enabledRuntime || !instruction.trim() || selectedKnowledgeIds.length === 0}
              onClick={() => void generate()}
            >
              {generating ? <MapSpinner size={14} /> : <Send size={14} />}
              <span className="ml-1.5">{generating ? '网页正在生长' : '生成并保存网页'}</span>
            </Button>
          </div>

          <div className="flex min-h-[280px] min-w-0 flex-col overflow-hidden rounded-xl border border-token-subtle bg-token-nested lg:min-h-0">
            <div className="shrink-0 border-b border-token-subtle px-4 py-3">
              <div className="flex items-center justify-between gap-3 text-xs text-token-secondary">
                <span>{phase}</span>
                <span className="tabular-nums">{progress}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-token-card">
                <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
              {thinking && generating && <p className="mt-2 line-clamp-2 text-[11px] text-token-muted">{thinking}</p>}
            </div>
            <div className="relative min-h-0 flex-1 bg-white">
              {previewHtml ? (
                <iframe
                  srcDoc={previewHtml}
                  sandbox={AI_STREAM_PREVIEW_SANDBOX}
                  referrerPolicy="no-referrer"
                  title="知识生成网页预览"
                  className="h-full w-full bg-white"
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-token-card">
                  <MapSectionLoader text={generating ? '页面结构出现后会立即在这里生长' : '生成前，这里会展示实时网页'} />
                </div>
              )}
              {completedSite && (
                <div className="absolute bottom-4 right-4 flex items-center gap-2 rounded-lg border border-token-subtle bg-token-elevated p-2 shadow-lg">
                  <span className="flex items-center gap-1.5 text-xs text-token-primary"><Check size={14} />已保存到网页托管</span>
                  {completedSite.url && (
                    <Button size="xs" variant="secondary" onClick={() => window.open(completedSite.url, '_blank', 'noopener')}>
                      <ExternalLink size={12} /><span className="ml-1">打开网页</span>
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    />
  );
}
