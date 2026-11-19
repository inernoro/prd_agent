import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BookOpen, FileText, Library, Upload } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { KnowledgeEntrySelection } from '@/components/knowledge/KnowledgeEntryPicker';
import KnowledgeInlineBrowser from '@/components/web-hosting/KnowledgeInlineBrowser';
import { runtimeFailureRecoveryMessage } from '@/components/web-hosting/siteGenerateProgress';
import { DESIGN_ATTACHMENT_ACCEPT, MAX_GENERATE_ATTACHMENTS, useDesignAttachmentUploads } from '@/components/web-hosting/designAttachments';
import { ComposerSheet, WorkbenchComposer, type ComposerChip } from '@/components/web-hosting/workbench/WorkbenchParts';
import {
  addInformationDeliveryCorrection, archiveInformationDelivery, assembleInformationDeliveryMedia,
  createDesignArtifactRun, downloadInformationDeliveryMedia, getDesignArtifactRun, listInformationDeliveryTemplates,
  readInformationDeliveryArchive, readInformationDeliveryFiles, readInformationDeliverySources, streamDesignArtifactRun,
  type DesignArtifactRunSummary, type InformationDeliveryArchive, type InformationDeliveryFile, type InformationDeliverySource,
  type InformationDeliveryFormat, type InformationDeliveryMedia, type InformationDeliveryTarget, type InformationDeliveryTemplate,
} from '@/services/real/webPages';
import { generateSpeech, getSpeechCapabilities, getSpeechRun } from '@/services/real/mcpSpeech';
import { listRecentDocumentEntries } from '@/services/real/documentStore';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import { useAuthStore } from '@/stores/authStore';
import { writingKnowledgeHref, writingMediaTimeReached } from './writingView';

const cardClass = 'rounded-xl border border-subtle bg-surface p-5';
const terminal = (status: string) => ['done', 'error', 'cancelled'].includes(status.toLowerCase());
const fileLabels: Record<string, string> = { 'index.html': '网页预览', 'assets/delivery.json': '教程与依据' };
type DeliveryProgress = { code: string; message: string };

