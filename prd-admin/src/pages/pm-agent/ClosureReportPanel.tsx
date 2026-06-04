import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Square, Save, Eye, Pencil } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { connectSse } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { getPmKnowledgeStore, addDocumentEntry, updateDocumentContent } from '@/services';
import { toast } from '@/lib/toast';

interface Props {
  projectId: string;
  projectNo: string;
  onClose: () => void;
}

/**
 * AI 结案报告 —— SSE 流式生成 Markdown 结案报告（基于项目执行数据），
 * 用户审核/编辑后保存到项目知识库（DocumentEntry，metadata kind=closure-report）。
 */
export function ClosureReportPanel({ projectId, projectNo, onClose }: Props) {
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'review'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [thinking, setThinking] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const start = async () => {
    setPhase('streaming'); setThinking(''); setContent(''); setStageMsg('连接中…'); setPreviewMode(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      await connectSse({
        url: api.pm.projects.closureReport(encodeURIComponent(projectId)),
        method: 'POST',
        signal: controller.signal,
        onEvent: (evt) => {
          if (!evt.data) return;
          try {
            const data = JSON.parse(evt.data);
            if (evt.event === 'stage') setStageMsg((data as { message?: string }).message || '');
            else if (evt.event === 'thinking') setThinking((p) => p + ((data as { text?: string }).text || ''));
            else if (evt.event === 'typing') { acc += (data as { text?: string }).text || ''; setContent(acc); }
            else if (evt.event === 'error') toast.error('生成失败', (data as { message?: string }).message || '');
          } catch { /* ignore */ }
        },
      });
    } catch { /* aborted / network */ }
    abortRef.current = null;
    setPhase(acc.trim() ? 'review' : 'idle');
  };

  const stop = () => { abortRef.current?.abort(); abortRef.current = null; setPhase(content.trim() ? 'review' : 'idle'); };

  const save = async () => {
    if (!content.trim()) return;
    setSaving(true);
    const sr = await getPmKnowledgeStore(projectId);
    if (!sr.success) { setSaving(false); toast.error('保存失败', '无法解析项目知识库'); return; }
    const er = await addDocumentEntry(sr.data.storeId, { title: `结案报告 · ${projectNo}`, sourceType: 'import', contentType: 'text/markdown', summary: content.slice(0, 200) });
    if (!er.success) { setSaving(false); toast.error('保存失败', er.error?.message || ''); return; }
    const cr = await updateDocumentContent(er.data.id, content);
    setSaving(false);
    if (cr.success) { toast.success('已保存到项目知识库', '可在「资料 → 知识库」查看与编辑'); onClose(); }
    else toast.error('正文保存失败', cr.error?.message || '');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={phase === 'streaming' ? undefined : onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 820, height: '88vh', maxHeight: '88vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Sparkles size={17} style={{ color: '#F59E0B' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>AI 结案报告</div>
          {phase === 'review' && (
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => setPreviewMode((v) => !v)}>{previewMode ? <Pencil size={12} /> : <Eye size={12} />}{previewMode ? '编辑' : '预览'}</Button>
          )}
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {phase === 'idle' && (
            <div className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              将汇总本项目的目标达成、里程碑、任务完成、成本、NPSS 评价、风险与关键决策，生成结案报告草稿。生成后可编辑，再保存到「资料 → 知识库」。
            </div>
          )}

          {phase === 'streaming' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12px]" style={{ color: '#F59E0B' }}><MapSpinner size={14} /> {stageMsg}</div>
              {thinking && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', maxHeight: 140, overflowY: 'auto' }}><StreamingText text={thinking} streaming mode="blur" /></div>}
              {content && <div className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}><StreamingText text={content} streaming mode="blur" /></div>}
            </div>
          )}

          {phase === 'review' && (
            previewMode
              ? <MarkdownContent content={content} variant="reading" />
              : <textarea value={content} onChange={(e) => setContent(e.target.value)} className="flex-1 min-h-0 resize-none outline-none px-3 py-2 text-[13px] font-mono leading-relaxed rounded-md border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', minHeight: 360 }} />
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {phase === 'idle' && (<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" onClick={start}><Sparkles size={14} />开始生成</Button></>)}
          {phase === 'streaming' && <Button variant="secondary" onClick={stop}><Square size={13} />停止</Button>}
          {phase === 'review' && (<><Button variant="ghost" onClick={start}>重新生成</Button><Button variant="primary" onClick={save} disabled={saving || !content.trim()}>{saving ? <MapSpinner size={14} /> : <Save size={14} />}保存到知识库</Button></>)}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
