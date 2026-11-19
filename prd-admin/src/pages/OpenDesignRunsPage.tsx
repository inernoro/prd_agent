import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/design/Button';
import { DESIGN_PHASE_LABELS } from '@/components/web-hosting/siteGenerateProgress';
import { InformationDeliveryWorkFile } from '@/pages/document-store/writing/InformationDeliveryPage';
import { useAuthStore } from '@/stores/authStore';
import {
  cancelDesignArtifactRun, getDesignRuntimeCapabilities, listOpenDesignRuns, readInformationDeliveryFiles, readOpenDesignRunEvents,
  type InformationDeliveryFile, type OpenDesignRun, type OpenDesignRunEvent,
} from '@/services/real/webPages';

const refreshMs = 4000;
const panel = 'rounded-xl border border-token-subtle bg-token-card';
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sourceNames: Record<string, string> = { 'knowledge-base': '知识库', 'web-hosting': '网页托管', 'html-ppt': '演示稿', workflow: '工作流' };
const statusNames: Record<string, string> = { queued: '排队中', running: '运行中', committing: '保存中', done: '已完成', error: '失败', cancelled: '已取消' };
const phaseText = (phase?: string | null, code?: string | null) => phase?.trim() || DESIGN_PHASE_LABELS[code ?? ''];
const taskName = (run: OpenDesignRun) => run.title?.trim() || `${sourceNames[run.sourceSurface] ?? '设计'}${run.operation === 'edit' ? '修改' : '生成'}`;
const displayTime = (value?: string | null) => {
  const timestamp = Date.parse(value ?? '');
  return Number.isNaN(timestamp) ? '—' : timeFormat.format(timestamp);
};

export default function OpenDesignRunsPage() {
  const ownerId = useAuthStore((state) => state.user?.userId);
  return <OpenDesignRuns key={ownerId} />;
}