export default function InformationDeliveryPage() {
  const { storeId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const [templates, setTemplates] = useState<InformationDeliveryTemplate[]>();
  const [template, setTemplate] = useState<InformationDeliveryTemplate>();
  const [view, setView] = useState<'example' | 'outline'>('example');
  const [selected, setSelected] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [mediaFormats, setMediaFormats] = useState<InformationDeliveryFormat[]>([]);
  const [speechAvailable, setSpeechAvailable] = useState<boolean>();
  const canGenerateSpeech = useAuthStore((state) => state.isRoot || state.permissions.some(
    (permission) => ['super', 'mcp-speech.generate', 'mcp-speech.manage'].includes(permission),
  ));
  const [knowledge, setKnowledge] = useState<KnowledgeEntrySelection[]>([]);
  const [recent, setRecent] = useState<RecentDocumentEntry[]>([]);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const startGuard = useRef(false);
  const previousRequest = useRef<{ fingerprint: string; id: string }>();
  const uploads = useDesignAttachmentUploads('document', MAX_GENERATE_ATTACHMENTS);

  useEffect(() => {
    if (runId) return;
    let active = true;
    void listInformationDeliveryTemplates().then((result) => {
      if (!active) return;
      if (!result.success) {
        setError(result.error?.message || '暂时无法读取模板');
        return;
      }
      setTemplates(result.data.templates);
    });
    return () => { active = false; };
  }, [catalogAttempt, runId]);

  useEffect(() => {
    if (!showKnowledge) return;
    let active = true;
    void listRecentDocumentEntries(20).then((result) => {
      if (!active) return;
      if (result.success) setRecent(result.data.items);
      setLoadingRecent(false);
    });
    return () => { active = false; };
  }, [showKnowledge]);

  useEffect(() => {
    if (!selected || !canGenerateSpeech) return;
    let active = true;
    void getSpeechCapabilities().then((result) => {
      if (active) setSpeechAvailable(result.success && result.data.profiles.some(
        (profile) => profile.isDefault && profile.available && profile.formats.includes('mp3'),
      ));
    });
    return () => { active = false; };
  }, [selected, canGenerateSpeech]);

  const addKnowledge = () => {
    setLoadingRecent(true);
    setShowKnowledge(true);
  };

  const chips: ComposerChip[] = [
    ...knowledge.map((entry) => ({
      key: entry.entryId, label: entry.title, status: '知识库',
      onRemove: () => setKnowledge((current) => current.filter((item) => item.entryId !== entry.entryId)),
    })),
    ...uploads.items.map<ComposerChip>((item) => ({
      key: item.key, label: item.fileName,
      status: item.status === 'ready' ? '上传文件' : item.status === 'failed' ? item.error : '正在读取',
      tone: item.status === 'failed' ? 'danger' : item.status === 'ready' ? 'default' : 'busy',
      onRemove: () => uploads.remove(item.key),
    })),
  ];
  const canStart = !!template && !starting && !uploads.busy
    && (knowledge.length + uploads.readyIds.length > 0)
    && uploads.items.every((item) => item.status === 'ready');

  const start = async () => {
    if (startGuard.current || !canStart || !template) return;
    startGuard.current = true;
    setStarting(true);
    setError('');
    const fingerprint = JSON.stringify([template.id, template.version, prompt, knowledge.map(({ entryId, storeId }) => [entryId, storeId]), uploads.readyIds, mediaFormats]);
    if (previousRequest.current?.fingerprint !== fingerprint)
      previousRequest.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const result = await createDesignArtifactRun({
        instruction: prompt,
        sourceSurface: 'knowledge-base',
        knowledgeReferences: knowledge,
        attachmentIds: uploads.readyIds,
        deliveryTemplateId: template.id,
        deliveryTemplateVersion: template.version,
        deliveryRequestId: previousRequest.current.id,
        deliveryMediaFormats: mediaFormats,
      });
      if (!result.success) {
        setError(result.error?.message || '无法开始生成');
        return;
      }
      setParams({ run: result.data.runId }, { replace: true });
    } finally {
      startGuard.current = false;
      setStarting(false);
    }
  };

  return (
    <main className="min-h-screen bg-base px-4 py-6 text-token-primary sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">信息传递</h1>
          <Link className="text-sm text-token-secondary underline" to={writingKnowledgeHref(storeId)}>返回知识库</Link>
        </header>
        {runId ? <DeliveryExecution key={runId} runId={runId} storeId={storeId} /> : <>
          {error && <div role="alert" className="mb-4 text-sm text-token-primary">{error}{!templates && <> <Button onClick={() => { setError(''); setCatalogAttempt((v) => v + 1); }}>重试</Button></>}</div>}
          {!templates && !error && <p role="status">正在读取平台模板</p>}
          {templates && !selected && <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <section className={cardClass} aria-label="平台模板">
              <h2 className="mb-4 text-lg font-semibold">选择平台模板</h2>
              <div className="grid gap-2">
                {templates.map((item) => (
                  <button key={item.id} type="button" aria-pressed={template?.id === item.id}
                    className="rounded-lg border border-subtle px-4 py-3 text-left hover-bg-soft"
                    onClick={() => { setTemplate(item); setView('example'); }}>
                    <strong>{item.title}</strong><span className="mt-1 block text-sm text-token-secondary">{item.useWhen}</span>
                  </button>
                ))}
              </div>
            </section>
            {template && <section className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{template.title}</h2>
                <Button onClick={() => setSelected(true)}>使用模板</Button>
              </div>
              <div className="my-4 flex gap-2" role="group" aria-label="模板预览">
                <Button aria-pressed={view === 'example'} variant={view === 'example' ? 'primary' : 'secondary'} onClick={() => setView('example')}>完整示例</Button>
                <Button aria-pressed={view === 'outline'} variant={view === 'outline' ? 'primary' : 'secondary'} onClick={() => setView('outline')}>骨架</Button>
              </div>
              <h3 className="mb-3 font-medium">{view === 'example' ? template.exampleTitle : '章节与填写说明'}</h3>
              <div className="grid gap-3">
                {template.sections.map((section) => (
                  <section key={section.title}>
                    <h4 className="font-medium">{section.title}</h4>
                    <p className="mt-1 text-sm leading-relaxed text-token-secondary">{view === 'example' ? section.example : section.purpose}</p>
                  </section>
                ))}
              </div>
            </section>}
          </div>}
          {selected && <section className={`${cardClass} relative min-h-[24rem]`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{template?.title} · 添加资料</h2>
              <Button variant="secondary" disabled={starting} onClick={() => { setSelected(false); setError(''); }}>查看模板</Button>
            </div>
            <input ref={fileInput} type="file" multiple hidden accept={DESIGN_ATTACHMENT_ACCEPT.document} onChange={(event) => {
              if (event.currentTarget.files) uploads.addFiles(Array.from(event.currentTarget.files));
              event.currentTarget.value = '';
            }} />
            <WorkbenchComposer id="information-delivery-instruction" value={prompt} onChange={setPrompt}
              placeholder="想突出哪些信息？可留空" disabled={starting}
              plusItems={[
                { id: 'upload', title: '上传文件', description: '从设备选择文档', icon: Upload, onPick: () => fileInput.current?.click() },
                { id: 'knowledge', title: '引用知识库', description: '选择你有权读取的文档', icon: Library, onPick: addKnowledge },
              ]}
              chips={chips} sendLabel="开始生成" sendDisabled={!canStart} onSend={() => void start()}
              sendDisabledReason={uploads.busy ? '等待资料上传并读取完成' : '请添加可用资料'}
              options={<fieldset disabled={starting || !speechAvailable} className="mt-2 flex flex-wrap gap-4 text-sm">
                <legend className="mb-2 font-medium">生成网页与图文教程</legend>
                {(['audio', 'video'] as const).map((format) => (
                  <label key={format} className="flex gap-2"><input type="checkbox" checked={mediaFormats.includes(format)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setMediaFormats((current) => checked ? [...current, format] : current.filter((value) => value !== format));
                    }}
                  />{format === 'audio' ? '同时生成音频讲解' : '同时生成视频教程'}</label>
                ))}
                {(!canGenerateSpeech || speechAvailable === false) && <p className="w-full text-xs text-token-secondary">当前账号没有可用语音能力，可以先生成网页与图文教程。</p>}
              </fieldset>}
              hint="开始后可查看生成进度与中间文件" />
            {showKnowledge && <ComposerSheet title="引用知识库" onClose={() => setShowKnowledge(false)}>
              <KnowledgeInlineBrowser recentEntries={recent} loadingRecent={loadingRecent} selectedEntries={knowledge}
                onChange={(items) => setKnowledge(items.slice(0, 3))} />
            </ComposerSheet>}
          </section>}
        </>}
      </div>
    </main>
  );
}

