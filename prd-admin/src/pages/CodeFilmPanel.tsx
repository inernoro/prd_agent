import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { ApiDownloadError } from '@/services/real/apiClient';
import {
  createCodeFilm, downloadCodeFilm, getCodeFilmAvailability, listCodeFilms, saveCodeFilm, type CodeFilmRun,
} from '@/services/real/codeFilms';
import { listDesignModelOptions, type DesignModelOption } from '@/services/real/webPages';

const defaultInstruction = '用视觉笔记风格把这份原文做成一支片子。';
const activeStatuses = new Set(['queued', 'running', 'committing']);

export function CodeFilmPanel({ onSaved, onShare }: {
  onSaved: () => void;
  onShare: (siteId: string) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [instruction, setInstruction] = useState('');
  const [models, setModels] = useState<DesignModelOption[]>([]);
  const [model, setModel] = useState('');
  const [runs, setRuns] = useState<CodeFilmRun[]>([]);
  const [runId, setRunId] = useState('');
  const [historyReady, setHistoryReady] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [video, setVideo] = useState<{ runId: string; url: string } | null>(null);
  const [saved, setSaved] = useState<{ runId: string; siteId: string } | null>(null);
  const busyRef = useRef(false);
  const run = runs.find((item) => item.runId === runId);
  const preview = video?.runId === runId ? video : null;
  const savedSite = saved?.runId === runId ? saved.siteId : null;

  useEffect(() => {
    let disposed = false;
    void getCodeFilmAvailability().then((result) => {
      if (!disposed && result.success) setEnabled(result.data.codeFilmEnabled === true);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const result = await listCodeFilms();
        if (disposed) return;
        setHistoryError(!result.success);
        if (result.success) {
          setRuns(result.data.items);
          setRunId((current) => current || result.data.items[0]?.runId || '');
        }
      } catch {
        if (!disposed) setHistoryError(true);
      } finally {
        if (!disposed) {
          setHistoryReady(true);
          timer = window.setTimeout(() => void refresh(), 5000);
        }
      }
    };
    setHistoryReady(false);
    void refresh();
    void listDesignModelOptions('generate').then((result) => {
      if (!disposed && result.success) setModels(result.data.items);
    }).catch(() => {});
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!video) return;
    return () => URL.revokeObjectURL(video.url);
  }, [video]);

  async function perform(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setNotice('');
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiDownloadError && error.status === 404) {
        setNotice('这条任务目前没有可取回的成片，请稍后查看。');
      } else {
        setNotice(error instanceof Error ? error.message : '操作未完成，请稍后重试。');
      }
    } finally {
      busyRef.current = false;
      setBusy('');
    }
  }

  async function generate() {
    if (!file || !/\.md$/i.test(file.name)) {
      setNotice('请选择一份 .md 原文。');
      return;
    }
    await perform('正在上传原文并提交任务', async () => {
      const attachment = await uploadAttachment(file);
      if (!attachment.success) throw new Error(attachment.error?.message || '原文上传失败。');
      const result = await createCodeFilm({
        attachmentId: attachment.data.attachmentId,
        instruction: instruction.trim() ? instruction : defaultInstruction,
        modelOptionId: model || undefined,
      });
      if (!result.success) throw new Error(result.error?.message || '提交结果暂不可用，请先查看最近任务。');
      setRuns((items) => [result.data, ...items.filter((item) => item.runId !== result.data.runId)]);
      setRunId(result.data.runId);
      setVideo(null);
      setNotice('任务已提交，关闭面板后仍可从最近任务打开。');
    });
  }

  function loadVideo(selectedRunId: string) {
    return perform('正在取回成片', async () => {
      const result = await downloadCodeFilm(selectedRunId);
      if (result.blob.type !== 'video/mp4' && !result.contentType.startsWith('video/mp4')) {
        throw new Error('影片格式异常，请稍后重新取回。');
      }
      setVideo({ runId: selectedRunId, url: URL.createObjectURL(result.blob) });
    });
  }

  function save(selectedRunId: string) {
    return perform('正在保存到网页托管', async () => {
      const result = await saveCodeFilm(selectedRunId);
      if (!result.success) throw new Error(result.error?.message || '保存失败，请稍后重试。');
      setSaved({ runId: selectedRunId, siteId: result.data.siteId });
      setNotice('已保存到网页托管的个人空间。');
      onSaved();
    });
  }

  if (!enabled) return null;

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>快速创作</Button>
      <Dialog
        open={open}
        onOpenChange={(visible) => {
          setOpen(visible);
          if (!visible) setVideo(null);
        }}
        title="快速创作 · 代码视频"
        maxWidth={720}
        content={(
          <div className="grid gap-4 text-sm">
            <div className="rounded border border-[var(--border-subtle)] p-3">
              <p className="font-medium">视觉笔记</p>
              <p className="mt-1">把 Markdown 文档做成带配音的讲解短片。</p>
            </div>
            <label className="grid gap-1">
              原文（Markdown）
              <input type="file" accept=".md,text/markdown" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              {file && <span>已选择 {file.name}</span>}
            </label>
            <label className="grid gap-1">
              创作要求（可选）
              <textarea className="rounded border border-[var(--border-subtle)] bg-transparent p-2" rows={2}
                value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={defaultInstruction} />
            </label>
            <label className="grid gap-1">
              模型
              <select className="rounded border border-[var(--border-subtle)] bg-transparent p-2"
                value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">使用默认模型</option>
                {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <div>
              <Button size="sm" disabled={!file || Boolean(busy)} onClick={() => void generate()}>生成视频</Button>
            </div>
            <label className="grid gap-1">
              最近任务
              <select className="rounded border border-[var(--border-subtle)] bg-transparent p-2"
                disabled={!runs.length || Boolean(busy)} value={runId} onChange={(event) => {
                  setRunId(event.target.value);
                  setVideo(null);
                  setNotice('');
                }}>
                {!runs.length && <option value="">{historyReady ? '暂无任务' : '正在读取任务'}</option>}
                {runs.map((item) => <option key={item.runId} value={item.runId}>{item.title || item.runId}</option>)}
              </select>
            </label>
            {historyError && <p role="status">任务状态暂时连不上，正在重新连接。</p>}
            {run && (
              <div className="grid gap-2" aria-label="任务进度">
                <p role="status">{run.phase}{run.resolvedModel ? ` · ${run.resolvedModel}` : ''}</p>
                {activeStatuses.has(run.status.toLowerCase()) && <progress max={100} value={Math.min(100, Math.max(0, run.progress))} />}
                {run.error && <p role="alert">{run.error}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void loadVideo(run.runId)}>预览或取回成片</Button>
                  <Button size="sm" variant="secondary" disabled={!preview || Boolean(busy)} onClick={() => void save(run.runId)}>保存到网页托管</Button>
                  {preview && <a className="self-center underline" href={preview.url} download="视觉笔记.mp4">下载 MP4</a>}
                  {savedSite && <Button size="sm" variant="secondary" onClick={() => { setOpen(false); onShare(savedSite); }}>打开分享设置</Button>}
                </div>
                {preview && <video className="w-full" aria-label="生成视频预览" src={preview.url} controls playsInline preload="metadata" />}
              </div>
            )}
            {(busy || notice) && <p role="status">{busy || notice}</p>}
          </div>
        )}
      />
    </>
  );
}
