import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Trash2, Square } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { createPmGoal } from '@/services';
import { toast } from '@/lib/toast';
import type { PmGoalDraft, PmGoalScope } from '@/services/contracts/pmAgent';

interface Props {
  projectId: string;
  businessGoal: string;
  /** 子目标拆解模式：父目标 id（不传=项目级拆顶层目标） */
  parentGoalId?: string;
  /** 父目标标题（子目标模式展示用） */
  parentTitle?: string;
  /** 创建草稿时的 scope，子目标继承父 scope（默认 team） */
  scope?: PmGoalScope;
  onClose: () => void;
  onCreated: () => void;
}

/**
 * AI 目标拆解面板 —— 依据业务目标（或某个父目标）流式拆解出目标/关键结果草稿。
 * SSE：thinking + typing 实时展示；goal 事件累积草稿。草稿不落库，用户审核/编辑（名称+描述）后确认创建。
 */
export function GoalDecomposePanel({ projectId, businessGoal, parentGoalId, parentTitle, scope, onClose, onCreated }: Props) {
  const isSubGoal = !!parentGoalId;
  const targetScope: PmGoalScope = scope ?? 'team';
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'review'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [thinking, setThinking] = useState('');
  const [typing, setTyping] = useState('');
  const [drafts, setDrafts] = useState<PmGoalDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const start = async () => {
    setPhase('streaming'); setThinking(''); setTyping(''); setDrafts([]); setStageMsg('连接中…');
    const controller = new AbortController();
    abortRef.current = controller;
    const collected: PmGoalDraft[] = [];
    try {
      await connectSse({
        url: api.pm.projects.goalsDecompose(encodeURIComponent(projectId), parentGoalId),
        method: 'POST',
        signal: controller.signal,
        onEvent: (evt) => {
          if (!evt.data) return;
          try {
            const data = JSON.parse(evt.data);
            if (evt.event === 'stage') setStageMsg((data as { message?: string }).message || '');
            else if (evt.event === 'thinking') setThinking((prev) => prev + ((data as { text?: string }).text || ''));
            else if (evt.event === 'typing') setTyping((prev) => prev + ((data as { text?: string }).text || ''));
            else if (evt.event === 'goal') { collected.push(data as PmGoalDraft); setDrafts([...collected]); }
            else if (evt.event === 'error') toast.error('拆解失败', (data as { message?: string }).message || '出错');
            else if (evt.event === 'done') {
              const d = data as { totalNew?: number; error?: string };
              if (!d.error && d.totalNew) toast.success('拆解完成', `生成 ${d.totalNew} 个目标草稿，请审核后创建`);
              else if (!d.totalNew && !d.error) toast.warning('未生成目标', '请补充更具体的业务目标');
            }
          } catch { /* ignore */ }
        },
      });
    } catch { /* aborted or network */ }
    abortRef.current = null;
    setPhase(collected.length > 0 ? 'review' : 'idle');
  };

  const stop = () => { abortRef.current?.abort(); abortRef.current = null; setPhase(drafts.length > 0 ? 'review' : 'idle'); };

  const updateDraft = (i: number, patch: Partial<PmGoalDraft>) => setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  const removeDraft = (i: number) => setDrafts((prev) => prev.filter((_, idx) => idx !== i));

  const confirm = async () => {
    if (drafts.length === 0) return;
    setSaving(true);
    let ok = 0;
    for (const d of drafts) {
      const res = await createPmGoal(projectId, {
        scope: targetScope, parentId: parentGoalId, title: d.title, description: d.description || undefined,
        metric: d.metric || undefined, period: d.period || undefined, progressMode: 'auto', status: 'on_track',
      });
      if (res.success) ok++;
    }
    setSaving(false);
    if (ok > 0) { toast.success('已创建', isSubGoal ? `新增 ${ok} 个子目标` : `新增 ${ok} 个团队目标`); onCreated(); }
    else toast.error('创建失败', '请重试');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={phase === 'streaming' ? undefined : onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 720, height: '86vh', maxHeight: '86vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Sparkles size={17} style={{ color: '#F59E0B' }} />
          <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{isSubGoal ? `AI 拆细：${parentTitle ?? '目标'}` : 'AI 拆解目标'}</div>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div className="text-[12px] rounded-lg px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>
            {isSubGoal ? `上级目标：${parentTitle || '（未命名）'}` : `业务目标：${businessGoal || '（立项未填写）'}`}
          </div>

          {phase === 'idle' && (
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {isSubGoal
                ? '将把上面的上级目标拆解为 2-5 个更具体、更可落地的子目标，生成草稿供你审核（名称 + 描述可改）后创建。'
                : '将依据上面的业务目标，拆解为 3-6 个可量化的目标 / 关键结果（OKR），生成草稿供你审核（名称 + 描述可改）后创建为团队目标。'}
            </div>
          )}

          {phase === 'streaming' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[12px]" style={{ color: '#F59E0B' }}><MapSpinner size={14} /> {stageMsg}</div>
              {thinking && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', maxHeight: 120, overflowY: 'auto' }}><StreamingText text={thinking} streaming mode="blur" /></div>}
              {typing && !thinking && <div className="rounded-lg px-3 py-2 text-[12px] font-mono" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', maxHeight: 120, overflowY: 'auto' }}><StreamingText text={typing} streaming mode="blur" /></div>}
            </div>
          )}

          {drafts.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>目标草稿（{drafts.length}）— 可编辑后创建</div>
              {drafts.map((d, i) => (
                <div key={i} className="group rounded-lg border p-2.5" style={{ background: 'var(--bg-base)', borderColor: 'var(--border-subtle)' }}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <input className="w-full bg-transparent text-[13px] font-medium outline-none" style={{ color: 'var(--text-primary)' }} value={d.title} onChange={(e) => updateDraft(i, { title: e.target.value })} placeholder="目标标题" />
                      <textarea
                        className="w-full mt-1 text-[11px] rounded-md px-2 py-1.5 outline-none border resize-y"
                        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                        rows={2} placeholder="目标描述（可编辑）"
                        value={d.description || ''} onChange={(e) => updateDraft(i, { description: e.target.value })}
                      />
                      <div className="flex items-center gap-3 mt-1.5 flex-wrap text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                        {d.metric && <span className="truncate" style={{ maxWidth: 320 }}>指标：{d.metric}</span>}
                        {d.period && <span>周期：{d.period}</span>}
                      </div>
                    </div>
                    <button onClick={() => removeDraft(i)} className="p-0.5 rounded shrink-0" style={{ color: 'var(--text-muted)' }} title="移除"><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {phase === 'idle' && (<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" onClick={start}><Sparkles size={14} />开始拆解</Button></>)}
          {phase === 'streaming' && <Button variant="secondary" onClick={stop}><Square size={13} />停止</Button>}
          {phase === 'review' && (<><Button variant="ghost" onClick={() => setPhase('idle')}>重新拆解</Button><Button variant="primary" onClick={confirm} disabled={saving || drafts.length === 0}>{saving ? <MapSpinner size={14} /> : null}确认创建 {drafts.length} 个目标</Button></>)}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