function DeliveryExecution({ runId, storeId }: { runId: string; storeId: string }) {
  const [run, setRun] = useState<DesignArtifactRunSummary>();
  const [phase, setPhase] = useState('');
  const [progressLog, setProgressLog] = useState<DeliveryProgress[]>([]);
  const [error, setError] = useState('');
  const [reconnect, setReconnect] = useState(0);
  const [files, setFiles] = useState<InformationDeliveryFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('index.html');
  const [content, setContent] = useState<string>();
  const [fileRevision, setFileRevision] = useState(-1);
  const [correction, setCorrection] = useState('');
  const [correctionError, setCorrectionError] = useState('');
  const [sendingCorrection, setSendingCorrection] = useState(false);
  const [sources, setSources] = useState<InformationDeliverySource[]>();
  const [sourceStatus, setSourceStatus] = useState('');
  const afterSeq = useRef(0);
  const previewVersion = useRef(-1);
  const correctionRequest = useRef<{ text: string; id: string }>();
  const hasRun = !!run;

  useEffect(() => {
    const controller = new AbortController();
    const fetchState = async () => {
      const result = await getDesignArtifactRun(runId);
      if (controller.signal.aborted) return null;
      if (!result.success || !result.data.deliveryTemplateId) {
        setError(result.success ? '这不是信息传递任务' : result.error?.message || '任务不可读');
        return null;
      }
      setRun(result.data);
      setPhase(result.data.phase);
      setError('');
      if (result.data.previewRevision != null) {
        previewVersion.current = result.data.previewRevision ?? -1;
        setFileRevision(previewVersion.current);
      }
      return result.data;
    };
    const observe = async () => {
      const initial = await fetchState();
      if (!initial || terminal(initial.status)) return;
      try {
        await streamDesignArtifactRun({
          runId, afterSeq: afterSeq.current, signal: controller.signal,
          onEvent: (event) => {
            if (!event.data || controller.signal.aborted) return;
            const sequence = Number(event.id);
            if (Number.isFinite(sequence)) afterSeq.current = Math.max(afterSeq.current, sequence);
            try {
              const data: { message?: string; phaseCode?: string; revision?: number } = JSON.parse(event.data);
              if (event.event === 'phase' && data.message) {
                setPhase(data.message);
                const entry = { code: data.phaseCode || data.message, message: data.message };
                setProgressLog((history) => {
                  const previous = history.at(-1);
                  if (entry.code === previous?.code) {
                    return entry.message === previous.message ? history : [...history.slice(0, -1), entry];
                  }
                  return [...history.slice(-9), entry];
                });
              }
              if (event.event === 'preview' && (data.revision ?? 0) > previewVersion.current) {
                previewVersion.current = data.revision ?? 0;
                setFileRevision(previewVersion.current);
              }
            } catch { /* The status endpoint remains authoritative. */ }
          },
        });
        if (controller.signal.aborted) return;
        const current = await fetchState();
        if (current && !terminal(current.status)) setError('进度连接已断开，可以继续查看这次任务');
      } catch {
        if (!controller.signal.aborted) setError('进度连接已断开，可以继续查看这次任务');
      }
    };
    void observe();
    return () => controller.abort();
  }, [runId, reconnect]);

  const done = run?.status.toLowerCase() === 'done';
  const failed = run?.status.toLowerCase() === 'error';
  const running = !!run && !terminal(run.status);
  const [mediaUpdate, setMediaUpdate] = useState<InformationDeliveryMedia[]>();
  const readyMedia = mediaUpdate ?? run?.deliveryMediaFiles ?? [];
  const mediaRequired = run?.deliveryMediaFormats ?? [];
  const waitingForMedia = mediaRequired.some((format) => !readyMedia.some((entry) => entry.format === format));
  useEffect(() => {
    if (!running) return;
    let active = true;
    const sync = () => void getDesignArtifactRun(runId).then((result) => {
      if (!active || !result.success || !result.data.deliveryTemplateId) return;
      const latestRevision = result.data.previewRevision ?? -1;
      if (latestRevision > previewVersion.current) {
        previewVersion.current = latestRevision;
        setFileRevision(latestRevision);
      }
      setRun((current) => (current?.deliveryCorrectionRevision ?? 0) > (result.data.deliveryCorrectionRevision ?? 0)
        ? current : result.data);
    });
    const timer = window.setInterval(sync, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [runId, running]);

  useEffect(() => {
    if (!hasRun) return;
    let active = true;
    void readInformationDeliveryFiles(runId, selectedFile).then((result) => {
      if (!active) return;
      if (!result.success) {
        setError(result.error?.message || '文件读取失败');
        return;
      }
      setFiles(result.data.files);
      setContent(result.data.content ?? undefined);
      if (result.data.files.length && !result.data.files.some((file) => file.path === selectedFile))
        setSelectedFile(result.data.files[0].path);
    });
    return () => { active = false; };
  }, [runId, selectedFile, done, reconnect, fileRevision, hasRun]);

  const sendCorrection = async () => {
    const text = correction.trim();
    if (!text || !run || sendingCorrection) return;
    if (correctionRequest.current?.text !== text) correctionRequest.current = { text, id: crypto.randomUUID() };
    setSendingCorrection(true);
    setCorrectionError('');
    try {
      const result = await addInformationDeliveryCorrection(runId, {
        id: correctionRequest.current.id, text, revision: run.deliveryCorrectionRevision ?? 0,
      });
      if (!result.success) {
        setCorrectionError(result.error?.message || '纠正未保存');
        const current = await getDesignArtifactRun(runId);
        if (current.success && current.data.deliveryTemplateId) setRun(current.data);
        return;
      }
      setRun(result.data);
      setCorrection('');
      correctionRequest.current = undefined;
    } finally {
      setSendingCorrection(false);
    }
  };

  const fileList = files.length ? files : content ? [{ path: 'index.html', mediaType: 'text/html', draft: !done }] : [];
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <section className={cardClass}>
        <h2 className="text-lg font-semibold">{done ? '生成结果' : failed ? '生成未完成' : '生成进度'}</h2>
        <p role="status" className="my-3 text-sm text-token-secondary">{phase || '正在读取任务'}</p>
        {run?.resolvedModel && <p className="mb-4 text-xs text-token-secondary">{run.resolvedModel} · {run.resolvedPlatform}</p>}
        {failed && run && <p role="alert" className="mb-4 text-sm">{runtimeFailureRecoveryMessage(run, 'generate')}</p>}
        {progressLog.length > 1 && <details className="mb-4 text-sm">
          <summary className="cursor-pointer font-medium">执行记录</summary>
          <ol className="mt-2 grid list-decimal gap-1 pl-5 text-xs text-token-secondary" aria-label="执行记录">
            {progressLog.map((entry, index) => <li key={`${index}-${entry.code}`}>{entry.message}</li>)}
          </ol>
        </details>}
        {error && <div role="alert" className="mb-4 text-sm">{error} <Button variant="secondary" onClick={() => setReconnect((v) => v + 1)}>重连</Button></div>}
        {!!run?.deliveryCorrections?.length && <ol aria-label="作者纠正" className="mb-4 grid gap-2">
          {run.deliveryCorrections.map((message) => <li key={message.id} className="rounded-lg border border-subtle p-3 text-sm">
            <span className="block text-xs text-token-secondary">
              {message.revision <= (run.deliveryAppliedRevision ?? 0) ? '已应用，查看修订文件' : '已收到，等待执行轮次应用'}
            </span>
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
          </li>)}
        </ol>}
        {running && !run.deliveryCorrectionsClosedAt && <form className="mb-4 grid gap-2" onSubmit={(event) => {
          event.preventDefault();
          void sendCorrection();
        }}>
          <label htmlFor="delivery-correction" className="text-sm font-medium">给这次生成补答或纠正</label>
          <textarea id="delivery-correction" className="rounded-lg border border-subtle bg-transparent p-2"
            value={correction} onChange={(event) => setCorrection(event.currentTarget.value)} maxLength={1000} rows={3} />
          <Button type="submit" disabled={sendingCorrection || !correction.trim()}>{sendingCorrection ? '正在提交' : '发送纠正'}</Button>
          {correctionError && <p role="alert" className="text-sm">{correctionError}</p>}
        </form>}
        <nav aria-label="生成文件" className="grid gap-2">
          {fileList.map((file) => <Button key={file.path} variant="secondary" aria-pressed={selectedFile === file.path}
            onClick={() => { if (file.path !== selectedFile) { setContent(undefined); setSelectedFile(file.path); } }}>
            <FileText size={15} /> {fileLabels[file.path] || file.path} {file.draft ? ' · 草稿' : ' · 已就绪'}
          </Button>)}
        </nav>
        {hasRun && <section className="mt-5">
          <Button variant="secondary" aria-expanded={!!sources} disabled={sourceStatus === '正在读取原文'}
            onClick={() => {
              if (sources) { setSources(undefined); return; }
              setSourceStatus('正在读取原文');
              void readInformationDeliverySources(runId).then((result) => {
                if (result.success) { setSources(result.data.sources); setSourceStatus(''); }
                else setSourceStatus(result.error?.message || '原文暂不可读');
              });
            }}>
            <Library size={15} /> 原文快照
          </Button>
          {sourceStatus && <p className="mt-2 text-sm text-token-secondary" role="status">{sourceStatus}</p>}
          {sources && <DeliverySources sources={sources} />}
        </section>}
        {done && waitingForMedia && run?.deliveryResultHash && <PrepareDeliveryMedia storeId={storeId} runId={runId}
          resultHash={run.deliveryResultHash} onReady={setMediaUpdate} />}
        {done && run?.deliveryResultHash && !waitingForMedia && <DeliveryArchiveForm storeId={storeId} run={run} />}
      </section>
      <section className={cardClass} aria-label="文件预览">
        {readyMedia.length > 0 && <DeliveryMediaPreview storeId={storeId} runId={runId} media={readyMedia} />}
        {content ? selectedFile === 'index.html'
          ? <DeliveryHtml content={content} />
          : <CoursePreview content={content} />
          : <p className="flex items-center gap-2 text-sm text-token-secondary"><BookOpen size={16} /> {done ? '选择文件后预览' : '工作区写出首个文件后即可预览'}</p>}
      </section>
    </div>
  );
}

function PrepareDeliveryMedia({ storeId, runId, resultHash, onReady }: {
  storeId: string; runId: string; resultHash: string; onReady: (media: InformationDeliveryMedia[]) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState('正在读取讲解脚本');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const prepare = async () => {
      try {
        const courseFile = await readInformationDeliveryFiles(runId, 'assets/delivery.json');
        if (!active) return;
        const course = courseFile.success && courseFile.data.content ? parseCourse(courseFile.data.content) : null;
        if (!course || !course.chapters.length) throw new Error('无法读取已确认的讲解脚本');
        const ids: string[] = [];
        for (const [index, chapter] of course.chapters.entries()) {
          if (!active) return;
          setPhase(`正在配音 · 第 ${index + 1} / ${course.chapters.length} 章`);
          const key = `map-delivery-${runId}-${resultHash}-${index}`;
          let retry = 0;
          try {
            const stored = Number(sessionStorage.getItem(key));
            if (Number.isSafeInteger(stored) && stored >= 0) retry = stored;
          } catch { /* The initial request key remains deterministic. */ }
          const started = await generateSpeech({
            text: chapter.narration, title: chapter.title, format: 'mp3',
            clientRequestId: `${key}-${retry}`,
          });
          if (!started.success) throw new Error(started.error?.message || '语音能力暂时不可用');
          let voice = started.data;
          const deadline = Date.now() + 180_000;
          while (active && voice.status !== 'completed') {
            if (['failed', 'unknown', 'cancelled'].includes(voice.status)) {
              if (voice.status !== 'unknown') {
                try { sessionStorage.setItem(key, String(retry + 1)); } catch { /* Keep the recorded provider result. */ }
              }
              throw new Error(voice.errorMessage || voice.stage);
            }
            if (Date.now() >= deadline) throw new Error('配音仍在进行，继续查看可恢复');
            await new Promise((resolve) => window.setTimeout(resolve, 2500));
            if (!active) return;
            const response = await getSpeechRun(voice.id);
            if (!response.success) throw new Error(response.error?.message || '无法读取配音进度');
            voice = response.data;
          }
          ids.push(voice.id);
        }
        if (!active) return;
        setPhase('正在按章节合成已选媒体');
        const result = await assembleInformationDeliveryMedia(storeId, runId, ids);
        if (!active) return;
        if (!result.success) throw new Error(result.error?.message || '讲解未合成');
        onReady(result.data.media);
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : '讲解暂时未完成');
      }
    };
    void prepare();
    return () => { active = false; };
  }, [attempt, onReady, resultHash, runId, storeId]);
  return <div className="mt-4 rounded-lg border border-subtle p-3 text-sm">
    {error ? <><p role="alert">{error}</p><Button variant="secondary" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>继续查看讲解进度</Button></>
      : <p role="status">{phase}</p>}
  </div>;
}

