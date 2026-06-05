import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Trash2, Square, CircleCheck, Milestone as MilestoneIcon } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { createPmMilestone } from '@/services';
import { toast } from '@/lib/toast';
import type { PmMilestoneDraft } from '@/services/contracts/pmAgent';

interface Props {
  projectId: string;
  businessGoal: string;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * AI 里程碑建议 —— 依据目标/任务/计划周期流式规划分阶段里程碑草稿。
 * SSE：thinking + typing 实时展示；milestone 事件累积草稿。草稿可编辑(名称/说明/日期)后批量创建，
 * 可选「按顺序串联前置依赖」让相邻里程碑形成依赖链。
 */
export function MilestoneSuggestPanel({ projectId, businessGoal, onClose, onCreated }: Props) {
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'review'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [thinking, setThinking] = useState('');
  const [typing, setTyping] = useState('');
  const [drafts, setDrafts] = useState<PmMilestoneDraft[]>([]);
  const [chain, setChain] = useState(true);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const start = async () => {
    setPhase('streaming'); setThinking(''); setTyping(''); setDrafts([]); setStageMsg('连接中…');
    const controller = new AbortController();
    abortRef.current = controller;
    const collected: PmMilestoneDraft[] = [];
    try {
      await connectSse({
        url: api.pm.projects.milestonesSuggest(encodeURIComponent(projectId)),
        method: 'POST',
        signal: controller.signal,
        onEvent: (evt) => {
          if (!evt.data) return;
          try {
            const data = JSON.parse(evt.data);
            if (evt.event === 'stage') setStageMsg((data as { message?: string }).message || '');
            else if (evt.event === 'thinking') setThinking((p) => p + ((data as { text?: string }).text || ''));
            else if (evt.event === 'typing') setTyping((p) => p + ((data as { text?: string }).text || ''));
            else if (evt.event === 'milestone') { collected.push(data as PmMilestoneDraft); setDrafts([...collected]); }
            else if (evt.event === 'error') toast.error('建议失败', (data as { message?: string }).message || '出错');
            else if (evt.event === 'done') {
              const d = data as { totalNew?: number; error?: string };
              if (!d.error && d.totalNew) toast.success('规划完成', `生成 ${d.totalNew} 个里程碑草稿，请审核后创建`);
              else if (!d.totalNew && !d.error) toast.warning('未生成里程碑', '请补充更具体的目标/任务');
            }
          } catch { /* ignore */ }
        },
      });
    } catch { /* aborted / network */ }
    abortRef.current = null;
    setPhase(collected.length > 0 ? 'review' : 'idle');
  };

  const stop = () => { abortRef.current?.abort(); abortRef.current = null; setPhase(drafts.length > 0 ? 'review' : 'idle'); };

  const updateDraft = (i: number, patch: Partial<PmMilestoneDraft>) => setDrafts((p) => p.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  const removeDraft = (i: number) => setDrafts((p) => p.filter((_, idx) => idx !== i));
  const removeCriterion = (i: number, ci: number) => setDrafts((p) => p.map((d, idx) => idx === i ? { ...d, acceptanceCriteria: (d.acceptanceCriteria ?? []).filter((_, x) => x !== ci) } : d));

  const confirm = async () => {
    if (drafts.length === 0) return;
    setSaving(true);
    let ok = 0;
    let prevId: string | null = null;
    for (const d of drafts) {
      const res = await createPmMilestone(projectId, {
        title: d.title,
        description: d.description || undefined,
        dueAt: d.dueDate || undefined,
        acceptanceCriteria: (d.acceptanceCriteria ?? []).filter((t) => t.trim()).map((t) => ({ text: t.trim(), done: false })),
        dependsOn: chain && prevId ? [prevId] : undefined,
      });
      if (res.success) { ok++; prevId = res.data.id; }
    }
    setSaving(false);
    if (ok > 0) { toast.success('已创建', `新增 ${ok} 个里程碑${chain ? '（已串联依赖）' : ''}`); onCreated(); }
    else toast.error('创建失败', '请重试');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={phase === 'streaming' ? undefined : onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 720, height: '86vh', maxHeight: '86vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Sparkles size={17} style={{ color: '#A855F7' }} />
          <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>AI 里程碑建议</div>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div className="text-[12px] rounded-lg px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>业务目标：{businessGoal || '（立项未填写）'}</div>

          {phase === 'idle' && (
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              将依据项目业务目标、团队目标、任务主题与计划周期，规划 4-8 个分阶段里程碑（含验收标准与建议日期），生成草稿供你审核后批量创建。
            </div>
          )}

          {phase === 'streaming' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12px]" style={{ color: '#A855F7' }}><MapSpinner size={14} /> {stageMsg}</div>
              {thinking && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', maxHeight: 120, overflowY: 'auto' }}><StreamingText text={thinking} streaming mode="blur" /></div>}
              {typing && !thinking && <div className="rounded-lg px-3 py-2 text-[12px] font-mono" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', maxHeight: 120, overflowY: 'auto' }}><StreamingText text={typing} streaming mode="blur" /></div>}
            </div>
          )}

          {drafts.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>里程碑草稿（{drafts.length}）— 可编辑后创建</div>
              {drafts.map((d, i) => (
                <div key={i} className="group rounded-lg border p-2.5" style={{ background: 'var(--bg-base)', borderColor: 'var(--border-subtle)' }}>
                  <div className="flex items-start gap-2">
                    <span className="mt-1 w-5 h-5 rounded shrink-0 flex items-center justify-center" style={{ background: 'rgba(168,85,247,0.14)' }}><MilestoneIcon size={12} style={{ color: '#A855F7' }} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <input className="flex-1 bg-transparent text-[13px] font-medium outline-none" style={{ color: 'var(--text-primary)' }} value={d.title} onChange={(e) => updateDraft(i, { title: e.target.value })} placeholder="里程碑名称" />
                        <input type="date" className="text-[11px] rounded-md px-1.5 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                          value={d.dueDate ? d.dueDate.slice(0, 10) : ''} onChange={(e) => updateDraft(i, { dueDate: e.target.value })} />
                      </div>
                      <textarea className="w-full mt-1 text-[11px] rounded-md px-2 py-1.5 outline-none border resize-y" rows={2} placeholder="里程碑说明（可编辑）"
                        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                        value={d.description || ''} onChange={(e) => updateDraft(i, { description: e.target.value })} />
                      {(d.acceptanceCriteria?.length ?? 0) > 0 && (
                        <div className="flex flex-col gap-0.5 mt-1.5">
                          {(d.acceptanceCriteria ?? []).map((c, ci) => (
                            <div key={ci} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              <CircleCheck size={10} style={{ color: '#10B981' }} />
                              <span className="truncate flex-1">{c}</span>
                              <button onClick={() => removeCriterion(i, ci)} style={{ color: 'var(--text-muted)' }}><X size={10} /></button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <button onClick={() => removeDraft(i)} className="p-0.5 rounded shrink-0" style={{ color: 'var(--text-muted)' }} title="移除"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {phase === 'review' && (
            <label className="flex items-center gap-1.5 text-[11.5px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={chain} onChange={(e) => setChain(e.target.checked)} />按顺序串联前置依赖
            </label>
          )}
          <div className="ml-auto flex items-center gap-2">
            {phase === 'idle' && (<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" onClick={start}><Sparkles size={14} />开始规划</Button></>)}
            {phase === 'streaming' && <Button variant="secondary" onClick={stop}><Square size={13} />停止</Button>}
            {phase === 'review' && (<><Button variant="ghost" onClick={() => setPhase('idle')}>重新规划</Button><Button variant="primary" onClick={confirm} disabled={saving || drafts.length === 0}>{saving ? <MapSpinner size={14} /> : null}确认创建 {drafts.length} 个里程碑</Button></>)}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