function OpenDesignRuns() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('run');
  const storeId = params.get('store');
  const [runs, setRuns] = useState<OpenDesignRun[]>();
  const [selectedRun, setSelectedRun] = useState<OpenDesignRun | null>();
  const [loadError, setLoadError] = useState('');
  const [service, setService] = useState('正在检查服务');

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async () => {
      const result = await listOpenDesignRuns(selectedId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.success) {
        setRuns(result.data.items);
        setSelectedRun(result.data.selected ?? null);
        setLoadError('');
      } else {
        setLoadError('暂时无法刷新任务状态');
      }
      timer = window.setTimeout(() => void refresh(), refreshMs);
    };
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const result = await getDesignRuntimeCapabilities();
      if (!active) return;
      const capability = result.success ? result.data.runtimes.find((runtime) => runtime.id === 'open-design') : undefined;
      setService(capability ? (capability.healthy && capability.enabled ? '服务可用' : capability.reason || '服务暂不可用') : '服务状态暂不可读');
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const selected = selectedId
    ? runs?.find((run) => run.runId === selectedId) ?? (selectedRun?.runId === selectedId ? selectedRun : undefined)
    : runs?.[0];

  return (
    <main className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto px-4 py-5 text-token-primary sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/web-pages" className="inline-flex items-center gap-1.5 text-sm text-token-secondary hover:underline"><ArrowLeft size={15} />网页托管</Link>
          <h1 className="mt-2 text-2xl font-semibold">OpenDesign 运行</h1>
        </div>
        <p className="max-w-md text-sm text-token-secondary" role="status">{service}</p>
      </header>
      {loadError && <p role="alert" className="text-sm text-token-secondary">{loadError}{runs && '，下方是上一次读到的状态。'}</p>}
      {!runs && !loadError && <p role="status" className="text-sm text-token-secondary">正在读取任务</p>}
      {runs?.length === 0 && <p className={`${panel} p-5 text-sm text-token-secondary`}>当前环境还没有你发起的 OpenDesign 任务。</p>}
      {(!!runs?.length || selected) && (
        <div className="grid items-start gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section className={panel} aria-labelledby="opendesign-run-list">
            <h2 id="opendesign-run-list" className="px-4 py-3 text-sm font-semibold">我的最近任务</h2>
            <ul className="max-h-[30rem] overflow-y-auto">
              {runs?.map((run) => (
                <li key={run.runId} className="border-t border-token-subtle">
                  <button type="button" aria-pressed={selected?.runId === run.runId}
                    className="w-full px-4 py-3 text-left hover:bg-[var(--bg-input)] aria-pressed:bg-[var(--selection-bg)]"
                    onClick={() => setParams((current) => {
                      const next = new URLSearchParams(current);
                      if (next.get('run') !== run.runId) next.delete('store');
                      next.set('run', run.runId);
                      return next;
                    })}>
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0 break-words text-sm font-medium">{taskName(run)}</span>
                    <span className="shrink-0 text-xs text-token-secondary">{run.deliveryWaitingSince ? '等待补答' : statusNames[run.status.toLowerCase()] ?? '状态未知'}</span>
                    </span>
                    <span className="mt-1 block text-xs text-token-secondary">{sourceNames[run.sourceSurface] ?? '设计'} · {displayTime(run.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {selected ? <RunDetails key={selected.runId} run={selected} storeId={storeId} /> : (
            <p className={`${panel} p-5 text-sm text-token-secondary`}>当前账号或环境无法访问这条任务。</p>
          )}
        </div>
      )}
    </main>
  );
}

function RunDetails({ run, storeId }: { run: OpenDesignRun; storeId: string | null }) {
  const [events, setEvents] = useState<OpenDesignRunEvent[]>();
  const [eventsError, setEventsError] = useState(false);
  const cursor = useRef(0);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelStatus, setCancelStatus] = useState('');
  const ongoing = !['done', 'error', 'cancelled'].includes(run.status.toLowerCase());
  const cancellable = ['queued', 'running'].includes(run.status.toLowerCase());
  const deploymentSha = run.deploymentScope?.match(/::revision::([a-f0-9]{7,64})$/i)?.[1];
  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async () => {
      const result = await readOpenDesignRunEvents(run.runId, cursor.current, controller.signal);
      if (controller.signal.aborted) return;
      setEventsError(!result.success);
      if (result.success) {
        cursor.current = result.data.nextSeq;
        setEvents((existing) => {
          const stages = [...(existing ?? [])];
          for (const event of result.data.items) {
            const stage = phaseText(event.phase, event.phaseCode)?.split(' · ')[0];
            const previous = stages.at(-1);
            if (stage && stage !== phaseText(previous?.phase, previous?.phaseCode)?.split(' · ')[0]) stages.push(event);
          }
          return stages;
        });
        if (cursor.current < result.data.lastAvailableSeq && result.data.items.length) {
          timer = window.setTimeout(() => void refresh(), 0);
          return;
        }
      }
      if (ongoing) timer = window.setTimeout(() => void refresh(), refreshMs);
    };
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [ongoing, run.runId]);

  const originStore = run.deliveryOriginStoreId || storeId;
  const resultLink = run.deliveryStoreId ? `/document-store/${encodeURIComponent(run.deliveryStoreId)}/delivery/${encodeURIComponent(run.runId)}/read`
    : run.producedArtifactSiteId ? `/web-pages?openSite=${encodeURIComponent(run.producedArtifactSiteId)}` : null;
  return (
    <section className={`${panel} space-y-4 p-4 sm:p-5`} aria-label="任务详情">
      <header>
        <h2 className="break-words text-lg font-semibold">{taskName(run)}</h2>
        <p role="status" className="mt-1 text-sm text-token-secondary">{phaseText(run.phase, run.phaseCode) || statusNames[run.status.toLowerCase()]}</p>
      </header>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-token-secondary">任务编号</dt><dd className="break-all font-mono text-xs">{run.runId}</dd></div>
        <div><dt className="text-xs text-token-secondary">实际模型</dt><dd className="break-words">{run.resolvedModel ? [run.resolvedModel, run.resolvedPlatform].filter(Boolean).join(' · ') : '尚未读取'}</dd></div>
        <div><dt className="text-xs text-token-secondary">首次预览</dt><dd>{displayTime(run.firstPreviewAt)}</dd></div>
        <div><dt className="text-xs text-token-secondary">最新进展</dt><dd>{displayTime(run.completedAt || run.lastProgressAt)}</dd></div>
        {run.workspaceId && <div><dt className="text-xs text-token-secondary">工作区编号</dt><dd className="break-all font-mono text-xs">{run.workspaceId}</dd></div>}
        {run.deliveryRuntimeSessionId && <div><dt className="text-xs text-token-secondary">CDS 会话</dt><dd className="break-all font-mono text-xs">{run.deliveryRuntimeSessionId}</dd></div>}
        {deploymentSha && <div><dt className="text-xs text-token-secondary">任务所属版本</dt><dd title={deploymentSha} className="font-mono text-xs">{deploymentSha.slice(0, 12)}</dd></div>}
        {run.failureCode && <div><dt className="text-xs text-token-secondary">失败代码</dt><dd className="break-all">{run.failureCode}</dd></div>}
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {resultLink && <Link to={resultLink} className="inline-flex items-center gap-1 underline">打开成品<ArrowUpRight size={14} /></Link>}
        {run.sourceSurface === 'knowledge-base' && originStore && (
          <Link to={`/document-store/${encodeURIComponent(originStore)}/delivery?run=${encodeURIComponent(run.runId)}`} className="underline">打开信息传递任务</Link>
        )}
        {cancellable && !cancelOpen && !cancelPending && <Button variant="ghost" size="sm" onClick={() => setCancelOpen(true)}>取消任务</Button>}
      </div>
      {cancellable && cancelOpen && <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="确认取消任务">
        <Button variant="secondary" size="sm" disabled={cancelPending} onClick={() => setCancelOpen(false)}>继续生成</Button>
        <Button variant="ghost" size="sm" disabled={cancelPending} onClick={async () => {
          setCancelPending(true);
          const result = await cancelDesignArtifactRun(run.runId);
          setCancelPending(false);
          setCancelOpen(false);
          setCancelStatus(result.success ? '取消请求已提交，等待工作区确认。' : result.error?.message || '暂时无法取消任务');
        }}>{cancelPending ? '正在取消' : '确认取消'}</Button>
      </div>}
      {cancelStatus && <p role="status" className="text-sm text-token-secondary">{cancelStatus}</p>}
      {run.hasDeliveryWorkspace && <WorkFiles runId={run.runId} ongoing={ongoing}
        checkpointHash={run.deliveryCheckpointHash} waiting={!!run.deliveryWaitingSince} />}
      <div className="border-t border-token-subtle pt-3">
        <h3 className="text-sm font-semibold">执行记录</h3>
        {eventsError && <p className="mt-2 text-sm text-token-secondary" role="alert">暂时无法读取执行记录</p>}
        {!events && !eventsError && <p className="mt-2 text-sm text-token-secondary">正在读取执行记录</p>}
        {events?.length === 0 && !eventsError && <p className="mt-2 text-sm text-token-secondary">任务尚未写入执行事件。</p>}
        {!!events?.length && <ol className="mt-2 space-y-2 text-sm">{events.map((event) => (
          <li key={event.sequence} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
            <time dateTime={event.occurredAt} className="text-xs tabular-nums text-token-secondary">{displayTime(event.occurredAt)}</time>
            <span className="break-words">{phaseText(event.phase, event.phaseCode)}</span>
          </li>
        ))}</ol>}
      </div>
    </section>
  );
}

function WorkFiles({ runId, ongoing, checkpointHash, waiting }: {
  runId: string; ongoing: boolean; checkpointHash?: string | null; waiting: boolean;
}) {
  const [files, setFiles] = useState<InformationDeliveryFile[]>();
  const [path, setPath] = useState<string>();
  const [showCheckpoint, setShowCheckpoint] = useState(false);
  const [opened, setOpened] = useState<{ path: string; content: string }>();
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async () => {
      const result = await readInformationDeliveryFiles(runId, path, controller.signal, showCheckpoint);
      if (controller.signal.aborted) return;
      if (result.success) {
        setFiles(result.data.files);
        setOpened(path && result.data.content ? { path, content: result.data.content } : undefined);
        setError('');
      } else {
        setFiles(undefined);
        setOpened(undefined);
        setError(result.error?.message || '工作区文件暂不可读');
      }
      timer = window.setTimeout(() => void refresh(), ongoing ? refreshMs : 15_000);
    };
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [runId, path, ongoing, showCheckpoint, waiting, checkpointHash]);

  return <section className="space-y-2 border-t border-token-subtle pt-3" aria-label="工作区文件">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">工作区文件</h3>
      {checkpointHash && !waiting && <Button variant="ghost" size="sm" aria-pressed={showCheckpoint} onClick={() => {
        setOpened(undefined);
        setShowCheckpoint((current) => !current);
      }}>{showCheckpoint ? '返回当前文件' : '查看已保存草稿'}</Button>}
    </div>
    {checkpointHash && (waiting || showCheckpoint) && <p className="break-all text-xs text-token-secondary">
      草稿版本 <span title={checkpointHash} className="font-mono">{checkpointHash.slice(0, 12)}</span>
    </p>}
    {error && <p role="alert" className="text-sm text-token-secondary">{error}</p>}
    {!error && !files && <p className="text-sm text-token-secondary">正在读取工作区文件</p>}
    {files?.length === 0 && <p className="text-sm text-token-secondary">{ongoing ? '写出首个文件后可预览。' : '任务没有可读取的文件。'}</p>}
    {!!files?.length && <div className="flex flex-wrap gap-2">{files.map((file) => <Button key={file.path} variant="secondary" size="sm"
      aria-pressed={path === file.path} onClick={() => setPath(file.path)}>
      {file.path === 'index.html' ? '网页预览' : '教程与依据'}{file.draft && ' · 草稿'}
    </Button>)}</div>}
    {path && opened?.path === path && <InformationDeliveryWorkFile path={path} content={opened.content} />}
  </section>;
}