function DeliveryArchiveForm({ storeId, run }: { storeId: string; run: DesignArtifactRunSummary }) {
  const [target, setTarget] = useState<InformationDeliveryTarget>(run.deliveryArchive?.target ?? 'knowledge-base');
  const [confirmed, setConfirmed] = useState(false);
  const [sharing, setSharing] = useState(run.deliveryArchive?.canShareUploads ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [path, setPath] = useState(run.deliveryArchive?.artifactId
    ? `/document-store/${encodeURIComponent(run.deliveryArchive.storeId)}/delivery/${encodeURIComponent(run.runId)}/read`
    : '');
  const [artifactId, setArtifactId] = useState(run.deliveryArchive?.artifactId);
  const submit = async () => {
    if (!confirmed || !run.deliveryResultHash || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await archiveInformationDelivery(run.deliveryArchive?.storeId ?? storeId, run.runId, {
        target, resultHash: run.deliveryResultHash, authorConfirmed: confirmed, canShareUploads: sharing,
      });
      if (result.success) {
        setPath(result.data.readerPath);
        setArtifactId(result.data.artifactId);
      }
      else setError(result.error?.message || '归档未完成');
    } finally {
      setBusy(false);
    }
  };
  return <section className="mt-6 grid gap-3 border-t border-subtle pt-4">
    <h3 className="font-semibold">{path ? '已归档' : '确认并归档'}</h3>
    {path ? <div className="grid gap-2 text-sm">
      <Link className="underline" to={path}>打开已归档成品</Link>
      {target === 'web-hosting' && artifactId && <Link className="underline" to={`/web-pages?openSite=${encodeURIComponent(artifactId)}`}>在网页托管查看归档入口</Link>}
    </div> : <>
      <label className="grid gap-1 text-sm">交付去向
        <select className="rounded-lg border border-subtle bg-base px-3 py-2" value={target} onChange={(event) => setTarget(event.currentTarget.value as InformationDeliveryTarget)}>
          <option value="knowledge-base">知识库</option>
          <option value="web-hosting">网页托管</option>
        </select>
      </label>
      <p className="text-xs text-token-secondary">{run.uploadedSources?.length && !sharing
        ? '本次有上传资料。当前设置下只有你能打开成品。'
        : '接收者需有当前知识库和引用来源的访问权限。'}</p>
      {!!run.uploadedSources?.length && <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={sharing}
        onChange={(event) => setSharing(event.currentTarget.checked)} />允许有权读本库和引用来源的人查阅成品及我上传的原文快照</label>}
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={confirmed}
        onChange={(event) => setConfirmed(event.currentTarget.checked)} />我已核对这版成品和来源</label>
      <Button variant="primary" onClick={() => void submit()} disabled={!confirmed || busy}>{busy ? '正在归档' : '归档'}</Button>
      {error && <p role="alert" className="text-sm">{error}</p>}
    </>}
  </section>;
}

export function InformationDeliveryReaderPage() {
  const { storeId = '', runId = '' } = useParams();
  return <InformationDeliveryReader key={`${storeId}:${runId}`} storeId={storeId} runId={runId} />;
}

function InformationDeliveryReader({ storeId, runId }: { storeId: string; runId: string }) {
  const [result, setResult] = useState<InformationDeliveryArchive>();
  const [error, setError] = useState('');
  const [view, setView] = useState<'course' | 'web' | 'sources'>('course');
  useEffect(() => {
    let active = true;
    void readInformationDeliveryArchive(storeId, runId).then((response) => {
      if (!active) return;
      if (response.success) setResult(response.data);
      else setError(response.error?.message || '成品暂时无法打开');
    });
    return () => { active = false; };
  }, [storeId, runId]);
  return <main className="min-h-screen bg-base px-4 py-6 text-token-primary sm:px-8">
    <div className="mx-auto max-w-4xl">
      <Link className="text-sm text-token-secondary underline" to={writingKnowledgeHref(storeId)}>返回知识库</Link>
      {error && <p role="alert" className="mt-4">{error}</p>}
      {!result && !error && <p role="status" className="mt-4">正在读取成品</p>}
      {result && <div className="mt-4">
        <h1 className="text-2xl font-semibold">{result.title || '信息传递'}</h1>
        {!!result.media?.length && <DeliveryMediaPreview storeId={storeId} runId={runId} media={result.media} course={result.course} />}
        <div className="my-4 flex flex-wrap gap-2" aria-label="成品阅读方式">
          <Button aria-pressed={view === 'course'} variant={view === 'course' ? 'primary' : 'secondary'} onClick={() => setView('course')}>按教程阅读</Button>
          <Button aria-pressed={view === 'web'} variant={view === 'web' ? 'primary' : 'secondary'} onClick={() => setView('web')}>浏览网页</Button>
          <Button aria-pressed={view === 'sources'} variant={view === 'sources' ? 'primary' : 'secondary'} onClick={() => setView('sources')}>查看原文</Button>
        </div>
        <section className={cardClass}>
          {view === 'course' && <CoursePreview content={result.course} />}
          {view === 'web' && <DeliveryHtml content={result.html} />}
          {view === 'sources' && <DeliverySources sources={result.sources} />}
        </section>
      </div>}
    </div>
  </main>;
}

function DeliveryMediaPreview({ storeId, runId, media, course }: {
  storeId: string; runId: string; media: InformationDeliveryMedia[]; course?: string;
}) {
  const [selected, setSelected] = useState<InformationDeliveryMedia>();
  const [status, setStatus] = useState('');
  const [url, setUrl] = useState('');
  const [time, setTime] = useState(0);
  const player = useRef<HTMLMediaElement | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const open = async (entry: InformationDeliveryMedia) => {
    const current = ++request.current;
    setUrl('');
    setTime(0);
    setSelected(entry);
    setStatus('正在读取媒体');
    try {
      const result = await downloadInformationDeliveryMedia(storeId, runId, entry.format);
      if (current !== request.current) return;
      setUrl(URL.createObjectURL(result.blob));
      setStatus('');
    } catch (error) {
      if (current === request.current) setStatus(error instanceof Error ? error.message : '无法读取媒体');
    }
  };
  const active = selected?.chapters.reduce((last, chapter, index) =>
    writingMediaTimeReached(time, chapter.start) ? index : last, -1) ?? -1;
  const transcript = course ? parseCourse(course)?.chapters[active] : undefined;
  return <section className="my-4 grid gap-3" aria-label="听讲解或看视频">
    <div className="flex flex-wrap gap-2">{media.map((entry) => <Button key={entry.format} variant="secondary"
      aria-pressed={selected?.format === entry.format} onClick={() => void open(entry)}>
      {entry.format === 'video' ? '打开视频教程' : '打开音频讲解'}
    </Button>)}</div>
    {status && <p role="status" className="text-sm text-token-secondary">{status}</p>}
    {url && (selected?.format === 'video'
      ? <video className="max-h-[60vh] w-full rounded-lg" controls playsInline src={url}
          ref={(element) => { player.current = element; }} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} />
      : <audio className="w-full" controls src={url}
          ref={(element) => { player.current = element; }} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} />)}
    {url && <nav aria-label="讲解章节" className="flex flex-wrap gap-2">
      {selected?.chapters.map((chapter, index) => <Button key={index} variant="secondary" size="sm"
        aria-current={active === index ? 'step' : undefined} onClick={() => {
          if (!player.current) return;
          player.current.currentTime = chapter.start;
          setTime(chapter.start);
        }}>{chapter.title}</Button>)}
    </nav>}
    {url && transcript && <details className="rounded-lg border border-subtle p-3 text-sm">
      <summary className="cursor-pointer">本章讲稿与依据</summary>
      <p className="my-2">{transcript.narration}</p>
      <p className="text-token-secondary">{transcript.basis.join(' · ')}</p>
    </details>}
  </section>;
}

