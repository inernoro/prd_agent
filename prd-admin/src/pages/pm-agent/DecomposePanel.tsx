import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Trash2, Square } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { batchCreatePmTasks } from '@/services';
import { toast } from '@/lib/toast';
import type { PmTaskDraft, PmTaskPriority } from '@/services/contracts/pmAgent';
import { PRIORITY_REGISTRY } from './pmConstants';

interface Props {
  projectId: string;
  businessGoal: string;
  onClose: () => void;
  onCreated: () => void;
}

const PRIORITIES: PmTaskPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

/**
 * AI 需求拆解面板（核心杀手锏）。
 * SSE 流式：thinking + typing 实时展示（禁止空白等待），task 事件累积草稿。
 * AI 提案不直接落库 —— 用户审核/编辑/删除后，确认才批量创建。
 */
export function DecomposePanel({ projectId, businessGoal, onClose, onCreated }: Props) {
  const [requirement, setRequirement] = useState('');
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'review'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [thinking, setThinking] = useState('');
  const [typing, setTyping] = useState('');
  const [drafts, setDrafts] = useState<PmTaskDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const start = async () => {
    setPhase('streaming');
    setThinking('');
    setTyping('');
    setDrafts([]);
    setStageMsg('连接中…');
    const controller = new AbortController();
    abortRef.current = controller;
    const collected: PmTaskDraft[] = [];
    try {
      await connectSse({
        url: api.pm.projects.decompose(encodeURIComponent(projectId)),
        method: 'POST',
        body: requirement.trim() ? { requirementText: requirement.trim() } : undefined,
        signal: controller.signal,
        onEvent: (evt) => {
          if (!evt.data) return;
          try {
            const data = JSON.parse(evt.data);
            if (evt.event === 'stage') setStageMsg((data as { message?: string }).message || '');
            else if (evt.event === 'thinking') setThinking((prev) => prev + ((data as { text?: string }).text || ''));
            else if (evt.event === 'typing') setTyping((prev) => prev + ((data as { text?: string }).text || ''));
            else if (evt.event === 'task') { collected.push(data as PmTaskDraft); setDrafts([...collected]); }
            else if (evt.event === 'error') toast.error('拆解失败', (data as { message?: string }).message || '出错');
            else if (evt.event === 'done') {
              const d = data as { totalNew?: number; error?: string };
              if (!d.error && d.totalNew) toast.success('拆解完成', `生成 ${d.totalNew} 个任务草稿，请审核后创建`);
              else if (!d.totalNew && !d.error) toast.warning('未生成任务', '请补充更具体的业务目标或需求材料');
            }
          } catch { /* ignore */ }
        },
      });
    } catch { /* aborted or network */ }
    abortRef.current = null;
    setPhase(collected.length > 0 ? 'review' : 'idle');
  };

  const stop = () => { abortRef.current?.abort(); abortRef.current = null; setPhase(drafts.length > 0 ? 'review' : 'idle'); };

  const updateDraft = (i: number, patch: Partial<PmTaskDraft>) => {
    setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  };
  const removeDraft = (i: number) => setDrafts((prev) => prev.filter((_, idx) => idx !== i));

  const confirm = async () => {
    if (drafts.length === 0) return;
    setSaving(true);
    const res = await batchCreatePmTasks(projectId, {
      tasks: drafts.map((d) => ({
        title: d.title,
        description: d.description,
        priority: d.priority,
        estimateDays: d.estimateDays,
        dependsOnTitles: d.dependsOnTitles,
        sourceRef: d.sourceRef,
        labels: d.labels,
      })),
    });
    setSaving(false);
    if (res.success) {
      toast.success('已创建', `新增 ${res.data.count} 个任务`);
      onCreated();
    } else {
      toast.error('创建失败', res.error?.message || '');
    }
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={phase === 'streaming' ? undefined : onClose}>
      <div
        className="rounded-xl border flex flex-col w-full"
        style={{ maxWidth: 720, height: '86vh', maxHeight: '86vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Sparkles size={17} style={{ color: '#A855F7' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>AI 需求拆解</div>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div className="text-[12px] rounded-lg px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>
            业务目标：{businessGoal}
          </div>

          {phase === 'idle' && (
            <>
              <label className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>需求文档 / 补充材料（可选，粘贴更详细的需求让拆解更准）</label>
              <textarea
                className="w-full rounded-lg px-3 py-2 text-[13px] outline-none border"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', minHeight: 120, resize: 'vertical' }}
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                placeholder="可粘贴 PRD / 需求清单 / 范围说明…（留空则仅依据业务目标拆解）"
              />
            </>
          )}

          {phase === 'streaming' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12px]" style={{ color: '#A855F7' }}>
                <MapSpinner size={14} /> {stageMsg}
              </div>
              {thinking && (
                <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', maxHeight: 120, overflowY: 'auto' }}>
                  <StreamingText text={thinking} streaming mode="blur" />
                </div>
              )}
              {typing && !thinking && (
                <div className="rounded-lg px-3 py-2 text-[12px] font-mono" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', maxHeight: 120, overflowY: 'auto' }}>
                  <StreamingText text={typing} streaming mode="blur" />
                </div>
              )}
            </div>
          )}

          {/* 草稿列表（streaming 中已陆续出现 + review 阶段可编辑）*/}
          {drafts.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>任务草稿（{drafts.length}）— 可编辑后创建</div>
              {drafts.map((d, i) => {
                const p = PRIORITY_REGISTRY[d.priority];
                return (
                  <div key={i} className="group rounded-lg border p-2.5" style={{ background: 'var(--bg-base)', borderColor: 'var(--border-subtle)' }}>
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <input
                          className="w-full bg-transparent text-[13px] font-medium outline-none"
                          style={{ color: 'var(--text-primary)' }}
                          value={d.title}
                          onChange={(e) => updateDraft(i, { title: e.target.value })}
                        />
                        {d.description && <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{d.description}</div>}
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <select
                            className="text-[10px] rounded px-1 py-0.5 outline-none border"
                            style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: p.color }}
                            value={d.priority}
                            onChange={(e) => updateDraft(i, { priority: e.target.value as PmTaskPriority })}
                          >
                            {PRIORITIES.map((pr) => <option key={pr} value={pr}>{PRIORITY_REGISTRY[pr].label}</option>)}
                          </select>
                          {d.estimateDays != null && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{d.estimateDays}人天</span>}
                          {d.dependsOnTitles.length > 0 && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>依赖 {d.dependsOnTitles.length} 项</span>}
                          {d.sourceRef && <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)', maxWidth: 240 }} title={d.sourceRef}>{d.sourceRef}</span>}
                        </div>
                      </div>
                      <button onClick={() => removeDraft(i)} className="p-0.5 rounded shrink-0" style={{ color: 'var(--text-muted)' }} title="移除"><Trash2 size={13} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {phase === 'idle' && (
            <>
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button variant="primary" onClick={start}><Sparkles size={14} />开始拆解</Button>
            </>
          )}
          {phase === 'streaming' && (
            <Button variant="secondary" onClick={stop}><Square size={13} />停止</Button>
          )}
          {phase === 'review' && (
            <>
              <Button variant="ghost" onClick={() => setPhase('idle')}>重新拆解</Button>
              <Button variant="primary" onClick={confirm} disabled={saving || drafts.length === 0}>
                {saving ? <MapSpinner size={14} /> : null}
                确认创建 {drafts.length} 个任务
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
