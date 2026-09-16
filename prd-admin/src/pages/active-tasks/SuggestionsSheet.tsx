/**
 * 建议收件箱 + 吸取。
 *
 * 建议和派活是两码事：派活是别人替你决定了你要做什么，直接进你的队列；
 * 建议提了**什么都不会发生**，它躺在这儿等你自己吸取。
 * 默认态是「什么都没发生」，吸取才是那个要花力气的动作 —— 力气花在「我决定要做」这一侧才对。
 *
 * 吸取 = 系统提示词 + 可选引用几个知识库（服务端记着你上次选的）+ 可选你补的一句要求，
 * 流式吐出整理好的任务，逐条勾选后建进自己的队列。
 *
 * 也能把一条建议拿去涌现：那条建议当种子建一棵涌现树，用来派生更多可能，
 * 而不是当场变成一条待办。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useSseStream } from '@/lib/useSseStream';
import {
  ACTIVE_TASK_ABSORB_STREAM, createActiveTask, dismissSuggestion,
  getKnowledgeStores, getSuggestionInbox, linkSuggestionEmergence, markSuggestionsAbsorbed,
} from '@/services/real/activeTasks';
import { createEmergenceTreeReal } from '@/services/real/emergence';
import type { DraftTask, KnowledgeStoreRef, TaskSuggestion } from '@/services/contracts/activeTasks';
import { TaskSheet } from './TaskSheet';
import { DraftTaskList, type DraftRow } from './DraftTaskList';
import { whenLabel } from './taskTime';

export interface SuggestionsSheetProps {
  onClose: () => void;
  onCreated: () => void;
}

export function SuggestionsSheet({ onClose, onCreated }: SuggestionsSheetProps) {
  const nav = useNavigate();
  const [items, setItems] = useState<TaskSuggestion[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [stores, setStores] = useState<KnowledgeStoreRef[]>([]);
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [rows, setRows] = useState<DraftRow[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const seq = useRef(0);
  /** 已经建成的任务 id —— 跨重试累积，否则重试那趟会把上一趟建成的来源链接丢掉 */
  const doneIds = useRef<string[]>([]);
  /** 已经建成的那几行的 key —— 重试时跳过它们，否则会把已进队列的任务重复建一遍 */
  const builtKeys = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [inbox, ks] = await Promise.all([getSuggestionInbox(), getKnowledgeStores()]);
    if (inbox.success && inbox.data) {
      setItems(inbox.data.items);
      // 默认全勾：都进了收件箱，多半是要一起看的
      setChecked(inbox.data.items.map((x) => x.id));
      setStoreIds(inbox.data.lastStoreIds ?? []);
      setHint(inbox.data.lastExtraHint ?? '');
    }
    if (ks.success && ks.data) setStores(ks.data);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const { phase, start, abort } = useSseStream({
    url: ACTIVE_TASK_ABSORB_STREAM,
    method: 'POST',
    onEvent: {
      model: (d) => {
        const m = d as { model?: string; platform?: string };
        if (m?.model) setModel(`${m.model}${m.platform ? ` · ${m.platform}` : ''}`);
      },
      task: (d) => {
        const t = d as DraftTask;
        if (!t?.title) return;
        seq.current += 1;
        setRows((prev) => [...prev, { ...t, key: `s${seq.current}`, picked: true }]);
      },
      summary: (d) => setSkipped((d as { skipped?: string })?.skipped ?? null),
    },
    onError: (m) => toast.error(m || '吸取失败'),
  });

  const streaming = phase === 'connecting' || phase === 'streaming';
  const hasDrafts = rows.length > 0;
  const picked = rows.filter((r) => r.picked && r.title.trim());

  const onAbsorb = useCallback(() => {
    if (checked.length === 0) { toast.error('先勾几条'); return; }
    setRows([]);
    setSkipped(null);
    seq.current = 0;
    void start({ body: { suggestionIds: checked, storeIds, extraHint: hint.trim() || null } });
  }, [checked, storeIds, hint, start]);

  const onConfirm = useCallback(async () => {
    // 按钮已经禁用了，这里是第二道 —— 禁用状态被别的改动碰掉时不至于直接丢数据
    if (streaming) return;
    if (!hasDrafts) { onAbsorb(); return; }
    if (picked.length === 0) { onAbsorb(); return; }
    setBusy(true);
    // 已建成的 id 跨重试累积（doneIds 存在组件上）：第一次建成了 A、B 留待重试，
    // 第二次只会产出 B。若只拿这一趟的结果去 markSuggestionsAbsorbed，
    // A 与这些建议的来源链接就永久断了。
    const created: string[] = [...doneIds.current];
    const failed: typeof picked = [];

    // 只重建**还没建成的**那几条。上一趟建成的行 key 记在 builtKeys 里 ——
    // 少了这一步，「任务全建成了但标记已吸取失败」之后再点一次确认，
    // 会把已经进队列的那几条原样再建一遍（重复任务），然后才去重试标记。
    const todo = picked.filter((r) => !builtKeys.current.has(r.key));
    for (const r of todo) {
      const res = await createActiveTask({ title: r.title.trim(), dueAt: r.dueAt ?? null });
      if (res.success && res.data) { created.push(res.data.id); builtKeys.current.add(r.key); }
      else failed.push(r);
    }
    doneIds.current = created;
    setBusy(false);

    // 有一条没建上就先别收摊：把没成的留在这张表上等重试。
    // 原来只看 created.length > 0 就把**全部**选中的建议标记成已吸取并关窗，
    // 于是没建上的那条连同它的来源建议一起消失 —— 用户既看不到失败，也找不回来源。
    if (failed.length > 0) {
      setRows((p) => p.map((r) => ({ ...r, picked: failed.some((f) => f.key === r.key) })));
      toast.error(created.length > 0
        ? `建上了 ${created.length} 件，还有 ${failed.length} 件没成，留在这儿了，可以再试一次`
        : '一条都没建上');
      if (created.length > 0) onCreated();
      return;
    }

    // 全都建上了才算吸取完：这几条建议就此了结，并记下它们长出了哪几条任务。
    // 这一步失败也不许报成功关窗 —— 任务已经进队列，建议却还挂在收件箱里，
    // 用户再吸取一次就会建出一模一样的重复任务。
    const marked = await markSuggestionsAbsorbed({ suggestionIds: checked, taskIds: created });
    if (!marked.success) {
      onCreated();
      toast.error(`${created.length} 件已经进队列了，但这几条建议没能标记成已吸取，留在这儿别重复吸`);
      return;
    }

    doneIds.current = [];
    builtKeys.current.clear();
    toast.success(`吸取了 ${created.length} 件`);
    onCreated();
    onClose();
  }, [streaming, hasDrafts, picked, checked, onAbsorb, onCreated, onClose]);

  const onDismiss = useCallback(async (id: string) => {
    setBusy(true);
    const res = await dismissSuggestion(id);
    setBusy(false);
    if (res.success) {
      setItems((p) => p.filter((x) => x.id !== id));
      setChecked((p) => p.filter((x) => x !== id));
    } else toast.error(res.error?.message ?? '放不下');
  }, []);

  /** 拿去涌现：这条建议当种子建一棵树，去那边派生 */
  const onEmerge = useCallback(async (s: TaskSuggestion) => {
    setBusy(true);
    const res = await createEmergenceTreeReal({
      title: s.text.slice(0, 24),
      seedContent: s.text,
      seedSourceType: 'active-task-suggestion',
      seedSourceId: s.id,
    });
    setBusy(false);
    if (res.success && res.data?.tree?.id) {
      await linkSuggestionEmergence(s.id, res.data.tree.id);
      onClose();
      nav(`/emergence/${res.data.tree.id}`);
    } else {
      toast.error(res.error?.message ?? '建不出涌现树');
    }
  }, [nav, onClose]);

  const confirmLabel = hasDrafts
    ? (picked.length > 0 ? `加 ${picked.length} 件` : '重吸')
    : '吸取';

  return (
    <TaskSheet
      title={hasDrafts ? '整理成了这些' : '别人的建议'}
      confirmLabel={confirmLabel}
      // 流还没完就不许确认：点下去只会把「已经到的那几条」建成任务，却把全部选中的建议
      // 都标记成已吸取、顺手 abort 掉剩下的流 —— 后面才生成的那几条从此找不回来，
      // 它们的来源建议也一并从收件箱消失。ImportSheet 那边同理。
      confirmDisabled={busy || loading || streaming || (!hasDrafts && checked.length === 0)}
      onConfirm={() => void onConfirm()}
      onClose={() => { abort(); onClose(); }}
    >
      {hasDrafts ? (
        <>
          {model && <span className="atb-sheet__hint">{model}</span>}
          <DraftTaskList
            rows={rows}
            streaming={streaming}
            onToggle={(k) => setRows((p) => p.map((r) => (r.key === k ? { ...r, picked: !r.picked } : r)))}
            onRename={(k, title) => setRows((p) => p.map((r) => (r.key === k ? { ...r, title } : r)))}
          />
          {skipped && <span className="atb-sheet__hint">没转成任务的：{skipped}</span>}
          <button className="atb-link atb-link--quiet" style={{ alignSelf: 'flex-start' }} onClick={() => { setRows([]); setSkipped(null); }}>
            回去重选
          </button>
        </>
      ) : (
        <>
          {!loading && items.length === 0 && <div className="atb-empty">没有建议</div>}

          {items.length > 0 && (
            <div className="atb-list" role="list">
              {items.map((s) => {
                const on = checked.includes(s.id);
                return (
                  <div className={`atb-row atb-draft${on ? '' : ' atb-draft--off'}`} role="listitem" key={s.id}>
                    <button
                      className={`atb-check-circle${on ? ' atb-check-circle--on' : ''}`}
                      aria-pressed={on}
                      aria-label={on ? `不吸这条：${s.text.slice(0, 20)}` : `吸这条：${s.text.slice(0, 20)}`}
                      onClick={() => setChecked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                    >
                      {on && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                      )}
                    </button>
                    <div className="atb-row__body">
                      <span className="atb-suggest__text">{s.text}</span>
                      <span className="atb-row__sub">
                        <span className="atb-tag">{s.fromUserName ?? '某人'}</span>
                        {whenLabel(s.createdAt)}
                      </span>
                    </div>
                    <div className="atb-rowact">
                      <button className="atb-link" disabled={busy} title="拿这条去涌现，派生更多可能" onClick={() => void onEmerge(s)}>
                        <Sparkles size={15} aria-hidden="true" />
                        <span className="sr-only">拿去涌现</span>
                      </button>
                      <button className="atb-link atb-link--quiet" disabled={busy} onClick={() => void onDismiss(s.id)}>
                        放下
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {items.length > 0 && (
            <>
              <div className="atb-field">
                <span className="atb-field__label">顺带参考</span>
                <div className="atb-chips">
                  {stores.length === 0 && <span className="atb-sheet__hint">还没有知识库</span>}
                  {stores.map((k) => {
                    const on = storeIds.includes(k.id);
                    return (
                      <button
                        key={k.id}
                        type="button"
                        className={`atb-chip${on ? ' atb-chip--on' : ''}`}
                        aria-pressed={on}
                        onClick={() => setStoreIds((p) => (on ? p.filter((x) => x !== k.id) : [...p, k.id]))}
                      >
                        {k.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <input
                className="atb-input"
                placeholder="还有什么要求？（可不填，例如：都拆成半天能做完的）"
                aria-label="额外要求"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
              />

              {streaming && <span className="atb-sheet__hint">正在整理{model ? ` · ${model}` : ''}</span>}
            </>
          )}
        </>
      )}
    </TaskSheet>
  );
}

export default SuggestionsSheet;