function DeliveryHtml({ content }: { content: string }) {
  return <iframe title="网页预览" className="min-h-[60vh] w-full rounded-lg border border-subtle" sandbox=""
    referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${content}`} />;
}

function DeliverySources({ sources }: { sources: InformationDeliverySource[] }) {
  return <>{sources.map((source, index) => <details key={`${source.kind}-${index}`} className="mt-3 border-t border-subtle pt-3">
    <summary className="cursor-pointer break-words text-sm">{source.title}</summary>
    <p className="mt-2 text-xs text-token-secondary">{source.kind === 'upload' ? '上传文件 · 提取的原文' : '知识库 · 开始生成时的原文'}</p>
    <pre className="mt-2 whitespace-pre-wrap break-words text-sm">{source.content}</pre>
  </details>)}</>;
}

type DeliveryCourse = { openQuestions: string[]; chapters: {
  title: string; narration: string; steps: string[]; basis: string[]; practice?: { question: string; answer: string };
}[] };

function parseCourse(content: string): DeliveryCourse | null {
  try {
    const course = JSON.parse(content);
    if (!course || !Array.isArray(course.chapters) || !Array.isArray(course.openQuestions)) return null;
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return {
      openQuestions: strings(course.openQuestions),
      chapters: course.chapters.flatMap((chapter: { title?: unknown; narration?: unknown; steps?: unknown; basis?: unknown;
        practice?: { question?: unknown; answer?: unknown } } | null) => chapter && typeof chapter.title === 'string' && typeof chapter.narration === 'string'
        ? [{
            title: chapter.title, narration: chapter.narration, steps: strings(chapter.steps), basis: strings(chapter.basis),
            practice: typeof chapter.practice?.question === 'string' && typeof chapter.practice.answer === 'string'
              ? { question: chapter.practice.question, answer: chapter.practice.answer } : undefined,
          }] : []),
    };
  } catch {
    return null;
  }
}

function CoursePreview({ content }: { content: string }) {
  const course = parseCourse(content);
  if (!course) return <p role="status" className="text-sm text-token-secondary">课程文件还在写入，完整后即可阅读</p>;
  return <article className="space-y-5 break-words">
    {course.openQuestions.length > 0 && <section>
      <h3 className="font-semibold">需要作者确认</h3>
      <ul className="ml-5 list-disc space-y-1 text-sm">{course.openQuestions.map((q, index) => <li key={index}>{q}</li>)}</ul>
    </section>}
    {course.chapters.map((chapter, index) => <section key={index}>
      <h3 className="text-lg font-semibold">{chapter.title}</h3>
      <p className="my-2 text-sm leading-relaxed">{chapter.narration}</p>
      <ol className="ml-5 list-decimal text-sm">{chapter.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
      <p className="mt-2 text-xs text-token-secondary">{chapter.basis.join(' · ')}</p>
      {chapter.practice && <section className="mt-3 rounded-lg border border-subtle p-3 text-sm">
        <h4 className="font-medium">试一试</h4>
        <p className="my-2">{chapter.practice.question}</p>
        <details><summary className="cursor-pointer underline">看参考答案</summary><p className="mt-2">{chapter.practice.answer}</p></details>
      </section>}
    </section>)}
  </article>;
}
